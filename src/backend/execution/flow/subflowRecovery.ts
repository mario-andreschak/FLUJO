import { createLogger } from '@/utils/logger';
import { withConversationSnapshot } from '@/utils/storage/backend';
import { listConversationSummaries } from './conversationSummaryStore';
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
import { isPersonaOwnedConversationState } from './personaConversationOwnership';
import { latestSubflowAssistantText, type SubflowOutputBudget } from './subflowOutputBudget';

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
  return withConversationSnapshot<SharedState, SharedState | undefined>(conversationId, async stored => {
    if (stored) FlowExecutor.conversationStates.set(conversationId, stored);
    return stored;
  });
}

export async function persistSubflowParent(state: SharedState, options?: { publishLive?: boolean }): Promise<void> {
  if (!state.conversationId || state.ephemeral) return;
  if (options?.publishLive !== false) FlowExecutor.conversationStates.set(state.conversationId, state);
  state.updatedAt = Date.now();
  await persistConversationState(storageKey(state.conversationId), state);
}

/** Read the actual durable commit, bypassing the live-state cache after an
 * ambiguous write (e.g. snapshot committed but summary publication failed). */
export async function readPersistedSubflowParent(conversationId: string): Promise<SharedState | undefined> {
  return withConversationSnapshot<SharedState, SharedState | undefined>(conversationId, async stored => stored);
}

/** Call only when currentNodeId/status advance in the same state publication. */
export function acknowledgeSubflowContinuation(state: SharedState, nodeId: string | undefined): boolean {
  if (!nodeId) return false;
  const id = state.activeSubflowInvocationByNode?.[nodeId];
  const invocation = id ? state.subflowInvocations?.[id] : undefined;
  if (!invocation?.foldReceipt || !invocation.foldedAt) return false;
  invocation.foldReceipt.continuedAt = Date.now();
  delete state.activeSubflowInvocationByNode?.[nodeId];
  return true;
}

/** Derive the same callable output shape runFlow returns from a persisted child.
 *  Used to heal the small crash window where the child reached completed but the
 *  parent lane record was not updated yet. */
