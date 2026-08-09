const listPersonasMock = jest.fn();
const createPersonaFromRoleMock = jest.fn();
const listPersonaBundleMock = jest.fn();
const previewPersonaDeletionMock = jest.fn();
const deletePersonaMock = jest.fn();
const ensureBuiltInDeveloperRoleMock = jest.fn();
const listRoleDefinitionsMock = jest.fn();
const listRoleVersionsMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/enduringAgents', () => {
  class PersonaFactoryConflictError extends Error {}
  class RoleVersionNotFoundError extends Error {
    constructor(readonly roleVersionId: string) {
      super(`RoleVersion ${JSON.stringify(roleVersionId)} not found.`);
    }
  }
  class PersonaDeletionNotFoundError extends Error {}
  class PersonaDeletionConflictError extends Error {}
  return {
    PersonaFactoryConflictError,
    RoleVersionNotFoundError,
    PersonaDeletionNotFoundError,
    PersonaDeletionConflictError,
    listPersonas: (...args: unknown[]) => listPersonasMock(...args),
    createPersonaFromRole: (...args: unknown[]) => createPersonaFromRoleMock(...args),
    listPersonaRuntimeBundle: (...args: unknown[]) => listPersonaBundleMock(...args),
    previewPersonaDeletion: (...args: unknown[]) => previewPersonaDeletionMock(...args),
    deletePersona: (...args: unknown[]) => deletePersonaMock(...args),
    ensureBuiltInDeveloperRole: (...args: unknown[]) => ensureBuiltInDeveloperRoleMock(...args),
    listRoleDefinitions: (...args: unknown[]) => listRoleDefinitionsMock(...args),
    listRoleVersions: (...args: unknown[]) => listRoleVersionsMock(...args),
  };
});

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

import { ZodError } from 'zod';
import {
  PersonaDeletionConflictError,
  PersonaDeletionNotFoundError,
  PersonaFactoryConflictError,
  RoleVersionNotFoundError,
} from '@/backend/services/enduringAgents';
import { GET as listPersonas, POST as createPersona } from '@/app/v1/personas/route';
import { DELETE as deletePersonaRoute, GET as getPersona } from '@/app/v1/personas/[personaId]/route';
import { GET as previewPersonaDeletionRoute } from '@/app/v1/personas/[personaId]/deletion-preview/route';
import { GET as listRoles } from '@/app/v1/roles/route';

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
  ensureBuiltInDeveloperRoleMock.mockResolvedValue({});
  listPersonasMock.mockResolvedValue([]);
  listRoleDefinitionsMock.mockResolvedValue([]);
  listRoleVersionsMock.mockResolvedValue([]);
});

describe('/v1/personas', () => {
  it('lists workspace Personas', async () => {
    listPersonasMock.mockResolvedValue([{ id: 'jim', name: 'Jim' }]);
    const response = await listPersonas(request('/v1/personas') as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'jim', name: 'Jim' }]);
    expect(listPersonasMock).toHaveBeenCalledTimes(1);
  });

  it('creates through the deterministic production factory', async () => {
    const bundle = { persona: { id: 'jim', name: 'Jim' }, behaviorBindings: [] };
    createPersonaFromRoleMock.mockResolvedValue(bundle);
    const body = { name: 'Jim', idempotencyKey: 'create-jim' };
    const response = await createPersona(request('/v1/personas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as never);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(bundle);
    expect(createPersonaFromRoleMock).toHaveBeenCalledWith(body);
  });

  it('returns 400 for schema-invalid input and 409 for an idempotency conflict', async () => {
    createPersonaFromRoleMock.mockRejectedValueOnce(new ZodError([]));
    let response = await createPersona(request('/v1/personas', {
      method: 'POST', body: '{}',
    }) as never);
    expect(response.status).toBe(400);

    createPersonaFromRoleMock.mockRejectedValueOnce(
      new PersonaFactoryConflictError('same key, different request'),
    );
    response = await createPersona(request('/v1/personas', {
      method: 'POST', body: JSON.stringify({ name: 'Sarah' }),
    }) as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'same key, different request' });
  });

  it('returns 404 when the requested RoleVersion does not exist', async () => {
    createPersonaFromRoleMock.mockRejectedValue(
      new RoleVersionNotFoundError('missing-role'),
    );
    const response = await createPersona(request('/v1/personas', {
      method: 'POST', body: JSON.stringify({ name: 'Jim', roleVersionId: 'missing-role' }),
    }) as never);
    expect(response.status).toBe(404);
  });

  it('returns the local-request guard before reading private Persona data', async () => {
    assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
    const response = await listPersonas(request('/v1/personas') as never);
    expect(response.status).toBe(403);
    expect(listPersonasMock).not.toHaveBeenCalled();
  });
});

