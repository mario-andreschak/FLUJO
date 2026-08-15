import type {
  Persona,
  RoleDefinition,
  RoleVersion,
} from '@/shared/types/enduringAgent';

const loadServerConfigsMock = jest.fn();
const definitions = new Map<string, RoleDefinition>();
const versions = new Map<string, RoleVersion>();
let personas: Persona[] = [];
let generatedIds: string[] = [];

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: (...args: unknown[]) => loadServerConfigsMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withRoleDefinitionRuntimeLock: async (
    _roleId: string,
    task: () => Promise<unknown>,
  ) => task(),
}));

jest.mock('@/backend/services/enduringAgents/ids', () => ({
  randomEnduringAgentId: () => {
    const id = generatedIds.shift();
    if (!id) throw new Error('Test did not provide a generated id.');
    return id;
  },
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getRoleDefinition: async (id: string) => definitions.get(id) ?? null,
  listRoleDefinitionsStrict: async () => [...definitions.values()],
  saveRoleDefinition: async (record: RoleDefinition) => {
    definitions.set(record.id, record);
    return record;
  },
  listRoleVersionsStrict: async (roleId?: string) => [...versions.values()]
    .filter((record) => roleId === undefined || record.roleDefinitionId === roleId),
  createRoleVersion: async (record: RoleVersion) => {
    versions.set(record.id, record);
    return record;
  },
  deleteRoleVersionRecord: async (id: string) => {
    versions.delete(id);
  },
  deleteRoleDefinitionRecord: async (id: string) => {
    definitions.delete(id);
  },
  listPersonasStrict: async () => personas,
}));

import {
  RoleAdminConflictError,
  archivePublicRole,
  createPublicRole,
  hardDeletePublicRole,
  listPublicRoleVersions,
  previewRoleImpact,
  updatePublicRole,
} from '@/backend/services/enduringAgents/roleAdmin';

beforeEach(() => {
  definitions.clear();
  versions.clear();
  personas = [];
  generatedIds = [];
  loadServerConfigsMock.mockReset();
  loadServerConfigsMock.mockResolvedValue([
    {
      name: 'search',
      transport: 'stdio',
      command: 'search',
      disabled: false,
      enableMcpApps: true,
    },
  ]);
});

