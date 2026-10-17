const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();
const controlPersonaWorkItemMock = jest.fn();

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
    verbose: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/backend/services/enduringAgents', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents');
  return {
    ...actual,
    controlPersonaWorkItem: (...args: unknown[]) => controlPersonaWorkItemMock(...args),
  };
});

import { NextRequest, NextResponse } from 'next/server';

import { POST } from '@/app/v1/personas/[personaId]/work-items/[workItemId]/control/route';
import { PersonaDomainConflictError, PersonaDomainNotFoundError } from '@/backend/services/enduringAgents';

function request(action: string, extra: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(
    'http://localhost:4200/v1/personas/persona_test/work-items/work_test/control',
    {
      method: 'POST',
      headers: { host: 'localhost:4200', 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra }),
    },
  );
}

function context(personaId = 'persona_test', workItemId = 'work_test') {
  return { params: Promise.resolve({ personaId, workItemId }) } as never;
}

describe('Persona Task control route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertLocalRequestMock.mockReturnValue(null);
    assertUnlockedMock.mockResolvedValue(null);
    controlPersonaWorkItemMock.mockImplementation(async (
      personaId: string,
      workItemId: string,
      action: string,
    ) => ({ action, workItem: { id: workItemId, personaId } }));
  });

  it.each(['pause', 'stop', 'retry', 'move_earlier', 'move_later'] as const)(
    'accepts the plain %s control and keeps it Persona scoped',
    async (action) => {
      const response = await POST(request(action), context());

      expect(response.status).toBe(200);
      expect(controlPersonaWorkItemMock).toHaveBeenCalledWith(
        'persona_test',
        'work_test',
        action,
      );
    },
  );

  it('rejects unknown controls without reaching the service', async () => {
    const response = await POST(request('rewind'), context());

    expect(response.status).toBe(400);
    expect(controlPersonaWorkItemMock).not.toHaveBeenCalled();
  });

  it('forwards an exact optional Goal fence and prevents caching the result', async () => {
    const response = await POST(request('retry', { expectedUpdatedAt: 100 }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(controlPersonaWorkItemMock).toHaveBeenCalledWith(
      'persona_test', 'work_test', 'retry', { expectedUpdatedAt: 100 },
    );
  });

  it.each([null, true, '100', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid supplied Goal version %s before the service', async (expectedUpdatedAt) => {
      const response = await POST(request('pause', { expectedUpdatedAt }), context());
      expect(response.status).toBe(400);
      expect(controlPersonaWorkItemMock).not.toHaveBeenCalled();
    },
  );

  it('returns a stale Goal conflict without rebasing the caller', async () => {
    controlPersonaWorkItemMock.mockRejectedValueOnce(new PersonaDomainConflictError(
      'The Goal changed.', 'PERSONA_GOAL_CONTROL_VERSION_CONFLICT',
    ));
    const response = await POST(request('retry', { expectedUpdatedAt: 100 }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'PERSONA_GOAL_CONTROL_VERSION_CONFLICT' });
    expect(controlPersonaWorkItemMock).toHaveBeenCalledTimes(1);
  });

  it('rejects the hidden resume synonym in favor of the single Resume or retry action', async () => {
    const response = await POST(request('resume'), context());

    expect(response.status).toBe(400);
    expect(controlPersonaWorkItemMock).not.toHaveBeenCalled();
  });

  it('returns 404 for invalid or foreign Task ids', async () => {
    const invalid = await POST(request('pause'), context('../persona', 'work_test'));
    expect(invalid.status).toBe(404);

    controlPersonaWorkItemMock.mockRejectedValueOnce(
      new PersonaDomainNotFoundError('PersonaWorkItem', 'work_foreign'),
    );
    const foreign = await POST(request('pause'), context('persona_test', 'work_foreign'));
    expect(foreign.status).toBe(404);
  });

  it('keeps local and unlock guards ahead of Task mutation', async () => {
    assertLocalRequestMock.mockReturnValueOnce(
      NextResponse.json({ error: 'Local only.' }, { status: 403 }),
    );
    const notLocal = await POST(request('pause'), context());
    expect(notLocal.status).toBe(403);
    expect(assertUnlockedMock).not.toHaveBeenCalled();

    assertLocalRequestMock.mockReturnValueOnce(null);
    assertUnlockedMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'Locked.' }, { status: 423 }),
    );
    const locked = await POST(request('pause'), context());
    expect(locked.status).toBe(423);
    expect(controlPersonaWorkItemMock).not.toHaveBeenCalled();
  });
});
