const mockCancelAllToolCalls = jest.fn();
const mockClearPendingApprovals = jest.fn();
const mockConversationStates = new Map<string, {
  status: string;
  logicalRunId?: string;
  conversationId?: string;
  isCancelled?: boolean;
}>();

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    // Jest hoists the factory above this file's const initializers. Resolve the
    // backing map lazily so the factory never reads it inside its temporal dead zone.
    get conversationStates() {
      return mockConversationStates;
    },
  },
}));
jest.mock('@/backend/execution/flow/toolCancelRegistry', () => ({
  cancelAllToolCalls: (...args: unknown[]) => mockCancelAllToolCalls(...args),
}));
jest.mock('@/backend/execution/flow/toolApprovalRegistry', () => ({
  clearPendingApprovals: (...args: unknown[]) => mockClearPendingApprovals(...args),
}));

const mockListPersonaFlowDispatches = jest.fn(async (
  ..._args: unknown[]
): Promise<Array<{ id: string; personaId: string; state: 'queued' | 'running' | 'waiting' }>> => []);
const mockCancelPersonaFlowDispatchById = jest.fn(async (..._args: unknown[]) => ({
  id: 'persona-dispatch',
}));

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  listPersonaFlowDispatches: (...args: unknown[]) => mockListPersonaFlowDispatches(...args),
  cancelPersonaFlowDispatchById: (...args: unknown[]) =>
    mockCancelPersonaFlowDispatchById(...args),
}));

import {
  acquireWorkspaceRunBarrier,
  acquireWorkspaceRunBarrierWhenAvailable,
  cancelAllRunningConversations,
  registerCancellableRun,
  waitForWorkspaceRunAdmission,
} from '@/backend/execution/flow/cancellationCoordinator';
import { runWithWorkspace } from '@/utils/workspace';

