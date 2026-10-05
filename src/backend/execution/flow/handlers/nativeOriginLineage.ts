import type { SharedState } from '../types';
import { MAX_SUBFLOW_DEPTH } from '../constants';
import { loadConversationStateReadOnly } from '../loadConversationState';
import { assertFlowExecutionCurrent } from '../executionAuthority';
import { getTask } from '@/backend/services/subflowTasks';
import { getDetachedInstallationId } from '@/backend/services/subflowTasks/ownership';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { assertSafeCollectionId, listCollectionItemEntriesStrict, loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { NativeInvocationReceipt } from './nativeToolJournal';
import { nativeInvocationStatus } from './nativeToolJournal';
import { assertNativeBrokerAuthority, nativeDigest, type NativeBrokerAuthority } from './nativeToolBroker';

/** A Controller-resolved root is installed by trusted runtime code, never by a model tool. */
export interface NativeLineageRootSelection {
  fleetRunId: string;
  workerId: string;
  goalId: string;
  workspace: string;
  rootConversationId: string;
  rootLogicalRunId: string;
  rootFlowId: string;
}

export type NativeLineageRootBinding = Readonly<NativeLineageRootSelection> & {
  readonly assertCurrent: () => Promise<void>;
};

const rootBindings = new WeakSet<object>();

/** The future gateway must resolve the private Registry run before creating this capability. */
export function createNativeLineageRootBinding(
  selection: NativeLineageRootSelection,
  assertCurrent: () => Promise<void>,
): NativeLineageRootBinding {
  if (typeof assertCurrent !== 'function' || Object.values(selection).some(value =>
    typeof value !== 'string' || !value.trim())) throw new Error('Incomplete native root selection.');
  const binding = Object.freeze({ ...selection, assertCurrent });
  rootBindings.add(binding);
  return binding;
}

export interface NativeLineageEdge {
  kind: 'detached-task' | 'attached-lane';
  receiptId: string;
  parentConversationId: string;
  parentLogicalRunId: string;
  parentNodeId: string;
  childConversationId: string;
  childLogicalRunId: string;
  childFlowId: string;
}

export interface NativeOriginLineageEvidence {
  version: 1;
  invocationId: string;
  fleetRunId: string;
  workerId: string;
  goalId: string;
  workspace: string;
  installationId: string;
  rootConversationId: string;
  rootLogicalRunId: string;
  rootFlowId: string;
  originConversationId: string;
  originLogicalRunId: string;
  originNodeId: string;
  edges: NativeLineageEdge[];
  digest: string;
}

export class NativeLineageHeldError extends Error {
  constructor() {
    super('Native origin lineage is unavailable or no longer current.');
    this.name = 'NativeLineageHeldError';
  }
}

const held = (): never => { throw new NativeLineageHeldError(); };
const requireId = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return held();
  try { assertSafeCollectionId(value); } catch { return held(); }
  return value;
};

type StateSnapshot = Pick<SharedState,
  'conversationId' | 'logicalRunId' | 'flowId' | 'source' | 'status' | 'isCancelled' |
  'parentRunId' | 'parentConversationId' | 'parentLogicalRunId' | 'rootConversationId' |
  'currentNodeId' | 'runDepth' | 'subflowLane' | 'subflowInvocations' | 'recovery' | 'createdAt'>;

