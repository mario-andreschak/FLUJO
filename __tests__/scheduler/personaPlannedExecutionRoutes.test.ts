const createMock = jest.fn();
const getMock = jest.fn();
const updateMock = jest.fn();
const deleteMock = jest.fn();
const runNowMock = jest.fn();
const listMock = jest.fn();
const isPausedMock = jest.fn();
const setPausedMock = jest.fn();
const loadRunRecordsMock = jest.fn();
const ensureBackendInitializedMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/scheduler', () => ({
  getSchedulerService: () => ({
    create: (...args: unknown[]) => createMock(...args),
    get: (...args: unknown[]) => getMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
    delete: (...args: unknown[]) => deleteMock(...args),
    runNow: (...args: unknown[]) => runNowMock(...args),
    list: (...args: unknown[]) => listMock(...args),
    isPaused: (...args: unknown[]) => isPausedMock(...args),
    setPaused: (...args: unknown[]) => setPausedMock(...args),
  }),
}));

jest.mock('@/backend/init', () => ({
  ensureBackendInitialized: (...args: unknown[]) => ensureBackendInitializedMock(...args),
}));

jest.mock('@/backend/services/scheduler/runHistory', () => ({
  loadRunRecords: (...args: unknown[]) => loadRunRecordsMock(...args),
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

import { NextRequest } from 'next/server';
import {
  GET as listExecutions,
  PATCH as pauseExecutions,
  POST as createExecution,
} from '@/app/api/planned-executions/route';
import {
  DELETE as deleteExecution,
  GET as getExecution,
  PATCH as updateExecution,
} from '@/app/api/planned-executions/[id]/route';
import { POST as runExecution } from '@/app/api/planned-executions/[id]/run/route';
import { GET as listExecutionRuns } from '@/app/api/planned-executions/[id]/runs/route';

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ id: 'execution_1' }) };

describe('planned execution Persona trust boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertUnlockedMock.mockResolvedValue(null);
    assertLocalRequestMock.mockReturnValue(null);
    createMock.mockResolvedValue({
      execution: { id: 'execution_1', flowId: 'flow_legacy' },
    });
    getMock.mockResolvedValue({ id: 'execution_1', flowId: 'flow_legacy' });
    updateMock.mockResolvedValue({
      execution: { id: 'execution_1', flowId: 'flow_legacy' },
    });
    deleteMock.mockResolvedValue({ success: true });
    runNowMock.mockResolvedValue({ record: { id: 'run_1', status: 'completed' } });
    listMock.mockResolvedValue([]);
    isPausedMock.mockResolvedValue(false);
    setPausedMock.mockResolvedValue(undefined);
    loadRunRecordsMock.mockResolvedValue([]);
    ensureBackendInitializedMock.mockResolvedValue(undefined);
  });

  it('rejects remote Persona target creation before scheduler mutation', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const response = await createExecution(request('/api/planned-executions', {
      flowId: 'flow_provenance',
      personaId: 'persona_jim',
    }));

    expect(response.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('preserves remote Flow-only creation compatibility', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const body = { flowId: 'flow_legacy' };
    const response = await createExecution(request('/api/planned-executions', body));

    expect(response.status).toBe(201);
    expect(assertLocalRequestMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(body);
  });

  it('guards updates to an existing Persona execution even without target fields', async () => {
    getMock.mockResolvedValue({
      id: 'execution_1',
      flowId: 'flow_provenance',
      personaId: 'persona_jim',
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await updateExecution(
      request('/api/planned-executions/execution_1', { prompt: 'changed' }),
      context,
    );

    expect(response.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('guards Persona run-now while retaining legacy run-now behavior', async () => {
    getMock.mockResolvedValueOnce({
      id: 'execution_1',
      flowId: 'flow_provenance',
      personaId: 'persona_jim',
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const forbidden = await runExecution(
      request('/api/planned-executions/execution_1'),
      context,
    );
    expect(forbidden.status).toBe(403);
    expect(runNowMock).not.toHaveBeenCalled();

    getMock.mockResolvedValueOnce({ id: 'execution_1', flowId: 'flow_legacy' });
    const legacy = await runExecution(
      request('/api/planned-executions/execution_1'),
      context,
    );
    expect(legacy.status).toBe(200);
    expect(runNowMock).toHaveBeenCalledWith('execution_1');
  });

  it('guards deletion of a Persona-targeted execution before mutation', async () => {
    getMock.mockResolvedValue({
      id: 'execution_1',
      flowId: 'flow_provenance',
      personaId: 'persona_jim',
    });
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await deleteExecution(
      request('/api/planned-executions/execution_1'),
      context,
    );

    expect(response.status).toBe(403);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('filters Persona targets from remote lists without initializing or arming them', async () => {
    listMock.mockResolvedValue([
      { execution: { id: 'legacy', flowId: 'flow_legacy' }, status: {}, lastRun: null },
      {
        execution: { id: 'persona', flowId: 'flow_provenance', personaId: 'persona_jim' },
        status: {},
        lastRun: null,
      },
    ]);
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await listExecutions(request('/api/planned-executions'));

    expect(response.status).toBe(200);
    expect((await response.json()).executions).toHaveLength(1);
    expect(ensureBackendInitializedMock).not.toHaveBeenCalled();
  });

  it('guards Persona config, history, and global scheduler mutation', async () => {
    getMock.mockResolvedValue({
      id: 'execution_1',
      flowId: 'flow_provenance',
      personaId: 'persona_jim',
    });
    listMock.mockResolvedValue([{
      execution: { id: 'execution_1', flowId: 'flow_provenance', personaId: 'persona_jim' },
      status: {},
      lastRun: null,
    }]);
    loadRunRecordsMock.mockResolvedValue([{
      runId: 'run_1',
      conversationId: 'conversation_1',
      firedAt: new Date(0).toISOString(),
      status: 'completed',
      triggerSummary: 'test',
      personaId: 'persona_jim',
      activityId: 'activity_1',
      behaviorRevisionId: 'revision_1',
    }]);
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));

    expect((await getExecution(request('/api/planned-executions/execution_1'), context)).status).toBe(403);
    expect((await listExecutionRuns(request('/api/planned-executions/execution_1'), context)).status).toBe(403);
    expect((await pauseExecutions(request('/api/planned-executions', { paused: true }))).status).toBe(403);
    expect(setPausedMock).not.toHaveBeenCalled();
  });
});