describe('Role administration', () => {
  it('creates a strict public Role and resolves only workspace-local App references', async () => {
    generatedIds = ['rolever_researcher_v1'];

    const role = await createPublicRole({
      id: 'role_researcher',
      name: '  Researcher  ',
      prompt: '  Investigate the question and cite evidence.  ',
      suggestedApps: [
        { mcpServerName: 'search' },
        { mcpServerName: 'not-installed' },
      ],
    });

    expect(role).toMatchObject({
      id: 'role_researcher',
      name: 'Researcher',
      prompt: 'Investigate the question and cite evidence.',
      suggestedApps: [
        { mcpServerName: 'search', status: 'available' },
        { mcpServerName: 'not-installed', status: 'missing' },
      ],
      behaviors: [
        expect.objectContaining({ key: 'primary', name: 'Primary' }),
        expect.objectContaining({ key: 'maintain_memory', name: 'Maintain memory' }),
      ],
      archived: false,
      currentVersionId: 'rolever_researcher_v1',
    });
    expect(Object.keys(role).sort()).toEqual([
      'archived',
      'behaviors',
      'createdAt',
      'currentVersionId',
      'id',
      'name',
      'prompt',
      'suggestedApps',
      'updatedAt',
    ]);
    expect(versions.get('rolever_researcher_v1')).toMatchObject({
      roleDefinitionId: 'role_researcher',
      version: 1,
      mission: 'Investigate the question and cite evidence.',
    });
    expect(versions.get('rolever_researcher_v1')?.behaviorSlots.map((slot) => slot.key))
      .toEqual(['primary', 'maintain_memory']);
  });

  it('rejects internal or credential-adjacent public input fields', async () => {
    await expect(createPublicRole({
      id: 'role_unsafe',
      name: 'Unsafe',
      prompt: 'Do work.',
      behaviorSlots: [],
      headers: { authorization: 'secret' },
    })).rejects.toBeDefined();
    expect(definitions.size).toBe(0);
    expect(versions.size).toBe(0);
  });

  it('creates immutable versions, rejects stale saves, and leaves Persona pins unchanged', async () => {
    generatedIds = ['rolever_writer_v1'];
    const created = await createPublicRole({
      id: 'role_writer',
      name: 'Writer',
      prompt: 'Write clearly.',
    });
    personas = [{
      schemaVersion: 2,
      id: 'persona_writer',
      name: 'Pinned writer',
      roleVersionId: created.currentVersionId,
      lifecycleState: 'idle',
      autonomyLevel: 'locked',
      interruptionPolicy: 'queue',
      createdAt: 1,
      updatedAt: 1,
    }];
    generatedIds = ['rolever_writer_v2'];

    const updated = await updatePublicRole('role_writer', {
      expectedCurrentVersionId: created.currentVersionId,
      prompt: 'Write clearly and concisely.',
    });

    expect(updated.currentVersionId).toBe('rolever_writer_v2');
    expect(versions.get(created.currentVersionId)?.mission).toBe('Write clearly.');
    expect(personas[0].roleVersionId).toBe(created.currentVersionId);
    await expect(updatePublicRole('role_writer', {
      expectedCurrentVersionId: created.currentVersionId,
      prompt: 'Stale overwrite.',
    })).rejects.toMatchObject({
      code: 'ROLE_ADMIN_CONFLICT',
      details: { reason: 'STALE_CURRENT_VERSION' },
    });
    await expect(listPublicRoleVersions('role_writer')).resolves.toEqual([
      expect.objectContaining({ id: 'rolever_writer_v2', current: true }),
      expect.objectContaining({ id: 'rolever_writer_v1', current: false }),
    ]);
  });

  it('previews Persona impact, blocks hard deletion, and archives safely', async () => {
    generatedIds = ['rolever_support_v1'];
    const role = await createPublicRole({
      id: 'role_support',
      name: 'Support',
      prompt: 'Help the user.',
    });
    personas = [{
      schemaVersion: 2,
      id: 'persona_support',
      name: 'Support Persona',
      roleVersionId: role.currentVersionId,
      lifecycleState: 'idle',
      autonomyLevel: 'locked',
      interruptionPolicy: 'queue',
      createdAt: 1,
      updatedAt: 1,
    }];

    await expect(previewRoleImpact('role_support')).resolves.toEqual({
      roleId: 'role_support',
      personaIds: ['persona_support'],
      personaCount: 1,
      pinnedRoleVersionIds: [role.currentVersionId],
      hardDeleteAllowed: false,
      safeAction: 'archive',
    });
    await expect(hardDeletePublicRole('role_support', {
      action: 'delete',
      expectedCurrentVersionId: role.currentVersionId,
    })).rejects.toBeInstanceOf(RoleAdminConflictError);

    const archived = await archivePublicRole('role_support', {
      action: 'archive',
      expectedCurrentVersionId: role.currentVersionId,
    });
    expect(archived.archived).toBe(true);
    expect(versions.has(role.currentVersionId)).toBe(true);
  });

  it('hard-deletes an unreferenced Role without reserving product-defined identities', async () => {
    generatedIds = ['rolever_temporary_v1'];
    const role = await createPublicRole({
      id: 'role_temporary',
      name: 'Temporary',
      prompt: 'Complete a temporary task.',
    });

    await hardDeletePublicRole('role_temporary', {
      action: 'delete',
      expectedCurrentVersionId: role.currentVersionId,
    });
    expect(definitions.has('role_temporary')).toBe(false);
    expect(versions.size).toBe(0);
  });
});
