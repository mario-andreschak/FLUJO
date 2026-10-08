import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import * as persistence from '@/backend/execution/flow/persistConversationState';
import { reportSubflowRunOutcome, type SubflowRunOutcome } from '@/backend/execution/flow/subflowRecovery';
import { getCurrentWorkspace, getWorkspaceDbDir, runWithWorkspace, workspaceCacheKey } from '@/utils/workspace';
import type { SharedState, SubflowInvocation } from '@/backend/execution/flow/types';

const runFlowMock = jest.fn<Promise<SubflowRunOutcome>, [unknown]>();
jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: (input: unknown) => runFlowMock(input),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function family(): { parent: SharedState; outcome: SubflowRunOutcome } {
  const invocation: SubflowInvocation = {
    version: 1, id: 'lease-invocation', parentConversationId: 'lease-parent',
    parentNodeId: 'sub-node', status: 'blocked', depth: 1, showSteps: true,
    concurrencyLimit: 1, joinSeparator: '\n', errorStrategy: 'fail-fast',
    lanes: [{ id: 'lane', index: 0, count: 1, subflowId: 'child-flow',
      conversationId: 'lease-child', status: 'error', attempt: 1, updatedAt: 1 }],
    createdAt: 1, updatedAt: 1,
  };
  const parent = {
    logicalRunId: 'lease-parent-run', conversationId: 'lease-parent', flowId: 'parent-flow',
    currentNodeId: 'sub-node', status: 'error', source: 'chat', title: 'Lease fixture',
    createdAt: 1, updatedAt: 1, messages: [],
    trackingInfo: { executionId: 'parent-exec', startTime: 1, nodeExecutionTracker: [] },
    subflowInvocations: { [invocation.id]: invocation },
    activeSubflowInvocationByNode: { 'sub-node': invocation.id },
  } as SharedState;
  FlowExecutor.conversationStates.set('lease-parent', parent);
  const child = {
    conversationId: 'lease-child', parentConversationId: 'lease-parent', messages: [],
    subflowLane: { invocationId: invocation.id, laneId: 'lane', conversationId: 'lease-child' },
  } as unknown as SharedState;
  return { parent, outcome: { status: 'completed', conversationId: 'lease-child',
    outputText: 'durable child output', sharedState: child } };
}