export function completedOutputFromState(state: SharedState, outputBudget?: SubflowOutputBudget): {
  outputText: string;
  outputMedia?: ModelMediaPart[];
} {
  let outputText = typeof state.lastResponse === 'string' ? state.lastResponse : '';
  if (!outputText && !outputBudget) {
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
  if (outputBudget && !outputText.trim() && !outputMedia?.length) outputText = latestSubflowAssistantText(state.messages, outputBudget);
  return { outputText, ...(outputMedia ? { outputMedia } : {}) };
}

export async function syncLaneFromPersistedChild(lane: SubflowInvocationLane, outputBudget?: SubflowOutputBudget): Promise<boolean> {
  const child = await loadConversationState(lane.conversationId);
  if (!child || (child.status !== 'completed' && child.status !== 'capped')) return false;
  const output = completedOutputFromState(child, outputBudget);
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
  const source: FlowInvocationSource = parent.source ?? (parent.parentRunId ? 'subflow' : 'chat');
  if (source === 'meeting') {
    log.warn('Refusing to resume a meeting participant outside MeetingEngine', {
      parentConversationId: parentId,
      invocationId: invocation.id,
    });
    return;
  }
  if (isPersonaOwnedConversationState(parent)) {
    log.warn('Refusing to resume a Persona-owned parent outside its dispatcher', {
      parentConversationId: parentId,
      invocationId: invocation.id,
      ...(parent.personaAttribution
        ? { personaId: parent.personaAttribution.personaId }
        : { archived: true }),
    });
    return;
  }

  const leases = resumeLeases();
  const leaseKey = workspaceCacheKey(invocation.id);
  if (leases.has(leaseKey)) return;
  leases.add(leaseKey);
  try {
    invocation.status = 'ready';
    invocation.resumeRequestedAt = Date.now();
    invocation.updatedAt = Date.now();
    await persistSubflowParent(parent);

    try {
      const { runFlow } = await import('./runFlow');
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
    }
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

type RecoveryInvocation = Pick<SubflowInvocation, 'id' | 'parentNodeId' | 'status'> & {
  continuationPending?: boolean;
  lanes: Array<Pick<SubflowInvocationLane, 'id' | 'conversationId' | 'status'>>;
};
type RecoveryConversation = Pick<SharedState,
  'conversationId' | 'status' | 'source' | 'parentRunId' | 'parentConversationId' | 'rootConversationId' | 'subflowLane'
> & {
  recovery?: Pick<NonNullable<SharedState['recovery']>, 'classification' | 'lane'>;
  subflowInvocations?: Record<string, RecoveryInvocation>;
  activeSubflowInvocationByNode?: SharedState['activeSubflowInvocationByNode'];
  personaOwned: boolean;
};

/** Recovery decisions need identities and lane status, never transcripts or lane outputs. */
function recoveryProjection(state: SharedState): RecoveryConversation {
  return {
    conversationId: state.conversationId, status: state.status, source: state.source,
    parentRunId: state.parentRunId, parentConversationId: state.parentConversationId,
    rootConversationId: state.rootConversationId, subflowLane: state.subflowLane,
    recovery: state.recovery ? { classification: state.recovery.classification, lane: state.recovery.lane } : undefined,
    personaOwned: isPersonaOwnedConversationState(state),
    activeSubflowInvocationByNode: state.activeSubflowInvocationByNode,
    subflowInvocations: state.subflowInvocations && Object.fromEntries(Object.entries(state.subflowInvocations).map(([id, invocation]) => [id, {
      id: invocation.id, parentNodeId: invocation.parentNodeId, status: invocation.status,
      continuationPending: Boolean(invocation.foldReceipt && !invocation.foldReceipt.continuedAt),
      lanes: invocation.lanes.map(lane => ({ id: lane.id, conversationId: lane.conversationId, status: lane.status })),
    }])),
  };
}

function isFailedState(state: RecoveryConversation): boolean {
  return state.status === 'error' ||
    state.recovery?.classification === 'cancelled' ||
    state.recovery?.classification === 'interrupted' ||
    state.recovery?.classification === 'retryable_failure' ||
    state.recovery?.classification === 'permanent_failure';
}

function activeInvocationForChild(
  state: RecoveryConversation,
  byId: Map<string, RecoveryConversation>,
): { parent: RecoveryConversation; invocation: RecoveryInvocation; lane: RecoveryInvocation['lanes'][number] } | undefined {
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

function activeInvocationOwnedBy(state: RecoveryConversation): RecoveryInvocation | undefined {
  const activeIds = Object.values(state.activeSubflowInvocationByNode ?? {});
  return activeIds
    .map((id) => state.subflowInvocations?.[id])
    .find((invocation): invocation is RecoveryInvocation => !!invocation && (invocation.status !== 'folded' || !!invocation.continuationPending));
}

async function familyConversationStates(conversationId: string, signal?: AbortSignal): Promise<RecoveryConversation[]> {
  signal?.throwIfAborted();
  const byId = new Map<string, RecoveryConversation>();
  const read = async (id: string) => {
    signal?.throwIfAborted();
    if (byId.has(id)) return byId.get(id);
    const live = FlowExecutor.conversationStates.get(id);
    const projected = live ? recoveryProjection(live) : await withConversationSnapshot<SharedState, RecoveryConversation | undefined>(id, async state => {
      signal?.throwIfAborted();
      if (!state) return undefined;
      await reconcileInterruptedRecovery(storageKey(id), state);
      signal?.throwIfAborted();
      return recoveryProjection(state);
    }, { signal });
    if (projected) byId.set(id, projected);
    return projected;
  };
  const current = await read(conversationId);
  if (!current) return [];
  const summaries = await listConversationSummaries();
  signal?.throwIfAborted();
  const rootId = current.rootConversationId ?? conversationId;
  const wanted = new Set([conversationId, rootId]);
  if (current.parentRunId ?? current.parentConversationId) wanted.add((current.parentRunId ?? current.parentConversationId)!);
  // Discover family identities from compact sidecars, including legacy parent links.
  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) {
      if (wanted.has(summary.id) || summary.rootConversationId === rootId || (summary.parentConversationId && wanted.has(summary.parentConversationId))) {
        for (const id of [summary.id, summary.parentConversationId, summary.rootConversationId]) {
          if (id && !wanted.has(id)) { wanted.add(id); changed = true; }
        }
      }
    }
  }
  for (const [id, state] of FlowExecutor.conversationStates) {
    if (state.rootConversationId === rootId || state.parentConversationId === conversationId) wanted.add(id);
  }
  // Materialize one admitted snapshot at a time and retain only its small projection.
  // Active lane identities also cover children not yet visible in a persisted sidecar.
  for (const id of wanted) {
    const state = await read(id);
    if (!state) continue;
    if (state.parentRunId ?? state.parentConversationId) wanted.add((state.parentRunId ?? state.parentConversationId)!);
    for (const invocation of Object.values(state.subflowInvocations ?? {})) {
      if (invocation.status !== 'folded') for (const lane of invocation.lanes) wanted.add(lane.conversationId);
    }
  }
  return Array.from(byId.values());
}

function deepestFailedStates(states: RecoveryConversation[], rootId: string): RecoveryConversation[] {
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

function belongsToMeetingFamily(
  state: RecoveryConversation | undefined,
  byId: Map<string, RecoveryConversation>,
): boolean {
  if (!state) return false;
  if (state.source === 'meeting') return true;
  const rootId = state.rootConversationId ?? state.conversationId;
  return Boolean(rootId && byId.get(rootId)?.source === 'meeting');
}

export async function getSubflowRecoveryOptions(conversationId: string, signal?: AbortSignal): Promise<SubflowRecoveryOptions> {
  const states = await familyConversationStates(conversationId, signal);
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
    : ownedInvocation && ownedInvocation.status !== 'folded'
      ? ownedInvocation.lanes.filter((lane) => lane.status !== 'completed').length
    : 0;
  const rootId = current?.rootConversationId ?? current?.conversationId ?? conversationId;
  const deepest = deepestFailedStates(states, rootId);
  const hasFailedDescendant = deepest.some((state) => state.conversationId !== conversationId);
  const meetingOwned = belongsToMeetingFamily(current, byId);
  const personaOwned = isPersonaOwnedConversationState(current);
  return {
    conversationId,
    ...(parentId ? { parentConversationId: parentId } : {}),
    ...(laneRef?.invocationId ? { invocationId: laneRef.invocationId } : {}),
    ...(laneRef?.laneId ? { laneId: laneRef.laneId } : {}),
    hasRecoverableFamily: !meetingOwned && !personaOwned && (!!active || !!ownedInvocation || hasFailedDescendant),
    incompleteSiblingCount,
    deepestFailedCount: deepest.length,
    canRetryBranch: !meetingOwned && !personaOwned && !!current && current.status !== 'running',
    canRetrySiblings: !meetingOwned && !personaOwned && !!active && incompleteSiblingCount > 0 && active.parent.status !== 'running',
    canRetryDeepest: !meetingOwned && !personaOwned && deepest.length > 0,
  };
}

async function runRecoveryConversation(state: RecoveryConversation): Promise<SubflowRunOutcome> {
  if (!state.conversationId) throw new Error('Conversation has no id.');
  const leaseKey = `conversation:${state.conversationId}`;
  const leases = resumeLeases();
  if (leases.has(leaseKey)) throw new Error('Conversation is already running.');
  leases.add(leaseKey);
  try {
    // Re-read after taking the lease so two recovery requests cannot both act
    // on the stale error snapshot returned by the family scan.
    const current = await loadConversationState(state.conversationId);
    if (!current) throw new Error('Conversation not found.');
    if (current.status === 'running') throw new Error('Conversation is already running.');
    if (current.source === 'meeting') {
      throw new Error('Meeting participant recovery must be coordinated by MeetingEngine.');
    }
    if (isPersonaOwnedConversationState(current)) {
      throw new Error('Persona-owned recovery must be coordinated by the Persona dispatcher.');
    }
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
  const states = await familyConversationStates(conversationId);
  const current = states.find((state) => state.conversationId === conversationId);
  if (!current) throw new Error('Conversation not found.');
  const byId = new Map(states.flatMap((state) =>
    state.conversationId ? [[state.conversationId, state] as const] : [],
  ));
  if (belongsToMeetingFamily(current, byId)) {
    throw new Error('Meeting participant recovery must be coordinated by MeetingEngine.');
  }
  if (isPersonaOwnedConversationState(current)) {
    throw new Error('Persona-owned recovery must be coordinated by the Persona dispatcher.');
  }

  let targets: RecoveryConversation[] = [];
  if (scope === 'branch') {
    targets = [current];
  } else if (scope === 'siblings') {
    const active = activeInvocationForChild(
      current,
      byId,
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