describe('/v1/personas/[personaId]', () => {
  it('returns a complete inspectable bundle or 404', async () => {
    const bundle = { persona: { id: 'jim' }, memoryItems: [], workItems: [] };
    listPersonaBundleMock.mockResolvedValueOnce(bundle);
    let response = await getPersona(
      request('/v1/personas/jim') as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(bundle);

    listPersonaBundleMock.mockResolvedValueOnce(null);
    response = await getPersona(
      request('/v1/personas/missing') as never,
      { params: Promise.resolve({ personaId: 'missing' }) } as never,
    );
    expect(response.status).toBe(404);
  });

  it('rejects an unsafe Persona id at the route boundary', async () => {
    const response = await getPersona(
      request('/v1/personas/unsafe') as never,
      { params: Promise.resolve({ personaId: '../unsafe' }) } as never,
    );

    expect(response.status).toBe(404);
    expect(listPersonaBundleMock).not.toHaveBeenCalled();
  });

  it('requires a preview-bound explicit deletion confirmation', async () => {
    const body = {
      previewToken: 'a'.repeat(64),
      archivePolicy: 'anonymize',
      confirmation: 'DELETE',
    };
    deletePersonaMock.mockResolvedValue({ id: 'deletion_1', status: 'completed' });
    const response = await deletePersonaRoute(
      request('/v1/personas/jim', {
        method: 'DELETE',
        body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );

    expect(response.status).toBe(200);
    expect(deletePersonaMock).toHaveBeenCalledWith('jim', body);
  });

  it('maps missing and stale deletion previews without deleting anything implicitly', async () => {
    deletePersonaMock.mockRejectedValueOnce(new PersonaDeletionNotFoundError('missing'));
    let response = await deletePersonaRoute(
      request('/v1/personas/missing', { method: 'DELETE', body: '{}' }) as never,
      { params: Promise.resolve({ personaId: 'missing' }) } as never,
    );
    expect(response.status).toBe(404);

    deletePersonaMock.mockRejectedValueOnce(new PersonaDeletionConflictError('jim', 'stale'));
    response = await deletePersonaRoute(
      request('/v1/personas/jim', { method: 'DELETE', body: '{}' }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(409);
  });
});

describe('/v1/personas/[personaId]/deletion-preview', () => {
  it('returns the privacy manifest before deletion', async () => {
    const preview = { personaId: 'jim', previewToken: 'b'.repeat(64), counts: {} };
    previewPersonaDeletionMock.mockResolvedValue(preview);
    const response = await previewPersonaDeletionRoute(
      request('/v1/personas/jim/deletion-preview') as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(preview);
  });
});

describe('/v1/roles', () => {
  it('seeds Developer v1 before listing workspace Role records', async () => {
    listRoleDefinitionsMock.mockResolvedValue([{ id: 'role_builtin_developer' }]);
    listRoleVersionsMock.mockResolvedValue([{ id: 'rolever_builtin_developer_v1' }]);
    const response = await listRoles(request('/v1/roles') as never);

    expect(response.status).toBe(200);
    expect(ensureBuiltInDeveloperRoleMock).toHaveBeenCalledTimes(1);
    expect(await response.json()).toEqual({
      roleDefinitions: [{ id: 'role_builtin_developer' }],
      roleVersions: [{ id: 'rolever_builtin_developer_v1' }],
    });
  });
});
