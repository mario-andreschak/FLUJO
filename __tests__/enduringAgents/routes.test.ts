const listPersonasMock = jest.fn();
const createPersonaFromRoleMock = jest.fn();
const listPersonaFlowDispatchesMock = jest.fn();
const readPersonaRuntimeSnapshotMock = jest.fn();
const listPersonaFlowDispatchesMock = jest.fn();
const pumpPersonaFlowDispatchesMock = jest.fn();
const projectPersonaPresentationMock = jest.fn();
const inspectPersonaRuntimeMock = jest.fn();
const recoverPersonaRuntimeMock = jest.fn();
const previewPersonaDeletionMock = jest.fn();
const deletePersonaMock = jest.fn();
const updatePersonaSettingsMock = jest.fn();
const activatePersonaBehaviorRevisionMock = jest.fn();
const listRoleDefinitionsMock = jest.fn();
const listRoleVersionsMock = jest.fn();
const listPublicRolesMock = jest.fn();
const createPublicRoleMock = jest.fn();
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
  class PersonaRuntimeCorruptionError extends Error {}
  class PersonaRuntimeNotFoundError extends Error {}
  class PersonaRuntimeRecoveryConflictError extends Error {}
  class PersonaRuntimeUnavailableError extends Error {}
  class RoleAdminNotFoundError extends Error {}
  class RoleAdminConflictError extends Error {}
  return {
    PersonaFactoryConflictError,
    RoleVersionNotFoundError,
    PersonaDeletionNotFoundError,
    PersonaDeletionConflictError,
    PersonaRuntimeCorruptionError,
    PersonaRuntimeNotFoundError,
    PersonaRuntimeRecoveryConflictError,
    PersonaRuntimeUnavailableError,
    RoleAdminNotFoundError,
    RoleAdminConflictError,
    listPersonas: (...args: unknown[]) => listPersonasMock(...args),
    createPersonaFromRole: (...args: unknown[]) => createPersonaFromRoleMock(...args),
    listPersonaFlowDispatches: (...args: unknown[]) => listPersonaFlowDispatchesMock(...args),
    readPersonaRuntimeSnapshot: (...args: unknown[]) => readPersonaRuntimeSnapshotMock(...args),
    listPersonaFlowDispatches: (...args: unknown[]) => listPersonaFlowDispatchesMock(...args),
    pumpPersonaFlowDispatches: (...args: unknown[]) => pumpPersonaFlowDispatchesMock(...args),
    projectPersonaPresentation: (...args: unknown[]) => projectPersonaPresentationMock(...args),
    inspectAndReconcilePersonaRuntime: (...args: unknown[]) => inspectPersonaRuntimeMock(...args),
    recoverPersonaRuntime: (...args: unknown[]) => recoverPersonaRuntimeMock(...args),
    previewPersonaDeletion: (...args: unknown[]) => previewPersonaDeletionMock(...args),
    deletePersona: (...args: unknown[]) => deletePersonaMock(...args),
    updatePersonaSettings: (...args: unknown[]) => updatePersonaSettingsMock(...args),
    activatePersonaBehaviorRevision: (...args: unknown[]) => activatePersonaBehaviorRevisionMock(...args),
    listRoleDefinitions: (...args: unknown[]) => listRoleDefinitionsMock(...args),
    listRoleVersions: (...args: unknown[]) => listRoleVersionsMock(...args),
    listPublicRoles: (...args: unknown[]) => listPublicRolesMock(...args),
    createPublicRole: (...args: unknown[]) => createPublicRoleMock(...args),
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
import { DELETE as deletePersonaRoute, GET as getPersona, PATCH as updatePersonaRoute } from '@/app/v1/personas/[personaId]/route';
import { POST as activatePersonaBehaviorRoute } from '@/app/v1/personas/[personaId]/behaviors/[behaviorId]/activate/route';
import { GET as previewPersonaDeletionRoute } from '@/app/v1/personas/[personaId]/deletion-preview/route';
import { POST as recoverPersonaRuntimeRoute } from '@/app/v1/personas/[personaId]/runtime-recovery/route';
import { GET as listRoles, POST as createRole } from '@/app/v1/roles/route';

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost${path}`, init);

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
  listPersonasMock.mockResolvedValue([]);
  listPersonaFlowDispatchesMock.mockResolvedValue([]);
  listRoleDefinitionsMock.mockResolvedValue([]);
  listRoleVersionsMock.mockResolvedValue([]);
  listPublicRolesMock.mockResolvedValue([]);
  readPersonaRuntimeSnapshotMock.mockResolvedValue(null);
  listPersonaFlowDispatchesMock.mockResolvedValue([]);
  pumpPersonaFlowDispatchesMock.mockResolvedValue(undefined);
  projectPersonaPresentationMock.mockReturnValue(null);
  inspectPersonaRuntimeMock.mockResolvedValue({ projection: { stuck: false }, recentEvents: [] });
  recoverPersonaRuntimeMock.mockResolvedValue({
    personaId: 'jim',
    changed: true,
    lifecycleState: 'idle',
    closedActivityIds: [],
    rejectedMailboxItemIds: [],
    requeuedMailboxItemIds: [],
  });
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
    const body = {
      name: 'Jim',
      roleVersionId: 'rolever_researcher_v1',
      idempotencyKey: 'create-jim',
    };
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
    const runtime = { projection: { stuck: false, active: null }, recentEvents: [] };
    const presentation = {
      conversations: [],
      tasks: [],
      history: [],
      current: null,
      queuedInputCount: 0,
    };
    readPersonaRuntimeSnapshotMock.mockResolvedValueOnce({ bundle, runtime });
    projectPersonaPresentationMock.mockReturnValueOnce(presentation);
    let response = await getPersona(
      request('/v1/personas/jim') as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...bundle, runtime, presentation });
    expect(readPersonaRuntimeSnapshotMock).toHaveBeenCalledWith('jim');
    expect(listPersonaFlowDispatchesMock).toHaveBeenCalledWith('jim');
    expect(projectPersonaPresentationMock).toHaveBeenCalledWith(bundle, {
      activeActivityId: undefined,
      resultByActivityId: new Map(),
    });

    readPersonaRuntimeSnapshotMock.mockResolvedValueOnce(null);
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
    expect(readPersonaRuntimeSnapshotMock).not.toHaveBeenCalled();
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

  it('updates inspectable Persona settings through the guarded admin service', async () => {
    updatePersonaSettingsMock.mockResolvedValue({ id: 'jim', name: 'Jim Rivera' });
    const body = { name: 'Jim Rivera', expectedUpdatedAt: 10 };
    const response = await updatePersonaRoute(
      request('/v1/personas/jim', { method: 'PATCH', body: JSON.stringify(body) }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(updatePersonaSettingsMock).toHaveBeenCalledWith('jim', body);
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

describe('/v1/personas/[personaId]/behaviors/[behaviorId]/activate', () => {
  it('activates an inspected immutable revision through compare-and-swap', async () => {
    const body = { revisionId: 'behaviorrev_2', expectedActiveRevisionId: 'behaviorrev_1' };
    activatePersonaBehaviorRevisionMock.mockResolvedValue({
      binding: { id: 'behavior_1', activeRevisionId: 'behaviorrev_2' },
      revision: { id: 'behaviorrev_2' },
    });
    const response = await activatePersonaBehaviorRoute(
      request('/v1/personas/jim/behaviors/behavior_1/activate', {
        method: 'POST', body: JSON.stringify(body),
      }) as never,
      { params: Promise.resolve({ personaId: 'jim', behaviorId: 'behavior_1' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(activatePersonaBehaviorRevisionMock).toHaveBeenCalledWith('jim', 'behavior_1', body);
  });
});

describe('/v1/personas/[personaId]/runtime-recovery', () => {
  it('requires local access and exact confirmation before an audited recovery', async () => {
    assertLocalRequestMock.mockReturnValueOnce(new Response('forbidden', { status: 403 }));
    let response = await recoverPersonaRuntimeRoute(
      request('/v1/personas/jim/runtime-recovery', {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'RECOVER' }),
      }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(403);
    expect(recoverPersonaRuntimeMock).not.toHaveBeenCalled();

    recoverPersonaRuntimeMock.mockRejectedValueOnce(new ZodError([]));
    response = await recoverPersonaRuntimeRoute(
      request('/v1/personas/jim/runtime-recovery', {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'WRONG' }),
      }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(400);

    response = await recoverPersonaRuntimeRoute(
      request('/v1/personas/jim/runtime-recovery', {
        method: 'POST',
        body: JSON.stringify({ confirmation: 'RECOVER' }),
      }) as never,
      { params: Promise.resolve({ personaId: 'jim' }) } as never,
    );
    expect(response.status).toBe(200);
    expect(recoverPersonaRuntimeMock).toHaveBeenLastCalledWith({
      personaId: 'jim',
      confirmation: 'RECOVER',
    });
    expect(await response.json()).toMatchObject({
      recovery: { changed: true, lifecycleState: 'idle' },
      runtime: { projection: { stuck: false } },
    });
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
  it('lists only the Role records already present in the workspace', async () => {
    listRoleDefinitionsMock.mockResolvedValue([{
      id: 'role_researcher',
      currentVersionId: 'rolever_researcher_v1',
    }]);
    listRoleVersionsMock.mockResolvedValue([{
      id: 'rolever_researcher_v1',
      roleDefinitionId: 'role_researcher',
      version: 1,
    }]);
    listPublicRolesMock.mockResolvedValue([{
      id: 'role_researcher',
      name: 'Researcher',
      prompt: 'Investigate carefully.',
      suggestedApps: [],
      archived: false,
      currentVersionId: 'rolever_researcher_v1',
      createdAt: 1,
      updatedAt: 1,
    }]);
    const roleRequest = request('/v1/roles');
    const response = await listRoles(roleRequest as never);

    expect(response.status).toBe(200);
    expect(assertLocalRequestMock).toHaveBeenCalledWith(roleRequest);
    expect(await response.json()).toEqual({
      roleDefinitions: [{
        id: 'role_researcher',
        currentVersionId: 'rolever_researcher_v1',
      }],
      roleVersions: [{
        id: 'rolever_researcher_v1',
        roleDefinitionId: 'role_researcher',
        version: 1,
      }],
      roles: [{
        id: 'role_researcher',
        name: 'Researcher',
        prompt: 'Investigate carefully.',
        suggestedApps: [],
        archived: false,
        currentVersionId: 'rolever_researcher_v1',
        createdAt: 1,
        updatedAt: 1,
      }],
    });
  });

  it('keeps compatibility records aligned when archived Roles are requested', async () => {
    listRoleDefinitionsMock.mockResolvedValue([
      { id: 'role_active' },
      { id: 'role_archived', archivedAt: 10 },
    ]);
    listRoleVersionsMock.mockResolvedValue([
      { id: 'rolever_active', roleDefinitionId: 'role_active' },
      { id: 'rolever_archived', roleDefinitionId: 'role_archived' },
    ]);
    listPublicRolesMock.mockResolvedValue([
      { id: 'role_active', archived: false },
      { id: 'role_archived', archived: true, archivedAt: 10 },
    ]);

    const response = await listRoles(request('/v1/roles?includeArchived=true') as never);

    expect(response.status).toBe(200);
    expect(listPublicRolesMock).toHaveBeenCalledWith({ includeArchived: true });
    expect(await response.json()).toEqual({
      roleDefinitions: [
        { id: 'role_active' },
        { id: 'role_archived', archivedAt: 10 },
      ],
      roleVersions: [
        { id: 'rolever_active', roleDefinitionId: 'role_active' },
        { id: 'rolever_archived', roleDefinitionId: 'role_archived' },
      ],
      roles: [
        { id: 'role_active', archived: false },
        { id: 'role_archived', archived: true, archivedAt: 10 },
      ],
    });
  });

  it('creates a simple public Role without accepting internal Role fields', async () => {
    const body = {
      name: 'Researcher',
      prompt: 'Investigate the question and cite evidence.',
      suggestedApps: [{ mcpServerName: 'search' }],
    };
    createPublicRoleMock.mockResolvedValue({ id: 'role_researcher', ...body });

    const response = await createRole(request('/v1/roles', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as never);

    expect(response.status).toBe(201);
    expect(createPublicRoleMock).toHaveBeenCalledWith(body);
    expect(await response.json()).toEqual({ id: 'role_researcher', ...body });
  });
});
