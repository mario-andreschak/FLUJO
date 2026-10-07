import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { saveCollectionItem, deleteCollectionItem } from '@/utils/storage/backend';
import { createTask } from '@/backend/services/subflowTasks';
import { getDetachedTaskLaunchOwner } from '@/backend/services/subflowTasks/ownership';
import { createNativeBrokerAuthority } from '@/backend/execution/flow/handlers/nativeToolBroker';
import { _setNativeToolJournalRootForTests, prepareNativeInvocation } from '@/backend/execution/flow/handlers/nativeToolJournal';
import {
  createNativeLineageRootBinding, readNativeOriginLineage, NativeLineageHeldError,
} from '@/backend/execution/flow/handlers/nativeOriginLineage';

const rootId = 'lead-root';
const rootRun = 'lead-logical-run';
const rootFlow = 'lead-flow';
const signal = new AbortController().signal;
let directory: string;
let priorDataDir: string | undefined;

const state = (id: string, values: Partial<SharedState>): SharedState => ({
  conversationId: id, title: id, createdAt: Date.now(), updatedAt: Date.now(),
  status: 'running', runDepth: 0, ...values,
} as SharedState);
const saveState = async (value: SharedState) => saveCollectionItem('conversations', value.conversationId!, value);
const rootState = () => state(rootId, {
  flowId: rootFlow, logicalRunId: rootRun, currentNodeId: 'lead-process', source: 'api',
});
const receiptFor = (id: string, runId: string, nodeId: string) => prepareNativeInvocation({
  conversationId: id, runId, nodeId, modelId: 'native-model', leaseEpoch: 'lease-1',
  inventoryDigest: 'inventory', inputDigest: 'input', attemptOrdinal: 1,
});
const rootBinding = (assertCurrent = async () => undefined) => createNativeLineageRootBinding({
  fleetRunId: 'fleet-run', workerId: 'worker-1', goalId: 'goal-1', workspace: 'default-workspace',
  rootConversationId: rootId, rootLogicalRunId: rootRun, rootFlowId: rootFlow,
}, assertCurrent);
const authority = (assertCurrent = async () => undefined) => createNativeBrokerAuthority('lease-1', assertCurrent);

async function detachedChild(parent: SharedState, childId: string, flowId = `flow-${childId}`) {
  const task = await createTask({
    originConversationId: parent.conversationId!, originNodeId: 'spawn-subflow',
    originLogicalRunId: parent.logicalRunId!, flowId, childConversationId: childId,
    input: { prompt: 'fixture task' },
  });
  expect(task).not.toBeNull();
  parent.launchedTaskIds = [...(parent.launchedTaskIds ?? []), task!.taskId];
  await saveState(parent);
  const child = state(childId, {
    flowId, source: 'subflow', logicalRunId: `run-${childId}`, currentNodeId: `process-${childId}`,
    parentRunId: parent.conversationId, parentConversationId: parent.conversationId,
    parentLogicalRunId: parent.logicalRunId, rootConversationId: rootId,
    runDepth: (parent.runDepth ?? 0) + 1, createdAt: task!.createdAt + 1,
    recovery: { ownerId: task!.launchOwner!.recoveryOwnerId } as SharedState['recovery'],
  });
  await saveState(child);
  return { child, task: task! };
}

