import {
  buildAgentConfigurationExport,
  buildBuiltInDeveloperRoleDefinition,
  buildBuiltInDeveloperRoleVersion,
  createRolePersonaDraft,
  generateRolePersonaDraft,
  materializeReviewedRoleDraft,
  planRolePackageImport,
  resolveRoleCapabilities,
  reviewRolePersonaDraft,
} from '@/backend/services/enduringAgents';
import type { Persona, RoleVersion } from '@/shared/types/enduringAgent';
import {
  flujoPackageSchema,
  parsePackage,
  serializePackage,
  type FlujoPackage,
  type PackagedPersonaTemplate,
  type PackagedRoleTemplate,
} from '@/shared/types/package';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function roleVersion3(): RoleVersion {
  const version = clone(buildBuiltInDeveloperRoleVersion());
  version.id = 'rolever_developer_v3_portable';
  version.version = 3;
  version.name = 'Developer v3';
  version.migrationNotes = 'Review and explicitly repin each Persona.';
  version.behaviorSlots[0].flowTemplate.nodes.push({
    id: 'github-binding',
    type: 'mcp',
    position: { x: 0, y: 200 },
    data: {
      label: 'GitHub binding',
      type: 'mcp',
      properties: {
        boundServer: 'github-jim',
        enabledTools: ['read_issue'],
      },
    },
  });
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

function portableRole(versions = [roleVersion3()]): PackagedRoleTemplate {
  return {
    definition: clone(buildBuiltInDeveloperRoleDefinition()),
    versions: clone(versions),
  };
}

function basePackage(roleTemplates?: PackagedRoleTemplate[]): FlujoPackage {
  return flujoPackageSchema.parse({
    schemaVersion: 1,
    id: 'portable-developer',
    name: 'Portable Developer',
    version: '1.0.0',
    secrets: [],
    models: [],
    mcpServers: [],
    flows: [],
    plannedExecutions: [],
    roleTemplates,
    personaTemplates: roleTemplates
      ? [personaTemplate(roleTemplates[0].versions.at(-1)!.id)]
      : undefined,
  }) as unknown as FlujoPackage;
}

describe('Phase 8 reviewed AI Role/Persona drafts', () => {
  it('passes privacy/tool-authority constraints to AI and keeps output inert until review', async () => {
    const role = portableRole();
    let constraints: readonly string[] = [];
    const draft = await generateRolePersonaDraft({
      id: 'draft-1',
      request: 'Create a meticulous TypeScript developer named Jim',
      now: 10,
      generate: async (input) => {
        constraints = input.constraints;
        return {
          personaTemplate: personaTemplate(role.versions[0].id),
          roleTemplate: role,
          suggestedMcpServers: ['github-jim'],
        };
      },
    });

    expect(constraints.join(' ')).toMatch(/biography|memory/i);
    expect(constraints.join(' ')).toMatch(/account|credential/i);
    expect(constraints.join(' ')).toMatch(/boundServer|enabledTools/i);
    expect(draft.status).toBe('pending_review');
    expect(() => materializeReviewedRoleDraft(draft)).toThrow(/approval/i);

    const approved = reviewRolePersonaDraft(draft, {
      decision: 'approve',
      reviewedBy: 'workspace-owner',
      expectedDigest: draft.contentDigest,
      now: 11,
    });
    const materialized = materializeReviewedRoleDraft(approved);
    expect(materialized.personaTemplate.name).toBe('Jim');
    expect(materialized.roleTemplate?.versions[0].id).toBe(role.versions[0].id);
  });

  it('rejects AI proposals that try to include memory or account state', () => {
    const role = portableRole();
    expect(() => createRolePersonaDraft({
      id: 'draft-private',
      request: 'Create Jim',
      proposal: {
        personaTemplate: {
          ...personaTemplate(role.versions[0].id),
          memories: [{ content: 'Invented biography' }],
          accountBindings: [{ server: 'github-jim', token: 'secret' }],
        },
        roleTemplate: role,
      },
    })).toThrow();
  });

  it('does not permit a second decision on an already reviewed draft', () => {
    const draft = createRolePersonaDraft({
      id: 'draft-once',
      request: 'Create Jim',
      proposal: { personaTemplate: personaTemplate('existing-role-version') },
      now: 1,
    });
    const rejected = reviewRolePersonaDraft(draft, {
      decision: 'reject',
      reviewedBy: 'reviewer',
      expectedDigest: draft.contentDigest,
      now: 2,
    });
    expect(() => reviewRolePersonaDraft(rejected, {
      decision: 'approve',
      reviewedBy: 'reviewer',
      expectedDigest: rejected.contentDigest,
    })).toThrow(/pending/i);
  });

  it('binds review to the exact generated content digest', () => {
    const draft = createRolePersonaDraft({
      id: 'draft-digest',
      request: 'Create Jim',
      proposal: { personaTemplate: personaTemplate('existing-role-version') },
    });
    draft.proposal.personaTemplate.mission = 'Changed after the reviewer opened it.';
    expect(() => reviewRolePersonaDraft(draft, {
      decision: 'approve',
      reviewedBy: 'reviewer',
      expectedDigest: draft.contentDigest,
    })).toThrow(/changed/i);
  });
});

describe('Phase 8 configuration-only packaging', () => {
  it('exports only reusable Persona configuration and excludes private life/account data', () => {
    const definition = buildBuiltInDeveloperRoleDefinition();
    const version = buildBuiltInDeveloperRoleVersion();
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
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('round-trips additive Role/Behavior templates while legacy Flow-only v1 packages stay valid', () => {
    const role = portableRole();
    const behaviorTemplate = {
      id: 'behavior-template-review',
      ...clone(role.versions[0].behaviorSlots[0]),
    };
    const serialized = serializePackage({
      id: 'role-package',
      name: 'Role package',
      version: '1.0.0',
      roleTemplates: [role],
      behaviorTemplates: [behaviorTemplate],
      personaTemplates: [personaTemplate(role.versions[0].id)],
    });
    const parsed = parsePackage(serialized.json);

    expect(parsed.roleTemplates?.[0].versions[0].capabilityRequirements)
      .toEqual(role.versions[0].capabilityRequirements);
    expect(parsed.behaviorTemplates?.[0].flowTemplate)
      .toEqual(behaviorTemplate.flowTemplate);

    const legacy = parsePackage(JSON.stringify({
      schemaVersion: 1,
      id: 'legacy',
      name: 'Legacy',
      version: '1.0.0',
      secrets: [],
      models: [],
      mcpServers: [],
      flows: [],
      plannedExecutions: [],
    }));
    expect(legacy.roleTemplates).toBeUndefined();
    expect(legacy.behaviorTemplates).toBeUndefined();
  });

  it('rejects duplicate immutable Role version coordinates inside a package', () => {
    const v2 = buildBuiltInDeveloperRoleVersion();
    const duplicateV2 = clone(v2);
    duplicateV2.id = 'rolever_developer_duplicate_v2';

    const result = flujoPackageSchema.safeParse({
      ...basePackage(),
      roleTemplates: [portableRole([v2, duplicateV2])],
      personaTemplates: [personaTemplate(v2.id)],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message).join(' '))
        .toMatch(/duplicate immutable Role version|version coordinate/i);
    }
  });

  it('rejects Persona-template private fields and broken Role references', () => {
    const role = portableRole();
    const raw = {
      ...basePackage([role]),
      personaTemplates: [{
        ...personaTemplate('rolever_missing'),
        credentials: { token: 'secret' },
      }],
    };
    const result = flujoPackageSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

describe('Phase 8 capability and import planning', () => {
  it('makes missing and ambiguous bindings explicit without changing Flow tool bindings', () => {
    const version = roleVersion3();
    const originalFlow = clone(version.behaviorSlots[0].flowTemplate);
    const unresolved = resolveRoleCapabilities({
      requirements: {
        semantic: ['source-control.read-write', 'shell.compile-test', 'filesystem.workspace'],
        preferredMcpServers: ['github-jim'],
      },
      providers: [
        { name: 'github-jim', capabilities: ['source-control.read-write'] },
        { name: 'shell-a', capabilities: ['shell.compile-test'] },
        { name: 'shell-b', capabilities: ['shell.compile-test'] },
      ],
    });

    expect(unresolved.recommendations['source-control.read-write']).toBe('github-jim');
    expect(unresolved.ambiguous).toEqual([{
      capability: 'shell.compile-test',
      providers: ['shell-a', 'shell-b'],
    }]);
    expect(unresolved.missing).toEqual(['filesystem.workspace']);
    expect(unresolved.ready).toBe(false);
    expect(version.behaviorSlots[0].flowTemplate).toEqual(originalFlow);

    const resolved = resolveRoleCapabilities({
      requirements: { semantic: ['shell.compile-test'] },
      providers: [
        { name: 'shell-a', capabilities: ['shell.compile-test'] },
        { name: 'shell-b', capabilities: ['shell.compile-test'] },
      ],
      selectedBindings: { 'shell.compile-test': 'shell-b' },
    });
    expect(resolved.ready).toBe(true);
    expect(resolved.selectedBindings).toEqual({ 'shell.compile-test': 'shell-b' });
  });

  it('reports collisions and upgrades while leaving existing Personas explicitly pinned', () => {
    const definition = buildBuiltInDeveloperRoleDefinition();
    const v2 = buildBuiltInDeveloperRoleVersion();
    const v3 = roleVersion3();
    const pkg = basePackage([portableRole([v2, v3])]);

    const plan = planRolePackageImport({
      package: pkg,
      existingRoleDefinitions: [definition],
      existingRoleVersions: [v2],
      existingPersonas: [{ id: 'persona_jim', roleVersionId: v2.id }],
      providers: [
        {
          name: 'portable-provider',
          capabilities: v3.capabilityRequirements?.semantic ?? [],
        },
      ],
    });

    expect(plan.collisions.map((collision) => collision.kind)).toEqual(
      expect.arrayContaining(['role_definition', 'role_version_id', 'behavior_slot']),
    );
    expect(plan.flowBindingRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        templateId: `${v3.id}:${v3.behaviorSlots[0].key}`,
        requiredServerNames: ['github-jim'],
        missingServerNames: ['github-jim'],
      }),
    ]));
    expect(plan.upgrades).toEqual([{
      personaId: 'persona_jim',
      roleDefinitionId: definition.id,
      fromRoleVersionId: v2.id,
      toRoleVersionId: v3.id,
      requiresExplicitRepin: true,
    }]);
    expect(plan.personasRemainPinned).toBe(true);
    expect(plan.readyToImport).toBe(false);
  });
});