async function readState(id: string): Promise<StateSnapshot> {
  const safeId = requireId(id);
  const live = await loadConversationStateReadOnly(safeId);
  const state = await loadItemBackend<SharedState | undefined>(`conversations/${safeId}` as StorageKey, undefined);
  if (!live || !state || state.conversationId !== id || live.conversationId !== id
    || state.ephemeral || live.ephemeral || state.isCancelled || live.isCancelled
    || state.status === 'error' || live.status === 'error'
    || ['cancelled', 'interrupted'].includes(state.recovery?.classification ?? '')
    || ['cancelled', 'interrupted'].includes(live.recovery?.classification ?? '')
    || (live.executionExtensionOwned && !live.executionExtensionContext)) return held();
  live.executionAuthority?.signal.throwIfAborted();
  await assertFlowExecutionCurrent(live);
  // A live turn may be ahead of its disk snapshot. Hold until the two agree on
  // the identity being proved; saved lineage is mandatory, never inferred from
  // a public summary or an uncommitted memory-only state.
  for (const field of ['logicalRunId', 'flowId', 'source', 'parentRunId', 'parentConversationId',
    'parentLogicalRunId', 'rootConversationId', 'currentNodeId', 'runDepth'] as const) {
    if (live[field] !== state[field]) return held();
  }
  if (nativeDigest(live.subflowLane) !== nativeDigest(state.subflowLane)
    || nativeDigest(live.subflowInvocations) !== nativeDigest(state.subflowInvocations)) return held();
  return structuredClone({
    conversationId: state.conversationId, logicalRunId: state.logicalRunId,
    flowId: state.flowId, source: state.source, status: state.status,
    isCancelled: state.isCancelled, parentRunId: state.parentRunId,
    parentConversationId: state.parentConversationId, parentLogicalRunId: state.parentLogicalRunId,
    rootConversationId: state.rootConversationId, currentNodeId: state.currentNodeId,
    runDepth: state.runDepth, subflowLane: state.subflowLane,
    subflowInvocations: state.subflowInvocations, recovery: state.recovery,
    createdAt: state.createdAt,
  });
}

async function detachedEdge(child: StateSnapshot, parent: StateSnapshot, installationId: string): Promise<NativeLineageEdge> {
  // Strict scan fails if any saved task is unreadable. getTask then performs the
  // backend's own interruption reconciliation on the exact selected record.
  const entries = await listCollectionItemEntriesStrict<SubflowTaskRecord>('subflow-tasks');
  const matches = entries.filter(({ item }) => item.childConversationId === child.conversationId);
  if (matches.length !== 1) return held();
  const { id, item: saved } = matches[0];
  const task = await getTask(requireId(id));
  if (!task || task.taskId !== id || saved.taskId !== id || task.version !== 1
    || task.childConversationId !== child.conversationId
    || task.originConversationId !== parent.conversationId
    || task.originLogicalRunId !== parent.logicalRunId
    || task.flowId !== child.flowId || !task.originNodeId
    || task.status !== 'working' || task.cancelRequestedAt || task.interruption
    || task.launchOwner?.workspace !== getCurrentWorkspace()
    || task.launchOwner.installationId !== installationId
    || task.launchOwner.recoveryOwnerId !== child.recovery?.ownerId
    || !Number.isFinite(task.createdAt) || task.createdAt > (child.createdAt ?? 0)) return held();
  // A task status update may race this read; the immutable launch fields may not.
  if (saved.originConversationId !== task.originConversationId
    || saved.originLogicalRunId !== task.originLogicalRunId
    || saved.originNodeId !== task.originNodeId
    || saved.flowId !== task.flowId || saved.childConversationId !== task.childConversationId
    || saved.launchOwner?.installationId !== task.launchOwner.installationId) return held();
  return {
    kind: 'detached-task', receiptId: task.taskId,
    parentConversationId: parent.conversationId!, parentLogicalRunId: parent.logicalRunId!,
    parentNodeId: task.originNodeId, childConversationId: child.conversationId!,
    childLogicalRunId: child.logicalRunId!, childFlowId: child.flowId!,
  };
}

function attachedEdge(child: StateSnapshot, parent: StateSnapshot): NativeLineageEdge {
  const laneRef = child.subflowLane;
  if (!laneRef?.invocationId || !laneRef.laneId) return held();
  const invocation = parent.subflowInvocations?.[laneRef.invocationId];
  const lane = invocation?.lanes.find(item => item.id === laneRef.laneId);
  if (!invocation || invocation.version !== 1 || invocation.id !== laneRef.invocationId
    || invocation.status === 'folded' || invocation.parentConversationId !== parent.conversationId
    || invocation.parentRunId !== parent.conversationId
    || !invocation.parentNodeId || invocation.parentNodeId !== laneRef.parentNodeId
    || !lane || lane.conversationId !== child.conversationId || lane.subflowId !== child.flowId
    || !['pending', 'running'].includes(lane.status)
    || laneRef.conversationId !== child.conversationId
    || (lane.sessionVisit !== undefined && lane.sessionVisit !== laneRef.sessionVisit)) return held();
  return {
    kind: 'attached-lane', receiptId: `${invocation.id}:${lane.id}`,
    parentConversationId: parent.conversationId!, parentLogicalRunId: parent.logicalRunId!,
    parentNodeId: invocation.parentNodeId, childConversationId: child.conversationId!,
    childLogicalRunId: child.logicalRunId!, childFlowId: child.flowId!,
  };
}