describe('parent resume lease with real storage', () => {
  const workspaces = ['lease-storage-a', 'lease-storage-b'];
  const persist = persistence.persistConversationState;
  let root: string;
  let priorData: string | undefined;
  let priorParentData: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-resume-lease-'));
    priorData = process.env.FLUJO_DATA_DIR;
    priorParentData = process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_DATA_DIR = root;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    runFlowMock.mockReset();
    for (const workspace of workspaces) runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear());
    runFlowMock.mockImplementation(async () => ({ status: 'completed', conversationId: 'lease-parent',
      outputText: 'parent output', sharedState: FlowExecutor.conversationStates.get('lease-parent')! }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      for (const workspace of workspaces) runWithWorkspace(workspace, () => {
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation')) ?? false).toBe(false);
      });
    } finally {
      for (const workspace of workspaces) runWithWorkspace(workspace, () => FlowExecutor.conversationStates.clear());
      if (priorData === undefined) delete process.env.FLUJO_DATA_DIR;
      else process.env.FLUJO_DATA_DIR = priorData;
      if (priorParentData === undefined) delete process.env.FLUJO_PARENT_DATA_DIR;
      else process.env.FLUJO_PARENT_DATA_DIR = priorParentData;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('releases its lease after an actual resume-snapshot filesystem failure and permits reacquisition', async () => {
    await runWithWorkspace(workspaces[0], async () => {
      const { parent, outcome } = family();
      const target = path.join(getWorkspaceDbDir(), 'conversations', 'lease-parent.json');
      const backup = `${target}.fixture-backup`;
      let writes = 0;
      jest.spyOn(persistence, 'persistConversationState').mockImplementation(async (key, state) => {
        if (++writes === 2) {
          // The child-result write has succeeded. Block only the subsequent
          // leased resume snapshot, using the real atomic storage writer.
          await fs.rename(target, backup);
          await fs.mkdir(target);
        }
        await persist(key, state);
      });
      try {
        const failure: unknown = await reportSubflowRunOutcome(outcome).then(
          () => { throw new Error('The blocked snapshot unexpectedly persisted'); },
          error => error,
        );
        expect(['EISDIR', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST']).toContain((failure as NodeJS.ErrnoException).code);
        expect(writes).toBe(2);
        expect(runFlowMock).not.toHaveBeenCalled();
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(false);
        const saved = JSON.parse(await fs.readFile(backup, 'utf8')) as SharedState;
        expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
      } finally {
        await fs.rmdir(target);
        await fs.rename(backup, target);
      }
      await reportSubflowRunOutcome(outcome);
      expect(runFlowMock).toHaveBeenCalledTimes(1);
      expect(parent.subflowInvocations?.['lease-invocation'].resumeRequestedAt).toEqual(expect.any(Number));
      const saved = JSON.parse(await fs.readFile(target, 'utf8')) as SharedState;
      expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
    });
  });

  it('keeps the lease during pending persistence and continuation despite duplicate outcomes', async () => {
    await runWithWorkspace(workspaces[0], async () => {
      const { outcome } = family();
      const persisting = deferred();
      const allowPersist = deferred();
      const continuing = deferred();
      const allowContinuation = deferred();
      let writes = 0;
      jest.spyOn(persistence, 'persistConversationState').mockImplementation(async (key, state) => {
        if (++writes === 2) { persisting.resolve(); await allowPersist.promise; }
        await persist(key, state);
      });
      runFlowMock.mockImplementationOnce(async () => {
        continuing.resolve();
        await allowContinuation.promise;
        return { status: 'completed', conversationId: 'lease-parent', outputText: 'done',
          sharedState: FlowExecutor.conversationStates.get('lease-parent')! };
      });
      const first = reportSubflowRunOutcome(outcome);
      try {
        await persisting.promise;
        await reportSubflowRunOutcome(outcome);
        expect(runFlowMock).not.toHaveBeenCalled();
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
        allowPersist.resolve();
        await continuing.promise;
        await reportSubflowRunOutcome(outcome);
        expect(runFlowMock).toHaveBeenCalledTimes(1);
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
      } finally {
        allowPersist.resolve();
        allowContinuation.resolve();
        await first;
      }
    });
  });

  it('allows the same invocation in another workspace while the first workspace owns its lease', async () => {
    const entered = deferred();
    const release = deferred();
    const observed: string[] = [];
    runFlowMock.mockImplementation(async () => {
      const workspace = getCurrentWorkspace();
      observed.push(workspace);
      if (workspace === workspaces[0]) { entered.resolve(); await release.promise; }
      return { status: 'completed', conversationId: 'lease-parent', outputText: workspace,
        sharedState: FlowExecutor.conversationStates.get('lease-parent')! };
    });
    const first = runWithWorkspace(workspaces[0], () => reportSubflowRunOutcome(family().outcome));
    try {
      await entered.promise;
      await runWithWorkspace(workspaces[1], async () => {
        const { outcome } = family();
        await reportSubflowRunOutcome(outcome);
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(false);
        const saved = JSON.parse(await fs.readFile(path.join(getWorkspaceDbDir(), 'conversations', 'lease-parent.json'), 'utf8')) as SharedState;
        expect(saved.subflowInvocations?.['lease-invocation'].lanes[0].outputText).toBe(outcome.outputText);
      });
      expect(observed).toEqual(workspaces);
      runWithWorkspace(workspaces[0], () => {
        expect(global.__flujo_subflow_parent_resume_leases?.has(workspaceCacheKey('lease-invocation'))).toBe(true);
      });
    } finally {
      release.resolve();
      await first;
    }
  });
});
