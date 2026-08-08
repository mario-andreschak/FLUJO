import { createLogger } from '@/utils/logger';
import { loadCollectionItem, listCollectionItems } from '@/utils/storage/backend';
import type { StorageKey } from '@/shared/types/storage';
import type { ModelMediaPart } from '@/shared/types/model/media';
import { FlowExecutor } from './FlowExecutor';
import { persistConversationState } from './persistConversationState';
import { reconcileInterruptedRecovery } from './recoveryCheckpoint';
import type {
  FlowInvocationSource,
  SharedState,
  SubflowInvocation,
  SubflowInvocationLane,
  SubflowInvocationLaneStatus,
} from './types';
import { bindToCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/execution/flow/subflowRecovery');

declare global {
  var __flujo_subflow_parent_resume_leases: Set<string> | undefined;
}

function resumeLeases(): Set<string> {
  if (!global.__flujo_subflow_parent_resume_leases) {
    global.__flujo_subflow_parent_resume_leases = new Set<string>();
  }
  return global.__flujo_subflow_parent_resume_leases;
}

export interface SubflowRunOutcome {
  status: string;
  conversationId: string;
  outputText: string;
  outputMedia?: ModelMediaPart[];
  error?: { message: string };
  sharedState: SharedState;
}

export interface SubflowRecoveryOptions {
  conversationId: string;
  parentConversationId?: string;
  invocationId?: string;
  laneId?: string;
  hasRecoverableFamily: boolean;
  incompleteSiblingCount: number;
  deepestFailedCount: number;
  canRetryBranch: boolean;
  canRetrySiblings: boolean;
  canRetryDeepest: boolean;
}

export type SubflowRecoveryScope = 'branch' | 'siblings' | 'deepest';

export interface SubflowRecoveryResult {
  scope: SubflowRecoveryScope;
  startedConversationIds: string[];
  completedConversationIds: string[];
  failed: Array<{ conversationId: string; error: string }>;
}

function storageKey(conversationId: string): StorageKey {
  return `conversations/${conversationId}` as StorageKey;
}

export async function loadConversationState(conversationId: string): Promise<SharedState | undefined> {
  const live = FlowExecutor.conversationStates.get(conversationId);
  if (live) return live;
  const stored = await loadCollectionItem<SharedState | undefined>('conversations', conversationId, undefined);
  if (stored) FlowExecutor.conversationStates.set(conversationId, stored);
  return stored;
}

export async function persistSubflowParent(state: SharedState): Promise<void> {
  if (!state.conversationId || state.ephemeral) return;
  FlowExecutor.conversationStates.set(state.conversationId, state);
  state.updatedAt = Date.now();
  await persistConversationState(storageKey(state.conversationId), state);
}

/** Derive the same callable output shape runFlow returns from a persisted child.
 *  Used to heal the small crash window where the child reached completed but the
 *  parent lane record was not updated yet. */
export function completedOutputFromState(state: SharedState): {
  outputText: string;
  outputMedia?: ModelMediaPart[];
} {
  let outputText = typeof state.lastResponse === 'string' ? state.lastResponse : '';
  if (!outputText) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i];
      if (message.role === 'assistant' && typeof message.content === 'string') {
        outputText = message.content;
        break;
      }
    }
  }
  let outputMedia: ModelMediaPart[] | undefined;
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const message = state.messages[i];
    if (message.role === 'assistant' && message.media?.length) {
      outputMedia = message.media;
      break;
    }
  }
  return { outputText, ...(outputMedia ? { outputMedia } : {}) };
}

export async function syncLaneFromPersistedChild(lane: SubflowInvocationLane): Promise<boolean> {
  const child = await loadConversationState(lane.conversationId);
  if (!child || (child.status !== 'completed' && child.status !== 'capped')) return false;
  const output = completedOutputFromState(child);
  lane.status = 'completed';
  lane.outputText = output.outputText;
  lane.outputMedia = output.outputMedia;
  lane.error = undefined;
  lane.updatedAt = Date.now();
  return true;
}

function laneStatusForOutcome(result: SubflowRunOutcome): SubflowInvocationLaneStatus {
  if (result.status === 'completed' || result.status === 'capped') return 'completed';
  if (
    result.sharedState.isCancelled ||
    result.sharedState.recovery?.classification === 'cancelled'
  ) {
    return 'cancelled';
  }
  return 'error';
}

