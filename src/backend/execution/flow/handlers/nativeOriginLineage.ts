import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SharedState } from '../types';
import { MAX_SUBFLOW_DEPTH } from '../constants';
import { assertFlowExecutionCurrent } from '../executionAuthority';
import { getDetachedTaskLaunchOwner } from '@/backend/services/subflowTasks/ownership';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { assertSafeCollectionId, loadItem as loadItemBackend } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
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
  modelId: string;
  inputDigest: string;
  inventoryDigest: string;
  leaseEpoch: string;
  attemptOrdinal: number;
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
  'currentNodeId' | 'runDepth' | 'subflowLane' | 'subflowInvocations' | 'launchedTaskIds' |
  'recovery' | 'createdAt'>;

async function readState(id: string): Promise<StateSnapshot> {
  const safeId = requireId(id);
  const { loadConversationStateReadOnly } = await import('../loadConversationState');
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
    || nativeDigest(live.subflowInvocations) !== nativeDigest(state.subflowInvocations)
    || nativeDigest(live.launchedTaskIds) !== nativeDigest(state.launchedTaskIds)) return held();
  return structuredClone({
    conversationId: state.conversationId, logicalRunId: state.logicalRunId,
    flowId: state.flowId, source: state.source, status: state.status,
    isCancelled: state.isCancelled, parentRunId: state.parentRunId,
    parentConversationId: state.parentConversationId, parentLogicalRunId: state.parentLogicalRunId,
    rootConversationId: state.rootConversationId, currentNodeId: state.currentNodeId,
    runDepth: state.runDepth, subflowLane: state.subflowLane,
    subflowInvocations: state.subflowInvocations, launchedTaskIds: state.launchedTaskIds,
    recovery: state.recovery,
    createdAt: state.createdAt,
  });
}

const MAX_PARENT_TASK_LINKS = 256;
const MAX_TASK_SCAN_ENTRIES = 4096;
const MAX_TASK_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TASK_SCAN_BYTES = 128 * 1024 * 1024;
const taskDir = () => path.join(getWorkspaceDataDir(), 'db', 'subflow-tasks');

async function readTaskBounded(id: string): Promise<{ task: SubflowTaskRecord; bytes: number }> {
  const file = path.join(taskDir(), `${requireId(id)}.json`);
  const entry = await fs.lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || entry.size < 1 || entry.size > MAX_TASK_ITEM_BYTES) return held();
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_TASK_ITEM_BYTES) return held();
    const buffer = Buffer.alloc(stat.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes !== stat.size) return held();
    const task = JSON.parse(buffer.subarray(0, bytes).toString('utf8')) as SubflowTaskRecord;
    if (!task || typeof task !== 'object' || Array.isArray(task)) return held();
    return { task, bytes };
  } finally { await handle.close(); }
}

async function detachedTaskCandidates(parent: StateSnapshot, childId: string): Promise<SubflowTaskRecord[]> {
  const linked = parent.launchedTaskIds;
  if (linked?.length) {
    if (linked.length > MAX_PARENT_TASK_LINKS || new Set(linked).size !== linked.length) return held();
    const matches: SubflowTaskRecord[] = [];
    let total = 0;
    for (const id of linked) {
      const { task, bytes } = await readTaskBounded(id);
      total += bytes;
      if (total > MAX_TASK_SCAN_BYTES || task.taskId !== id) return held();
      if (task.childConversationId === childId) matches.push(task);
    }
    if (matches.length) return matches;
    // A task is saved before its parent launchedTaskIds update. A child can
    // already be running during that short window, so scan the saved records.
  }
  const matches: SubflowTaskRecord[] = [];
  let entries = 0;
  let total = 0;
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try { directory = await fs.opendir(taskDir()); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return matches;
    throw error;
  }
  for await (const entry of directory) {
    entries += 1;
    if (entries > MAX_TASK_SCAN_ENTRIES) return held();
    if (!entry.name.endsWith('.json') || entry.name.includes('.tmp.')
      || entry.name.includes('.corrupted.') || entry.name.endsWith('.bak')) continue;
    const id = requireId(entry.name.slice(0, -'.json'.length));
    const { task, bytes } = await readTaskBounded(id);
    total += bytes;
    if (total > MAX_TASK_SCAN_BYTES || task.taskId !== id) return held();
    if (task.childConversationId === childId) matches.push(task);
  }
  return matches;
}

async function detachedEdge(child: StateSnapshot, parent: StateSnapshot, installationId: string,
  processInstanceId: string, recoveryOwnerId: string): Promise<NativeLineageEdge> {
  const matches = await detachedTaskCandidates(parent, child.conversationId!);
  if (matches.length !== 1) return held();
  const task = matches[0];
  if (task.version !== 1 || !task.taskId
    || task.childConversationId !== child.conversationId
    || task.originConversationId !== parent.conversationId
    || task.originLogicalRunId !== parent.logicalRunId
    || task.flowId !== child.flowId || !task.originNodeId
    || task.status !== 'working' || task.cancelRequestedAt || task.interruption
    || task.launchOwner?.workspace !== getCurrentWorkspace()
    || task.launchOwner.installationId !== installationId
    || task.launchOwner.processInstanceId !== processInstanceId
    || task.launchOwner.recoveryOwnerId !== recoveryOwnerId
    || task.launchOwner.recoveryOwnerId !== child.recovery?.ownerId
    || !Number.isFinite(task.createdAt) || task.createdAt > (child.createdAt ?? 0)) return held();
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
  signal: AbortSignal;
}): Promise<NativeOriginLineageEvidence> {
  try {
    assertNativeBrokerAuthority(input.authority);
    if (!rootBindings.has(input.root)) return held();
    const { receipt, root, authority } = input;
    for (const value of [root.fleetRunId, root.workerId, root.goalId, root.rootConversationId,
      root.rootLogicalRunId, root.rootFlowId, receipt.owner.conversationId,
      receipt.owner.runId, receipt.owner.nodeId]) requireId(value);
    if (!receipt.owner.modelId || !receipt.owner.inputDigest || !receipt.owner.inventoryDigest
      || !Number.isSafeInteger(receipt.owner.attemptOrdinal) || receipt.owner.attemptOrdinal < 1) return held();
    if (root.workspace !== getCurrentWorkspace()
      || receipt.owner.leaseEpoch !== authority.leaseEpoch) return held();
    const assertCurrent = async () => {
      input.signal.throwIfAborted();
      await authority.assertCurrent();
      input.signal.throwIfAborted();
      await root.assertCurrent();
      input.signal.throwIfAborted();
      // The root gate can await long enough for the Worker lease to change.
      await authority.assertCurrent();
      input.signal.throwIfAborted();
    };
    const status = async () => {
      const current = await nativeInvocationStatus(receipt.invocationId, receipt.owner);
      if (current.state !== 'prepared' && current.state !== 'begin-may-have-been-sent') return held();
    };
    await assertCurrent();
    await status();
    await assertCurrent();
    const launchOwner = await getDetachedTaskLaunchOwner();
    const installationId = launchOwner.installationId;
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
          : await detachedEdge(current, parent, installationId,
            launchOwner.processInstanceId, launchOwner.recoveryOwnerId);
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
        modelId: receipt.owner.modelId, inputDigest: receipt.owner.inputDigest,
        inventoryDigest: receipt.owner.inventoryDigest, leaseEpoch: receipt.owner.leaseEpoch,
        attemptOrdinal: receipt.owner.attemptOrdinal,
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
    await assertCurrent();
    return { ...second, digest: nativeDigest(second) };
  } catch {
    return held();
  }
}