/** Saved-record evidence for one already journaled native SDK invocation.
 * This is not an HTTP attestation or a fleet authorization decision. The future
 * gateway must authenticate its bearer and re-run this lookup for each operation. */
export async function readNativeOriginLineage(input: {
  receipt: NativeInvocationReceipt;
  authority: NativeBrokerAuthority;
  root: NativeLineageRootBinding;
}): Promise<NativeOriginLineageEvidence> {
  try {
    assertNativeBrokerAuthority(input.authority);
    if (!rootBindings.has(input.root)) return held();
    const { receipt, root, authority } = input;
    for (const value of [root.fleetRunId, root.workerId, root.goalId, root.rootConversationId,
      root.rootLogicalRunId, root.rootFlowId, receipt.owner.conversationId,
      receipt.owner.runId, receipt.owner.nodeId]) requireId(value);
    if (root.workspace !== getCurrentWorkspace()
      || receipt.owner.leaseEpoch !== authority.leaseEpoch) return held();
    const assertCurrent = async () => {
      await authority.assertCurrent();
      await root.assertCurrent();
    };
    const status = async () => {
      const current = await nativeInvocationStatus(receipt.invocationId, receipt.owner);
      if (current.state !== 'prepared' && current.state !== 'begin-may-have-been-sent') return held();
    };
    await assertCurrent();
    await status();
    const installationId = await getDetachedInstallationId();
    const trace = async (): Promise<Omit<NativeOriginLineageEvidence, 'digest'>> => {
      await assertCurrent();
      const edges: NativeLineageEdge[] = [];
      const seen = new Set<string>();
      let current = await readState(receipt.owner.conversationId);
      if (current.logicalRunId !== receipt.owner.runId
        || current.currentNodeId !== receipt.owner.nodeId || current.status !== 'running') return held();
      while (current.conversationId !== root.rootConversationId) {
        if (edges.length >= MAX_SUBFLOW_DEPTH || !current.conversationId
          || seen.has(current.conversationId) || current.source !== 'subflow'
          || current.rootConversationId !== root.rootConversationId
          || !current.logicalRunId || !current.flowId
          || !current.parentRunId || current.parentRunId !== current.parentConversationId
          || !current.parentLogicalRunId) return held();
        seen.add(current.conversationId);
        const parent = await readState(current.parentRunId);
        if (!parent.conversationId || seen.has(parent.conversationId)
          || parent.logicalRunId !== current.parentLogicalRunId
          || !parent.logicalRunId || !parent.flowId
          || current.runDepth !== (parent.runDepth ?? 0) + 1) return held();
        const edge = current.subflowLane?.invocationId
          ? attachedEdge(current, parent)
          : await detachedEdge(current, parent, installationId);
        edges.push(edge);
        current = parent;
        await assertCurrent();
      }
      if (seen.has(root.rootConversationId) || current.parentRunId || current.parentConversationId
        || (current.rootConversationId && current.rootConversationId !== root.rootConversationId)
        || current.source === 'subflow' || current.runDepth !== 0
        || current.logicalRunId !== root.rootLogicalRunId || current.flowId !== root.rootFlowId
        || !current.conversationId || !current.logicalRunId || !current.flowId) return held();
      await assertCurrent();
      return {
        version: 1, invocationId: receipt.invocationId,
        fleetRunId: root.fleetRunId, workerId: root.workerId, goalId: root.goalId,
        workspace: root.workspace, installationId,
        rootConversationId: root.rootConversationId, rootLogicalRunId: root.rootLogicalRunId,
        rootFlowId: root.rootFlowId,
        originConversationId: receipt.owner.conversationId,
        originLogicalRunId: receipt.owner.runId, originNodeId: receipt.owner.nodeId,
        edges: edges.reverse(),
      };
    };
    const first = await trace();
    const second = await trace();
    if (nativeDigest(first) !== nativeDigest(second)) return held();
    await assertCurrent();
    await status();
    return { ...second, digest: nativeDigest(second) };
  } catch {
    return held();
  }
}
