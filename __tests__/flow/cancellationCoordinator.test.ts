const mockListPersonaFlowDispatches = jest.fn(async (..._args: unknown[]) => []);
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
  cancelAllRunningConversations,
  registerCancellableRun,
  waitForWorkspaceRunAdmission,
} from '@/backend/execution/flow/cancellationCoordinator';

describe('workspace cancellation coordinator', () => {
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
    const registration = registerCancellableRun({
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
});