describe('workspace cancellation coordinator', () => {
  beforeEach(() => {
    mockConversationStates.clear();
    mockListPersonaFlowDispatches.mockResolvedValue([]);
    mockCancelPersonaFlowDispatchById.mockResolvedValue({ id: 'persona-dispatch' });
  });

  afterEach(() => {
    acquireWorkspaceRunBarrier('test-cleanup', { force: true })();
    jest.clearAllMocks();
  });

  it('holds new admissions until the barrier owner releases them', async () => {
    const release = acquireWorkspaceRunBarrier('owner');
    let admitted = false;
    const waiting = waitForWorkspaceRunAdmission('other').then(() => {
      admitted = true;
    });

    await Promise.resolve();
    expect(admitted).toBe(false);

    release();
    await waiting;
    expect(admitted).toBe(true);
  });

  it('atomically reserves the barrier for the next waiting owner', async () => {
    const releaseFirst = await acquireWorkspaceRunBarrierWhenAvailable('first');
    let secondAcquired = false;
    const waiting = acquireWorkspaceRunBarrierWhenAvailable('second').then((release) => {
      secondAcquired = true;
      return release;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);

    releaseFirst();
    const releaseSecond = await waiting;
    expect(secondAcquired).toBe(true);

    let thirdAdmitted = false;
    const third = waitForWorkspaceRunAdmission('third').then(() => {
      thirdAdmitted = true;
    });
    await Promise.resolve();
    expect(thirdAdmitted).toBe(false);

    releaseSecond();
    await third;
    expect(thirdAdmitted).toBe(true);
  });

  it('rejects an already-aborted run before registration', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before admission');
    controller.abort(reason);

    await expect(registerCancellableRun({
      runId: 'already-cancelled',
      signal: controller.signal,
    })).rejects.toBe(reason);

    const report = await cancelAllRunningConversations({
      reason: 'Emergency test',
      timeoutMs: 0,
    });
    expect(report.directRunIds).not.toContain('already-cancelled');
  });

  it('fences a stale release when EMERGENCY replaces the current holder', async () => {
    const releaseFirst = acquireWorkspaceRunBarrier('first');
    const releaseEmergency = acquireWorkspaceRunBarrier('emergency', { force: true });
    releaseFirst();

    let admitted = false;
    const waiting = waitForWorkspaceRunAdmission('other').then(() => {
      admitted = true;
    });
    await Promise.resolve();
    expect(admitted).toBe(false);

    releaseEmergency();
    await waiting;
    expect(admitted).toBe(true);
  });

  it('actively aborts registered direct runs and reports their identities', async () => {
    const registration = await registerCancellableRun({
      runId: 'run-a',
      conversationId: 'conversation-a',
    });

    const report = await cancelAllRunningConversations({
      reason: 'Emergency test',
      timeoutMs: 0,
    });

    expect(registration.signal.aborted).toBe(true);
    expect(report.directRunIds).toContain('run-a');
    expect(report.conversationIds).toContain('conversation-a');
    expect(report.failures).toEqual([]);
    registration.release();
  });

  it('registers a direct run only after an active admission barrier releases', async () => {
    const releaseBarrier = acquireWorkspaceRunBarrier('emergency');
    let registered = false;
    const pending = registerCancellableRun({ runId: 'incoming' }).then((registration) => {
      registered = true;
      return registration;
    });

    await Promise.resolve();
    expect(registered).toBe(false);

    releaseBarrier();
    const registration = await pending;
    expect(registered).toBe(true);
    registration.release();
  });

  it('cancels multiple direct runs and active Persona dispatches', async () => {
    const first = await registerCancellableRun({ runId: 'run-a' });
    const second = await registerCancellableRun({ runId: 'run-b' });
    mockListPersonaFlowDispatches.mockResolvedValueOnce([{
      id: 'persona-dispatch',
      personaId: 'persona-a',
      state: 'running',
    }]);

    const report = await cancelAllRunningConversations({
      reason: 'Emergency test',
      timeoutMs: 0,
    });

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(report.directRunIds).toEqual(expect.arrayContaining(['run-a', 'run-b']));
    expect(report.personaDispatchIds).toContain('persona-dispatch');
    expect(mockCancelPersonaFlowDispatchById).toHaveBeenCalledWith({
      personaId: 'persona-a',
      dispatchId: 'persona-dispatch',
      reason: 'Emergency test',
    }, {
      waitForCompletion: true,
      timeoutMs: 0,
    });
    first.release();
    second.release();
  });

  it('does not cancel the initiating run', async () => {
    const initiating = await registerCancellableRun({ runId: 'initiator' });
    const other = await registerCancellableRun({ runId: 'other' });

    const report = await cancelAllRunningConversations({
      exceptRunId: 'initiator',
      reason: 'Emergency test',
      timeoutMs: 0,
    });

    expect(initiating.signal.aborted).toBe(false);
    expect(other.signal.aborted).toBe(true);
    expect(report.directRunIds).not.toContain('initiator');
    expect(report.directRunIds).toContain('other');
    initiating.release();
    other.release();
  });

  it('cancels active tool calls and pending approvals for live conversations', async () => {
    const state = {
      status: 'awaiting_tool_approval',
      logicalRunId: 'tool-run',
      conversationId: 'tool-conversation',
      isCancelled: false,
    };
    mockConversationStates.set('tool-conversation', state);

    const report = await cancelAllRunningConversations({
      reason: 'Emergency test',
      timeoutMs: 0,
    });

    expect(state.isCancelled).toBe(true);
    expect(mockCancelAllToolCalls).toHaveBeenCalledWith('tool-conversation');
    expect(mockCancelAllToolCalls).toHaveBeenCalledWith('tool-run');
    expect(mockClearPendingApprovals).toHaveBeenCalledWith('tool-conversation');
    expect(report.conversationIds).toContain('tool-conversation');
  });

  it('isolates direct cancellation between workspaces', async () => {
    const first = await runWithWorkspace('emergency-workspace-a', () =>
      registerCancellableRun({ runId: 'workspace-a-run' }));
    const second = await runWithWorkspace('emergency-workspace-b', () =>
      registerCancellableRun({ runId: 'workspace-b-run' }));

    const report = await runWithWorkspace('emergency-workspace-a', () =>
      cancelAllRunningConversations({ reason: 'Emergency test', timeoutMs: 0 }));

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(report.directRunIds).toContain('workspace-a-run');
    expect(report.directRunIds).not.toContain('workspace-b-run');
    first.release();
    second.release();
  });

  it('reports a Persona cancellation failure deterministically', async () => {
    mockListPersonaFlowDispatches.mockResolvedValueOnce([{
      id: 'persona-dispatch',
      personaId: 'persona-a',
      state: 'queued',
    }]);
    mockCancelPersonaFlowDispatchById.mockRejectedValueOnce(new Error('mailbox unavailable'));

    const report = await cancelAllRunningConversations({
      reason: 'Emergency test',
      timeoutMs: 0,
    });

    expect(report.failures).toContainEqual({
      kind: 'persona',
      id: 'persona-dispatch',
      error: 'mailbox unavailable',
    });
  });
});
