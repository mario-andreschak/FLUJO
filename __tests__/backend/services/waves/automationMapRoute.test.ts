const assertLocalRequestMock = jest.fn<
  Response | null,
  [Request, { strictLoopback?: boolean }?]
>();
const ensureBackendInitializedMock = jest.fn();
const schedulerListMock = jest.fn();
const schedulerIsPausedMock = jest.fn();
const loadFlowsMock = jest.fn();
const loadPackagesMock = jest.fn();
const resolveAutomationMapMock = jest.fn();
const scheduleNextRunsMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => null),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (request: Request, options?: { strictLoopback?: boolean }) =>
    assertLocalRequestMock(request, options),
}));

jest.mock('@/backend/init', () => ({
  ensureBackendInitialized: (...args: unknown[]) => ensureBackendInitializedMock(...args),
}));

jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    list: (...args: unknown[]) => schedulerListMock(...args),
    isPaused: (...args: unknown[]) => schedulerIsPausedMock(...args),
  }),
}));

jest.mock('@/backend/services/scheduler/triggers/schedule', () => ({
  scheduleNextRuns: (...args: unknown[]) => scheduleNextRunsMock(...args),
}));

jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => loadFlowsMock(...args),
  },
}));

jest.mock('@/backend/services/waves/automationMapPackageProvenance', () => ({
  loadAutomationMapPackages: (...args: unknown[]) => loadPackagesMock(...args),
}));

jest.mock('@/backend/services/waves/automationMapResolver', () => ({
  resolveAutomationMap: (input: unknown) => resolveAutomationMapMock(input),
}));

import { GET } from '@/app/api/automation-map/route';

function plannedExecutionEntry(id: string, personaId?: string) {
  return {
    execution: {
      id,
      name: id,
      enabled: true,
      flowId: 'flow-1',
      prompt: '',
      trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'America/Bogota' },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      ...(personaId ? { personaId } : {}),
    },
    status: { armed: false, running: false, nextRun: null },
    lastRun: null,
  };
}

const legacyEntry = plannedExecutionEntry('legacy-plan');
const personaEntry = plannedExecutionEntry('persona-plan', 'persona-1');
const personaTombstoneEntry = {
  ...plannedExecutionEntry('persona-tombstone'),
  execution: {
    ...plannedExecutionEntry('persona-tombstone').execution,
    personaArchived: true as const,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
  ensureBackendInitializedMock.mockResolvedValue(undefined);
  schedulerListMock.mockResolvedValue([legacyEntry, personaEntry]);
  schedulerIsPausedMock.mockResolvedValue(true);
  loadFlowsMock.mockResolvedValue([{ id: 'flow-1', name: 'Flow 1', nodes: [], edges: [] }]);
  loadPackagesMock.mockResolvedValue([{ name: 'Pkg', flowIds: ['flow-1'], executionIds: ['legacy-plan'] }]);
  scheduleNextRunsMock.mockReturnValue(['2026-08-09T01:00:00.000Z']);
  resolveAutomationMapMock.mockImplementation((input: { executions: unknown[] }) => ({
    paused: true,
    generatedAt: '2026-08-09T00:00:00.000Z',
    executions: input.executions,
    flows: [],
    packages: [],
    relations: [],
    waves: [],
    components: [],
    orphanExecutionIds: [],
  }));
});

describe('Automation Map route', () => {
  test('preserves the Waves Persona boundary and stays read-only for a non-strict caller', async () => {
    const response = await GET(new Request('https://flujo.example.com/api/automation-map'));

    expect(response.status).toBe(200);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(expect.any(Request), { strictLoopback: true });
    expect(schedulerListMock).toHaveBeenCalledTimes(1);
    expect(ensureBackendInitializedMock).not.toHaveBeenCalled();
    expect(loadPackagesMock).toHaveBeenCalledTimes(1);
    expect(resolveAutomationMapMock).toHaveBeenCalledWith(expect.objectContaining({
      paused: true,
      executions: [expect.objectContaining({
        execution: expect.objectContaining({ id: 'legacy-plan' }),
        status: expect.objectContaining({ nextRun: '2026-08-09T01:00:00.000Z' }),
      })],
      packages: [expect.objectContaining({ name: 'Pkg' })],
    }));
    expect(scheduleNextRunsMock).toHaveBeenCalledWith('0 * * * *', 'America/Bogota', 1);
  });

  test('preflights before initialization and includes Persona plans for a strict caller', async () => {
    assertLocalRequestMock.mockReturnValue(null);
    schedulerListMock
      .mockResolvedValueOnce([legacyEntry, personaEntry])
      .mockResolvedValueOnce([legacyEntry, personaEntry]);

    const response = await GET(new Request('http://localhost/api/automation-map'));

    expect(response.status).toBe(200);
    expect(schedulerListMock).toHaveBeenCalledTimes(2);
    expect(ensureBackendInitializedMock).toHaveBeenCalledTimes(1);
    expect(schedulerListMock.mock.invocationCallOrder[0])
      .toBeLessThan(ensureBackendInitializedMock.mock.invocationCallOrder[0]);
    expect(resolveAutomationMapMock).toHaveBeenCalledWith(expect.objectContaining({
      executions: [
        expect.objectContaining({ execution: expect.objectContaining({ id: 'legacy-plan' }) }),
        expect.objectContaining({ execution: expect.objectContaining({ id: 'persona-plan' }) }),
      ],
    }));
  });

  test('treats marker-only Persona tombstones as controlled and filters them fail-closed', async () => {
    schedulerListMock.mockResolvedValue([legacyEntry, personaTombstoneEntry]);

    const response = await GET(new Request('https://flujo.example.com/api/automation-map'));

    expect(response.status).toBe(200);
    expect(ensureBackendInitializedMock).not.toHaveBeenCalled();
    expect(resolveAutomationMapMock).toHaveBeenCalledWith(expect.objectContaining({
      executions: [expect.objectContaining({
        execution: expect.objectContaining({ id: 'legacy-plan' }),
      })],
    }));
  });
});
