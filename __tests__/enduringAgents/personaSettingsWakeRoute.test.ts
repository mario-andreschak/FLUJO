const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();
const updatePersonaSettingsMock = jest.fn();
const pumpPersonaFlowDispatchesMock = jest.fn();
const listPersonaFlowDispatchesMock = jest.fn();
const projectPersonaPresentationMock = jest.fn();
const readPersonaRuntimeSnapshotMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

jest.mock('@/backend/services/enduringAgents', () => ({
  PersonaDeletionConflictError: class extends Error {},
  PersonaDeletionNotFoundError: class extends Error {},
  deletePersona: jest.fn(),
  listPersonaFlowDispatches: (...args: unknown[]) => listPersonaFlowDispatchesMock(...args),
  projectPersonaPresentation: (...args: unknown[]) => projectPersonaPresentationMock(...args),
  readPersonaRuntimeSnapshot: (...args: unknown[]) => readPersonaRuntimeSnapshotMock(...args),
  updatePersonaSettings: (...args: unknown[]) => updatePersonaSettingsMock(...args),
  pumpPersonaFlowDispatches: (...args: unknown[]) => pumpPersonaFlowDispatchesMock(...args),
}));

import { NextRequest } from 'next/server';

import { GET, PATCH } from '@/app/v1/personas/[personaId]/route';

function request(lifecycleState: 'idle' | 'sleeping'): NextRequest {
  return new NextRequest('http://localhost:4200/v1/personas/persona_test', {
    method: 'PATCH',
    headers: { host: 'localhost:4200', 'content-type': 'application/json' },
    body: JSON.stringify({ lifecycleState, expectedUpdatedAt: 10 }),
  });
}

const context = { params: Promise.resolve({ personaId: 'persona_test' }) } as never;

describe('Persona Settings wake behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertLocalRequestMock.mockReturnValue(null);
    assertUnlockedMock.mockResolvedValue(null);
    pumpPersonaFlowDispatchesMock.mockResolvedValue(undefined);
    listPersonaFlowDispatchesMock.mockResolvedValue([]);
  });

  it('starts queued work when the Persona is changed back to Ready', async () => {
    updatePersonaSettingsMock.mockResolvedValue({
      id: 'persona_test',
      lifecycleState: 'idle',
      updatedAt: 11,
    });

    const response = await PATCH(request('idle'), context);

    expect(response.status).toBe(200);
    expect(pumpPersonaFlowDispatchesMock).toHaveBeenCalledWith('persona_test');
  });

  it('does not start the queue while the Persona remains paused', async () => {
    updatePersonaSettingsMock.mockResolvedValue({
      id: 'persona_test',
      lifecycleState: 'sleeping',
      updatedAt: 11,
    });

    const response = await PATCH(request('sleeping'), context);

    expect(response.status).toBe(200);
    expect(pumpPersonaFlowDispatchesMock).not.toHaveBeenCalled();
  });

  it('projects a bounded, readable result without exposing the dispatch record', async () => {
    const bundle = { persona: { id: 'persona_test' } };
    readPersonaRuntimeSnapshotMock.mockResolvedValue({
      bundle,
      runtime: { projection: { active: null } },
    });
    listPersonaFlowDispatchesMock.mockResolvedValue([{
      id: 'private_dispatch_id',
      state: 'completed',
      activityId: 'activity_result',
      admission: { kind: 'assignment' },
      outcome: {
        activityId: 'activity_result',
        status: 'completed',
        outputText: `  Result\nwith   readable spacing ${'x'.repeat(700)}`,
      },
    }, {
      id: 'private_maintenance_id',
      state: 'completed',
      activityId: 'activity_maintenance',
      admission: { kind: 'maintenance' },
      outcome: {
        activityId: 'activity_maintenance',
        status: 'completed',
        outputText: '{"internal":"memory evidence"}',
      },
    }, {
      id: 'private_error_id',
      state: 'error',
      activityId: 'activity_error',
      admission: { kind: 'assignment' },
      outcome: {
        activityId: 'activity_error',
        status: 'error',
        outputText: 'Partial output',
        finalAction: 'ERROR',
      },
    }, {
      id: 'private_final_action_id',
      state: 'completed',
      activityId: 'activity_final_action',
      admission: { kind: 'assignment' },
      outcome: {
        activityId: 'activity_final_action',
        status: 'completed',
        finalAction: 'FINAL_RESPONSE',
      },
    }]);
    projectPersonaPresentationMock.mockReturnValue({ history: [] });

    const response = await GET(new NextRequest(
      'http://localhost:4200/v1/personas/persona_test',
      { headers: { host: 'localhost:4200' } },
    ), context);

    expect(response.status).toBe(200);
    const options = projectPersonaPresentationMock.mock.calls[0]?.[1] as {
      resultByActivityId: Map<string, string>;
    };
    const result = options.resultByActivityId.get('activity_result');
    expect(result).toHaveLength(600);
    expect(result).toMatch(/^Result with readable spacing/);
    expect(result).toMatch(/\.\.\.$/);
    expect([...options.resultByActivityId.keys()]).toEqual(['activity_result']);
    expect(JSON.stringify(await response.json())).not.toContain('private_dispatch_id');
  });
});