beforeEach(async () => {
  priorDataDir = process.env.FLUJO_DATA_DIR;
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-native-lineage-'));
  process.env.FLUJO_DATA_DIR = directory;
  _setNativeToolJournalRootForTests(path.join(directory, 'journal'));
  FlowExecutor.conversationStates.clear();
  await saveState(rootState());
});
afterEach(async () => {
  FlowExecutor.conversationStates.clear();
  _setNativeToolJournalRootForTests(undefined);
  if (priorDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
  else process.env.FLUJO_DATA_DIR = priorDataDir;
  await fs.rm(directory, { recursive: true, force: true });
});

describe('saved native origin lineage', () => {
  it('binds the actual root invocation and four distinct detached child origins to one selected root', async () => {
    const root = rootState();
    const binding = rootBinding();
    const lease = authority();
    const rootReceipt = await receiptFor(rootId, rootRun, 'lead-process');
    const rootProof = await readNativeOriginLineage({ receipt: rootReceipt, authority: lease, root: binding, signal });
    expect(rootProof.edges).toEqual([]);
    expect(rootProof.originConversationId).toBe(rootId);
    expect(rootProof).toMatchObject({
      modelId: 'native-model', inputDigest: 'input', inventoryDigest: 'inventory',
      leaseEpoch: 'lease-1', attemptOrdinal: 1,
    });
    for (let index = 1; index <= 4; index++) {
      const { child } = await detachedChild(root, `child-${index}`);
      const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
      const proof = await readNativeOriginLineage({ receipt, authority: lease, root: binding, signal });
      expect(proof.rootConversationId).toBe(rootId);
      expect(proof.originConversationId).toBe(child.conversationId);
      expect(proof.originLogicalRunId).toBe(child.logicalRunId);
      expect(proof.edges).toMatchObject([{ kind: 'detached-task', parentConversationId: rootId,
        childConversationId: child.conversationId }]);
      expect(proof.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('walks a nested detached child and a persisted attached Subflow lane', async () => {
    const root = rootState();
    const { child: first } = await detachedChild(root, 'first-child');
    const { child: nested } = await detachedChild(first, 'nested-child');
    const invocation: SubflowInvocation = {
      version: 1, id: 'visit-1', parentConversationId: nested.conversationId!,
      parentRunId: nested.conversationId, parentNodeId: 'subflow-node', status: 'running',
      depth: 3, showSteps: true, concurrencyLimit: 4, joinSeparator: '\n',
      errorStrategy: 'collect-all', createdAt: Date.now(), updatedAt: Date.now(),
      lanes: [{ id: 'lane-1', index: 0, count: 1, subflowId: 'leaf-flow',
        conversationId: 'attached-leaf', status: 'running', attempt: 1, updatedAt: Date.now() }],
    };
    nested.subflowInvocations = { [invocation.id]: invocation };
    await saveState(nested);
    const leaf = state('attached-leaf', {
      flowId: 'leaf-flow', source: 'subflow', logicalRunId: 'run-leaf',
      currentNodeId: 'process-leaf', parentRunId: nested.conversationId,
      parentConversationId: nested.conversationId, parentLogicalRunId: nested.logicalRunId,
      rootConversationId: rootId, runDepth: 3,
      subflowLane: { laneIndex: 0, conversationId: 'attached-leaf',
        invocationId: 'visit-1', laneId: 'lane-1', parentNodeId: 'subflow-node' },
    });
    await saveState(leaf);
    const receipt = await receiptFor('attached-leaf', 'run-leaf', 'process-leaf');
    const proof = await readNativeOriginLineage({ receipt, authority: authority(), root: rootBinding(), signal });
    expect(proof.edges.map(edge => edge.kind)).toEqual(['detached-task', 'detached-task', 'attached-lane']);
    expect(proof.edges.map(edge => edge.childConversationId)).toEqual(['first-child', 'nested-child', 'attached-leaf']);
    await saveState({ ...leaf, subflowLane: { ...leaf.subflowLane!, laneId: 'forged-lane' } });
    await expect(readNativeOriginLineage({ receipt, authority: authority(), root: rootBinding(), signal }))
      .rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('keeps an original child eligible after its parent call completes in the same logical run', async () => {
    const root = rootState();
    const { child } = await detachedChild(root, 'waiting-child');
    await saveState({ ...root, status: 'completed' });
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    const proof = await readNativeOriginLineage({ receipt, authority: authority(), root: rootBinding(), signal });
    expect(proof.edges).toHaveLength(1);
    expect(proof.originConversationId).toBe('waiting-child');
  });

  it('rejects public-looking parent claims without a saved launch receipt', async () => {
    const forged = state('forged-child', {
      flowId: 'child-flow', source: 'subflow', logicalRunId: 'forged-run',
      currentNodeId: 'forged-node', parentRunId: rootId, parentConversationId: rootId,
      parentLogicalRunId: rootRun, rootConversationId: rootId, runDepth: 1,
    });
    await saveState(forged);
    const receipt = await receiptFor('forged-child', 'forged-run', 'forged-node');
    await expect(readNativeOriginLineage({ receipt, authority: authority(), root: rootBinding(), signal }))
      .rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('holds missing, forged and unreadable detached task edges', async () => {
    const { child, task } = await detachedChild(rootState(), 'child-edge');
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    const input = { receipt, authority: authority(), root: rootBinding(), signal };
    await saveCollectionItem('subflow-tasks', task.taskId, { ...task, flowId: 'forged-flow' });
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    await deleteCollectionItem('subflow-tasks', task.taskId);
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    const taskDir = path.join(directory, 'workspaces', 'default-workspace', 'db', 'subflow-tasks');
    await fs.writeFile(path.join(taskDir, `${task.taskId}.json`), '{broken');
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('holds missing parent state, cyclic ancestry and a replaced root logical run', async () => {
    const root = rootState();
    const { child, task } = await detachedChild(root, 'child-cycle');
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    const input = { receipt, authority: authority(), root: rootBinding(), signal };
    await deleteCollectionItem('conversations', rootId);
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    await saveState({ ...root, logicalRunId: 'replacement-run' });
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    await saveState(root);
    // A cycle cannot be repaired by claims of the selected root ID.
    await saveState({ ...root, parentRunId: child.conversationId,
      parentConversationId: child.conversationId, parentLogicalRunId: child.logicalRunId,
      source: 'subflow', rootConversationId: rootId });
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    expect(task.originConversationId).toBe(rootId);
  });

  it('does not mistake a live-only child state for a saved conversation', async () => {
    const { child } = await detachedChild(rootState(), 'memory-only-child');
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    FlowExecutor.conversationStates.set(child.conversationId!, child);
    await deleteCollectionItem('conversations', child.conversationId!);
    await expect(readNativeOriginLineage({ receipt, authority: authority(), root: rootBinding(), signal }))
      .rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('uses a saved parent task link and bounds the fallback task scan', async () => {
    const root = rootState();
    const { child, task } = await detachedChild(root, 'linked-child');
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    const input = { receipt, authority: authority(), root: rootBinding(), signal };
    expect((await readNativeOriginLineage(input)).edges[0].receiptId).toBe(task.taskId);
    root.launchedTaskIds = [];
    await saveState(root);
    expect((await readNativeOriginLineage(input)).edges[0].receiptId).toBe(task.taskId);
    root.launchedTaskIds = [task.taskId];
    await saveState(root);
    const file = path.join(directory, 'workspaces', 'default-workspace', 'db', 'subflow-tasks', `${task.taskId}.json`);
    await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024 + 1));
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    root.launchedTaskIds = [];
    await saveState(root);
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    root.launchedTaskIds = Array.from({ length: 257 }, (_, index) => `task-${index}`);
    await saveState(root);
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('rechecks Worker authority after an awaited root gate revokes it', async () => {
    const receipt = await receiptFor(rootId, rootRun, 'lead-process');
    let workerCurrent = true;
    let entered!: () => void;
    let release!: () => void;
    const rootEntered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = readNativeOriginLineage({
      receipt, signal,
      authority: authority(async () => { if (!workerCurrent) throw new Error('Worker lease revoked'); }),
      root: rootBinding(async () => { entered(); await gate; workerCurrent = false; }),
    });
    await rootEntered;
    release();
    await expect(pending).rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('rechecks Worker authority and abort after the final journal status read', async () => {
    const receipt = await receiptFor(rootId, rootRun, 'lead-process');
    let workerCurrent = true;
    let statusReads = 0;
    const readFile = fs.readFile.bind(fs);
    const spy = jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const content = await readFile(...args);
      if (String(args[0]).startsWith(path.join(directory, 'journal', 'calls'))) {
        statusReads += 1;
        if (statusReads === 2) workerCurrent = false;
      }
      return content;
    });
    try {
      await expect(readNativeOriginLineage({
        receipt, signal,
        authority: authority(async () => { if (!workerCurrent) throw new Error('Worker lease revoked'); }),
        root: rootBinding(),
      })).rejects.toBeInstanceOf(NativeLineageHeldError);
      expect(statusReads).toBe(2);
    } finally { spy.mockRestore(); }
    const controller = new AbortController();
    await expect(readNativeOriginLineage({
      receipt, signal: controller.signal, authority: authority(),
      root: rootBinding(async () => { controller.abort(); }),
    })).rejects.toBeInstanceOf(NativeLineageHeldError);
  });

  it('holds cancellation, revoked authority, forged binding and wrong origin node', async () => {
    const root = rootState();
    const { child } = await detachedChild(root, 'child-authority');
    const receipt = await receiptFor(child.conversationId!, child.logicalRunId!, child.currentNodeId!);
    let current = true;
    const binding = rootBinding(async () => { if (!current) throw new Error('retired Worker'); });
    const input = { receipt, authority: authority(), root: binding, signal };
    expect((await readNativeOriginLineage(input)).originConversationId).toBe(child.conversationId);
    current = false;
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    current = true;
    await saveState({ ...child, isCancelled: true });
    await expect(readNativeOriginLineage(input)).rejects.toBeInstanceOf(NativeLineageHeldError);
    await saveState(child);
    await expect(readNativeOriginLineage({ ...input, root: JSON.parse(JSON.stringify(binding)) }))
      .rejects.toBeInstanceOf(NativeLineageHeldError);
    await expect(readNativeOriginLineage({ ...input, receipt: {
      ...receipt, owner: { ...receipt.owner, nodeId: 'other-node' },
    } })).rejects.toBeInstanceOf(NativeLineageHeldError);
  });
});
