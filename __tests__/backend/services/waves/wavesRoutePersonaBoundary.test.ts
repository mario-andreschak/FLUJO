const assertLocalRequestMock = jest.fn<
  Response | null,
  [Request, { strictLoopback?: boolean }?]
>();
const ensureBackendInitializedMock = jest.fn();
const schedulerListMock = jest.fn();
const schedulerIsPausedMock = jest.fn();
const loadFlowsMock = jest.fn();
const resolveWavesMock = jest.fn();

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

jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => loadFlowsMock(...args),
  },
}));

jest.mock('@/backend/services/waves/waveResolver', () => ({
  resolveWaves: (input: unknown) => resolveWavesMock(input),
}));

import { GET } from '@/app/api/waves/route';

function plannedExecutionEntry(id: string, personaId?: string) {
  return {
    execution: {
      id,
      name: id,
      enabled: true,
      flowId: 'flow-1',
      prompt: '',
      trigger: { type: 'webhook', token: `${id}-token` },
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      ...(personaId ? { personaId } : {}),
    },
    status: {},
  };
}

const legacyEntry = plannedExecutionEntry('legacy-plan');
const personaEntry = plannedExecutionEntry('persona-plan', 'persona-1');

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
  ensureBackendInitializedMock.mockResolvedValue(undefined);
  schedulerListMock.mockResolvedValue([legacyEntry, personaEntry]);
  schedulerIsPausedMock.mockResolvedValue(false);
  loadFlowsMock.mockResolvedValue([{ id: 'flow-1', name: 'Flow 1', nodes: [], edges: [] }]);
  resolveWavesMock.mockImplementation((input: { executions: Array<{ execution: { id: string } }> }) => ({
    paused: false,
    generatedAt: '2026-08-09T00:00:00.000Z',
    waves: input.executions.map((entry) => ({ id: entry.execution.id })),
    orphans: [],
  }));
});

describe('Waves Persona boundary', () => {
  it('filters Persona plans and does not initialize their scheduler for a non-strict caller', async () => {
    const response = await GET(new Request('https://flujo.example.com/api/waves'));

    expect(response.status).toBe(200);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(
      expect.any(Request),
      { strictLoopback: true },
    );
    expect(schedulerListMock).toHaveBeenCalledTimes(1);
    expect(ensureBackendInitializedMock).not.toHaveBeenCalled();
    expect(resolveWavesMock).toHaveBeenCalledWith(expect.objectContaining({
      executions: [expect.objectContaining({
        execution: expect.objectContaining({ id: 'legacy-plan' }),
      })],
    }));
    await expect(response.json()).resolves.toMatchObject({ waves: [{ id: 'legacy-plan' }] });
  });

  it('preflights before initialization and includes Persona plans for a strict caller', async () => {
    assertLocalRequestMock.mockReturnValue(null);
    schedulerListMock
      .mockResolvedValueOnce([legacyEntry, personaEntry])
      .mockResolvedValueOnce([legacyEntry, personaEntry]);

    const response = await GET(new Request('http://localhost/api/waves'));

    expect(response.status).toBe(200);
    expect(schedulerListMock).toHaveBeenCalledTimes(2);
    expect(ensureBackendInitializedMock).toHaveBeenCalledTimes(1);
    expect(schedulerListMock.mock.invocationCallOrder[0])
      .toBeLessThan(ensureBackendInitializedMock.mock.invocationCallOrder[0]);
    expect(resolveWavesMock).toHaveBeenCalledWith(expect.objectContaining({
      executions: [
        expect.objectContaining({ execution: expect.objectContaining({ id: 'legacy-plan' }) }),
        expect.objectContaining({ execution: expect.objectContaining({ id: 'persona-plan' }) }),
      ],
    }));
  });

  it('preserves initialization for legacy-only scheduler state', async () => {
    schedulerListMock
      .mockResolvedValueOnce([legacyEntry])
      .mockResolvedValueOnce([legacyEntry]);

    const response = await GET(new Request('https://flujo.example.com/api/waves'));

    expect(response.status).toBe(200);
    expect(ensureBackendInitializedMock).toHaveBeenCalledTimes(1);
    expect(resolveWavesMock).toHaveBeenCalledWith(expect.objectContaining({
      executions: [expect.objectContaining({
        execution: expect.objectContaining({ id: 'legacy-plan' }),
      })],
    }));
  });
});