function applyOutcome(lane: SubflowInvocationLane, result: SubflowRunOutcome): void {
  const status = laneStatusForOutcome(result);
  lane.status = status;
  lane.updatedAt = Date.now();
  if (status === 'completed') {
    lane.outputText = result.outputText;
    lane.outputMedia = result.outputMedia;
    lane.error = undefined;
  } else {
    lane.outputText = undefined;
    lane.outputMedia = undefined;
    lane.error = result.error?.message || 'Subflow execution failed';
  }
}

function invocationReady(invocation: SubflowInvocation): boolean {
  return invocation.lanes.length > 0 && invocation.lanes.every((lane) => lane.status === 'completed');
}

function findInvocation(
  parent: SharedState,
  invocationId: string,
): SubflowInvocation | undefined {
  return parent.subflowInvocations?.[invocationId];
}

async function resumeReadyParent(parent: SharedState, invocation: SubflowInvocation): Promise<void> {
  const parentId = parent.conversationId;
  if (!parentId || parent.ephemeral || parent.isCancelled) return;
  if (parent.status !== 'error' || parent.currentNodeId !== invocation.parentNodeId) return;
  if (parent.activeSubflowInvocationByNode?.[invocation.parentNodeId] !== invocation.id) return;

  const leases = resumeLeases();
  const leaseKey = workspaceCacheKey(invocation.id);
  if (leases.has(leaseKey)) return;
  leases.add(leaseKey);
  invocation.status = 'ready';
  invocation.resumeRequestedAt = Date.now();
  invocation.updatedAt = Date.now();
  await persistSubflowParent(parent);

  try {
    const { runFlow } = await import('./runFlow');
    const source: FlowInvocationSource = parent.source ?? (parent.parentRunId ? 'subflow' : 'chat');
    log.info('Resuming parent after recovered subflow join became ready', {
      parentConversationId: parentId,
      invocationId: invocation.id,
      nodeId: invocation.parentNodeId,
    });
    const result = await runFlow({
      conversationId: parentId,
      mode: 'conversation',
      source,
      flujo: true,
      requireApproval: parent.requireApproval ?? false,
      debug: parent.debugMode ?? false,
      userTurn: false,
      depth: parent.runDepth,
      chainDepth: parent.chainDepth,
      onApprovalRequired: parent.onApprovalRequired,
    });
    // Awaiting this propagation makes nested recovery deterministic. runFlow's
    // background notification is intentionally redundant and idempotent.
    await reportSubflowRunOutcome(result);
  } catch (error) {
    log.error('Automatic parent continuation after subflow recovery failed', {
      parentConversationId: parentId,
      invocationId: invocation.id,
      error,
    });
  } finally {
    leases.delete(leaseKey);
  }
}

/** Update the exact parent lane owned by a child terminal run and, when every
 * required lane is now complete, continue the parked parent from its Subflow
 * node. Safe to call more than once for the same result. */
export async function reportSubflowRunOutcome(result: SubflowRunOutcome): Promise<void> {
  const child = result.sharedState;
  const laneRef = child.subflowLane ?? child.recovery?.lane;
  const parentId = child.parentRunId ?? child.parentConversationId;
  if (!parentId || !laneRef?.invocationId || !laneRef.laneId) return;

  const parent = await loadConversationState(parentId);
  if (!parent) return;
  const invocation = findInvocation(parent, laneRef.invocationId);
  if (!invocation || invocation.status === 'folded') return;
  const lane = invocation.lanes.find((candidate) => candidate.id === laneRef.laneId);
  if (!lane || lane.conversationId !== result.conversationId) return;

  applyOutcome(lane, result);
  invocation.updatedAt = Date.now();
  if (invocationReady(invocation)) invocation.status = 'ready';
  await persistSubflowParent(parent);

  if (invocation.status === 'ready') {
    await resumeReadyParent(parent, invocation);
  }
}

/** Do not lengthen the child HTTP request just to run its ancestors. The
 * durable lane update/resume starts on the next microtask and is also healed by
 * syncLaneFromPersistedChild if the process stops in between. */
export function queueSubflowRunOutcome(result: SubflowRunOutcome): void {
  if (result.status !== 'completed' && result.status !== 'capped' && result.status !== 'error') return;
  queueMicrotask(bindToCurrentWorkspace(() => {
    void reportSubflowRunOutcome(result).catch((error) => {
      log.error('Could not propagate subflow terminal outcome to its parent', {
        conversationId: result.conversationId,
        error,
      });
    });
  }));
}

