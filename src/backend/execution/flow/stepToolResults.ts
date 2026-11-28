// The tool result size limit of the AI step whose tools run, and where its moved results are kept (#1226).
import type { Flow } from '@/shared/types/flow/flow';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import { deleteRunResources, listRunResourceStoreIds } from '@/backend/services/runResources';
import { normalizeStepToolResultLimit, type StepToolResultLimit, type StepToolResults } from '@/shared/toolResultLimit';
import { workspaceCacheKey } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { MAX_SUBFLOW_DEPTH } from './constants';
import { getConversationStates } from './conversationStateRegistry';
import type { SharedState } from './types';

const log = createLogger('backend/execution/flow/stepToolResults');

/**
 * Store name of a run that saves nothing and has no saved conversation above
 * it (an agent an outside program calls as a tool, a trigger check, a Harness
 * experiment). The run's own id follows the prefix.
 */
export const UNSAVED_RUN_STORE_PREFIX = 'unsaved-';
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;

declare global {
  var __flujo_unsaved_run_stores: Set<string> | undefined;
}
const handedOut = () => global.__flujo_unsaved_run_stores ??= new Set<string>();

type StoreSource = Pick<SharedState, 'conversationId' | 'ephemeral' | 'parentConversationId' | 'parentRunId'>;
type FlowSource = { flowId?: string; flowSnapshot?: Flow };

/** The store a run that saves nothing keeps for itself, or undefined when its id cannot name one. */
function unsavedRunStore(conversationId: string | undefined): string | undefined {
  const store = conversationId ? `${UNSAVED_RUN_STORE_PREFIX}${conversationId}` : undefined;
  if (!store || !STORE_ID.test(store)) return undefined;
  handedOut().add(workspaceCacheKey('unsaved-run-store', store));
  return store;
}

/**
 * Where this run keeps moved tool results: its own conversation when it saves
 * one, else the nearest saved conversation above it (the chat that started the
 * subflow), else a store of its own that is removed when the run ends.
 */
export function toolResultStoreFor(
  state: StoreSource,
  states: ReadonlyMap<string, StoreSource> = getConversationStates(),
): string | undefined {
  if (!state.ephemeral) return state.conversationId || undefined;
  const visited = new Set<string>();
  let next = state.parentConversationId ?? state.parentRunId;
  // The chain is bounded by the subflow depth cap; +1 for the top run.
  for (let hops = 0; next && !visited.has(next) && hops <= MAX_SUBFLOW_DEPTH + 1; hops++) {
    visited.add(next);
    const parent = states.get(next);
    if (!parent) break;
    if (!parent.ephemeral && parent.conversationId) return parent.conversationId;
    next = parent.parentConversationId ?? parent.parentRunId;
  }
  return unsavedRunStore(state.conversationId);
}

/** An AI step's tool result handling from its saved properties and the run it belongs to. */
export function stepToolResultsFor(properties: { toolResultLimit?: unknown } | undefined, state: StoreSource): StepToolResults {
  const limit = normalizeStepToolResultLimit(properties?.toolResultLimit);
  const store = toolResultStoreFor(state);
  return { ...(limit ? { limit } : {}), ...(store ? { store } : {}) };
}

/**
 * The context window of the model an AI step uses and the step's own limit.
 * Both lookups are cached. Any gap (no node, a fallback policy without a
 * window, a removed model) leaves the window out, and the limit then assumes
 * a 128K-token window.
 */
export async function resolveNodeToolResultLimit(
  state: FlowSource,
  nodeId: string | undefined,
): Promise<{ contextWindow?: number; limit?: StepToolResultLimit }> {
  if (!nodeId) return {};
  try {
    const flow: Flow | null | undefined = state.flowSnapshot ?? (state.flowId ? await flowService.getFlow(state.flowId) : null);
    const properties = flow?.nodes.find(node => node.id === nodeId)?.data?.properties;
    const limit = normalizeStepToolResultLimit(properties?.toolResultLimit);
    const modelId = properties?.boundModel;
    const contextWindow = typeof modelId === 'string' && modelId
      ? (await modelService.getModel(modelId))?.contextWindow
      : undefined;
    return {
      ...(typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      ...(limit ? { limit } : {}),
    };
  } catch (error) {
    log.debug('Could not read the step for its tool result limit; using the workspace setting and 128K tokens', error);
    return {};
  }
}

/** Everything tool call processing needs for the size limit of the step whose calls run. */
export async function resolveStepToolResults(
  state: FlowSource & StoreSource & Pick<SharedState, 'currentNodeId'>,
): Promise<{ modelContextWindow?: number; toolResults: StepToolResults }> {
  const { contextWindow, limit } = await resolveNodeToolResultLimit(state, state.currentNodeId);
  const store = toolResultStoreFor(state);
  return {
    ...(contextWindow ? { modelContextWindow: contextWindow } : {}),
    toolResults: { ...(limit ? { limit } : {}), ...(store ? { store } : {}) },
  };
}

/** Remove the store a finished run that saved nothing kept for itself. Never throws. */
export async function releaseUnsavedRunStore(conversationId: string): Promise<void> {
  const store = `${UNSAVED_RUN_STORE_PREFIX}${conversationId}`;
  if (!handedOut().delete(workspaceCacheKey('unsaved-run-store', store))) return;
  try {
    await deleteRunResources(store);
  } catch (error) {
    log.warn(`Could not remove the tool result store of finished run ${conversationId}; the hourly sweep retries`, error);
  }
}

/**
 * Remove stores of runs that saved nothing and are no longer running (left
 * behind by a crash or a restart). Part of the hourly run resource sweep.
 */
export async function sweepUnsavedRunStores(): Promise<{ removed: number }> {
  const live = getConversationStates();
  let removed = 0;
  for (const store of await listRunResourceStoreIds(UNSAVED_RUN_STORE_PREFIX)) {
    if (live.has(store.slice(UNSAVED_RUN_STORE_PREFIX.length))) continue;
    handedOut().delete(workspaceCacheKey('unsaved-run-store', store));
    await deleteRunResources(store);
    removed += 1;
  }
  return { removed };
}
