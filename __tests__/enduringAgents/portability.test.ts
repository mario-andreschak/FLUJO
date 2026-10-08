import { buildAgentConfigurationExport } from '@/backend/services/enduringAgents/portability';
import type { Persona, RoleVersion } from '@/shared/types/enduringAgent';
import {
  parsePackage,
  serializePackage,
  type PackagedPersonaTemplate,
  type PackagedRoleTemplate,
} from '@/shared/types/package';
import {
  buildTestRoleDefinition,
  buildTestRoleVersion,
} from './fixtures/personaFactory';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function roleVersion3(): RoleVersion {
  const version = clone(buildTestRoleVersion());
  version.id = 'rolever_portable_v3';
  version.version = 3;
  version.name = 'Portable Role v3';
  version.migrationNotes = 'Review and explicitly repin each Persona.';
  version.createdAt += 1;
  return version;
}

function personaTemplate(roleVersionId: string): PackagedPersonaTemplate {
  return {
    name: 'Jim',
    roleVersionId,
    mission: 'Implement carefully.',
    autonomyLevel: 'propose_overrides',
    interruptionPolicy: 'queue',
  };
}

function portableRole(): PackagedRoleTemplate {
  return {
    definition: clone(buildTestRoleDefinition()),
    versions: [roleVersion3()],
  };
}

describe('Persona configuration-only export', () => {
  it('exports reusable setup without private life, account, or runtime data', () => {
    const definition = buildTestRoleDefinition();
    const version = buildTestRoleVersion();
    const persona = {
      schemaVersion: 1,
      id: 'persona_jim',
      name: 'Jim',
      roleVersionId: version.id,
      lifecycleState: 'idle',
      mission: 'Ship reliable software.',
      autonomyLevel: 'propose_overrides',
      interruptionPolicy: 'queue',
      coreMemoryItemIds: ['memory_private'],
      factoryKeyHash: 'a'.repeat(64),
      provisioningState: 'ready',
      createdAt: 100,
      updatedAt: 100,
      memories: [{ content: 'private biography' }],
      credentials: { token: 'top-secret' },
      conversations: ['conversation-private'],
      accountBindings: ['github-jim'],
      appGrants: ['grant-private'],
      activities: ['activity-private'],
      mailboxItems: ['mail-private'],
      lease: { id: 'lease-private' },
    } as Persona & Record<string, unknown>;

    const exported = buildAgentConfigurationExport({
      roleDefinition: definition,
      roleVersions: [version],
      persona,
    });
    const serialized = JSON.stringify(exported);

    expect(exported.personaTemplates).toEqual([{
      name: 'Jim',
      roleVersionId: version.id,
      mission: 'Ship reliable software.',
      autonomyLevel: 'propose_overrides',
      interruptionPolicy: 'queue',
    }]);
    for (const privateValue of [
      'private biography',
      'top-secret',
      'conversation-private',
      'github-jim',
      'grant-private',
      'activity-private',
      'mail-private',
      'lease-private',
      'memory_private',
    ]) expect(serialized).not.toContain(privateValue);
  });

  it('round-trips the exported Role and Persona setup through a package', () => {
    const role = portableRole();
    const serialized = serializePackage({
      id: 'role-package',
      name: 'Role package',
      version: '1.0.0',
      roleTemplates: [role],
      personaTemplates: [personaTemplate(role.versions[0].id)],
    });
    const parsed = parsePackage(serialized.json);

    expect(parsed.roleTemplates?.[0].versions[0].id).toBe(role.versions[0].id);
    expect(parsed.personaTemplates?.[0].name).toBe('Jim');
  });
});