function isFailedState(state: SharedState): boolean {
  return state.status === 'error' ||
    state.recovery?.classification === 'cancelled' ||
    state.recovery?.classification === 'interrupted' ||
    state.recovery?.classification === 'retryable_failure' ||
    state.recovery?.classification === 'permanent_failure';
}

function activeInvocationForChild(
  state: SharedState,
  byId: Map<string, SharedState>,
): { parent: SharedState; invocation: SubflowInvocation; lane: SubflowInvocationLane } | undefined {
  const laneRef = state.subflowLane ?? state.recovery?.lane;
  const parentId = state.parentRunId ?? state.parentConversationId;
  if (!parentId || !laneRef?.invocationId || !laneRef.laneId || !state.conversationId) return undefined;
  const parent = byId.get(parentId);
  const invocation = parent?.subflowInvocations?.[laneRef.invocationId];
  if (!parent || !invocation || invocation.status === 'folded') return undefined;
  if (parent.activeSubflowInvocationByNode?.[invocation.parentNodeId] !== invocation.id) return undefined;
  const lane = invocation.lanes.find((candidate) =>
    candidate.id === laneRef.laneId && candidate.conversationId === state.conversationId,
  );
  if (!lane || lane.status === 'completed') return undefined;
  return { parent, invocation, lane };
}

function activeInvocationOwnedBy(state: SharedState): SubflowInvocation | undefined {
  const activeIds = Object.values(state.activeSubflowInvocationByNode ?? {});
  return activeIds
    .map((id) => state.subflowInvocations?.[id])
    .find((invocation): invocation is SubflowInvocation => !!invocation && invocation.status !== 'folded');
}

async function allConversationStates(): Promise<SharedState[]> {
  const stored = await listCollectionItems<SharedState>('conversations');
  const byId = new Map<string, SharedState>();
  for (const state of stored) {
    if (!state.conversationId) continue;
    // A direct recovery API call may be the first request after process restart,
    // before the sidebar/list route has reconciled abandoned `running` records.
    // Never reconcile a currently resident state: it may genuinely be running.
    if (!FlowExecutor.conversationStates.has(state.conversationId)) {
      await reconcileInterruptedRecovery(storageKey(state.conversationId), state);
    }
    byId.set(state.conversationId, state);
  }
  for (const [id, state] of FlowExecutor.conversationStates) byId.set(id, state);
  return Array.from(byId.values());
}

function deepestFailedStates(states: SharedState[], rootId: string): SharedState[] {
  const byId = new Map(states.flatMap((state) =>
    state.conversationId ? [[state.conversationId, state] as const] : [],
  ));
  const family = states.filter((state) =>
    state.conversationId === rootId || state.rootConversationId === rootId,
  );
  const failed = family.filter((state) => {
    if (!state.conversationId || !isFailedState(state)) return false;
    if (state.conversationId === rootId) return true;
    const laneRef = state.subflowLane ?? state.recovery?.lane;
    // New durable children are recoverable as family leaves only while their
    // exact parent join is still active. This excludes historical failed lanes
    // from a collect-all invocation that the parent already folded and left.
    if (laneRef?.invocationId || laneRef?.laneId) {
      const active = activeInvocationForChild(state, byId);
      return !!active && active.parent.status !== 'running';
    }
    // Legacy children did not carry durable invocation ids. Keep their existing
    // branch-level recovery behavior rather than hiding them after upgrade.
    const parentId = state.parentRunId ?? state.parentConversationId;
    return !parentId || byId.get(parentId)?.status !== 'running';
  });
  const failedIds = new Set(failed.map((state) => state.conversationId!));
  const children = new Map<string, string[]>();
  for (const state of family) {
    if (!state.parentConversationId || !state.conversationId) continue;
    const list = children.get(state.parentConversationId) ?? [];
    list.push(state.conversationId);
    children.set(state.parentConversationId, list);
  }
  const hasFailedDescendant = (id: string): boolean => {
    const stack = [...(children.get(id) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const childId = stack.pop()!;
      if (seen.has(childId)) continue;
      seen.add(childId);
      if (failedIds.has(childId)) return true;
      stack.push(...(children.get(childId) ?? []));
    }
    return false;
  };
  return failed.filter((state) => !hasFailedDescendant(state.conversationId!));
}

export async function getSubflowRecoveryOptions(conversationId: string): Promise<SubflowRecoveryOptions> {
  const states = await allConversationStates();
  const byId = new Map(states.flatMap((state) =>
    state.conversationId ? [[state.conversationId, state] as const] : [],
  ));
  const current = states.find((state) => state.conversationId === conversationId);
  const laneRef = current?.subflowLane ?? current?.recovery?.lane;
  const parentId = current?.parentRunId ?? current?.parentConversationId;
  const active = current ? activeInvocationForChild(current, byId) : undefined;
  const ownedInvocation = current ? activeInvocationOwnedBy(current) : undefined;
  const incompleteSiblingCount = active
    ? active.invocation.lanes.filter((lane) => lane.status !== 'completed').length
    : ownedInvocation
      ? ownedInvocation.lanes.filter((lane) => lane.status !== 'completed').length
    : 0;
  const rootId = current?.rootConversationId ?? current?.conversationId ?? conversationId;
  const deepest = deepestFailedStates(states, rootId);
  const hasFailedDescendant = deepest.some((state) => state.conversationId !== conversationId);
  return {
    conversationId,
    ...(parentId ? { parentConversationId: parentId } : {}),
    ...(laneRef?.invocationId ? { invocationId: laneRef.invocationId } : {}),
    ...(laneRef?.laneId ? { laneId: laneRef.laneId } : {}),
    hasRecoverableFamily: !!active || !!ownedInvocation || hasFailedDescendant,
    incompleteSiblingCount,
    deepestFailedCount: deepest.length,
    canRetryBranch: !!current && current.status !== 'running',
    canRetrySiblings: !!active && incompleteSiblingCount > 0 && active.parent.status !== 'running',
    canRetryDeepest: deepest.length > 0,
  };
}

async function runRecoveryConversation(state: SharedState): Promise<SubflowRunOutcome> {
  if (!state.conversationId) throw new Error('Conversation has no id.');
  const leaseKey = `conversation:${state.conversationId}`;
  const leases = resumeLeases();
  if (leases.has(leaseKey)) throw new Error('Conversation is already running.');
  leases.add(leaseKey);
  try {
    // Re-read after taking the lease so two recovery requests cannot both act
    // on the stale error snapshot returned by the family scan.
    const current = await loadConversationState(state.conversationId) ?? state;
    if (current.status === 'running') throw new Error('Conversation is already running.');
    if (current.recovery?.manualActionRequired) {
      throw new Error(current.recovery.sideEffectWarning || 'Manual review is required before this conversation can be retried.');
    }
    const { runFlow } = await import('./runFlow');
    const source: FlowInvocationSource = current.source ?? (current.parentRunId ? 'subflow' : 'chat');
    return await runFlow({
      conversationId: current.conversationId!,
      mode: 'conversation',
      source,
      flujo: true,
      requireApproval: current.requireApproval ?? false,
      debug: current.debugMode ?? false,
      userTurn: false,
      depth: current.runDepth,
      chainDepth: current.chainDepth,
      onApprovalRequired: current.onApprovalRequired,
    });
  } finally {
    leases.delete(leaseKey);
  }
}

export async function retrySubflowRecoveryScope(
  conversationId: string,
  scope: SubflowRecoveryScope,
): Promise<SubflowRecoveryResult> {
  const states = await allConversationStates();
  const current = states.find((state) => state.conversationId === conversationId);
  if (!current) throw new Error('Conversation not found.');

  let targets: SharedState[] = [];
  if (scope === 'branch') {
    targets = [current];
  } else if (scope === 'siblings') {
    const active = activeInvocationForChild(
      current,
      new Map(states.flatMap((state) =>
        state.conversationId ? [[state.conversationId, state] as const] : [],
      )),
    );
    if (!active || active.parent.status === 'running') {
      throw new Error('No recoverable sibling invocation was found.');
    }
    // Re-entering the parent Subflow node is what retries every incomplete lane
    // through its original bounded queue while reusing successful lane outputs.
    targets = [active.parent];
  } else {
    const rootId = current.rootConversationId ?? current.conversationId!;
    targets = deepestFailedStates(states, rootId);
  }

  const result: SubflowRecoveryResult = {
    scope,
    startedConversationIds: [],
    completedConversationIds: [],
    failed: [],
  };
  for (const target of targets) {
    const id = target.conversationId;
    if (!id) continue;
    result.startedConversationIds.push(id);
    try {
      const outcome = await runRecoveryConversation(target);
      await reportSubflowRunOutcome(outcome);
      if (outcome.status === 'completed' || outcome.status === 'capped') {
        result.completedConversationIds.push(id);
      } else {
        result.failed.push({ conversationId: id, error: outcome.error?.message || 'Recovery run failed.' });
      }
    } catch (error) {
      result.failed.push({
        conversationId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
