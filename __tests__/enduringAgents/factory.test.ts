import {
  buildBuiltInDeveloperRoleDefinition,
  buildBuiltInDeveloperRoleVersion,
  BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
  createPersonaFromRole,
  ensureBuiltInDeveloperRole,
  hashBehaviorFlow,
  PersonaFactoryConflictError,
} from '@/backend/services/enduringAgents';
import { flowService } from '@/backend/services/flow';
import {
  createRoleVersion,
  getBehaviorRevision,
  getPersona,
  getRoleVersion,
  listBehaviorBindings,
  listBehaviorRevisions,
  listMemoryItems,
  listPersonas,
  listRoleVersions,
} from '@/backend/services/enduringAgents/store';
import {
  RoleVersionSchema,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { StorageKey } from '@/shared/types/storage';
import { saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

async function inFreshWorkspace<T>(task: () => T | Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `enduring-factory-${process.pid}-${workspaceSequence}`,
    async () => {
      await saveItem(StorageKey.MODELS, [{
        id: 'model-test',
        name: 'test-model',
        displayName: 'Test model',
        provider: 'openai',
      }]);
      return task();
    },
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function node(flow: Flow, id: string): FlowNode {
  const match = flow.nodes.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`Expected Flow node ${JSON.stringify(id)}.`);
  return match;
}

function exactToolsRoleVersion(): RoleVersion {
  const builtIn = buildBuiltInDeveloperRoleVersion();
  return RoleVersionSchema.parse({
    ...builtIn,
    id: 'rolever_developer_exact_tools_v3',
    version: 3,
    name: 'Developer exact tools v3',
    mission: 'Develop carefully with only the exact account and tools authored in the Behavior.',
    behaviorSlots: [
      {
        key: 'primary',
        name: 'Primary with exact tools',
        requiredCapabilities: ['source-control.read-write'],
        flowTemplate: {
          id: 'developer_exact_tools_template',
          name: 'Developer exact tools template',
          permissionRules: [
            { action: 'read_issue', resource: 'github-jim', effect: 'allow' },
          ],
          nodes: [
            {
              id: 'start',
              type: 'start',
              position: { x: 0, y: 0 },
              data: {
                label: 'Start',
                type: 'start',
                properties: { promptTemplate: 'Work on the selected issue.' },
              },
            },
            {
              id: 'develop',
              type: 'process',
              position: { x: 240, y: 0 },
              data: {
                label: 'Develop',
                type: 'process',
                properties: {
                  promptTemplate: 'Inspect, implement, and validate.',
                  boundModel: 'model-test',
                  // These are runtime attachment caches, not authored tool
                  // authority, and must not enter the immutable revision.
                  mcpNodes: [
                    {
                      id: 'ambient-tools',
                      properties: {
                        boundServer: 'ambient-admin',
                        enabledTools: ['delete_repository'],
                      },
                    },
                  ],
                  resourceNodes: [{ id: 'ambient-resource' }],
                },
              },
            },
            {
              id: 'github-jim',
              type: 'mcp',
              position: { x: 240, y: 180 },
              data: {
                label: 'Jim GitHub',
                type: 'mcp',
                properties: {
                  boundServer: 'github-jim',
                  enabledTools: ['read_issue'],
                  roots: ['workspace'],
                },
              },
            },
            {
              id: 'finish',
              type: 'finish',
              position: { x: 480, y: 0 },
              data: { label: 'Finish', type: 'finish' },
            },
          ],
          edges: [
            { id: 'start-develop', source: 'start', target: 'develop' },
            { id: 'develop-finish', source: 'develop', target: 'finish' },
            {
              id: 'github-develop',
              source: 'github-jim',
              target: 'develop',
              sourceHandle: 'mcp-out',
              targetHandle: 'process-left-mcp',
            },
          ],
        },
      },
    ],
    capabilityRequirements: {
      semantic: ['source-control.read-write'],
      preferredMcpServers: ['github-jim'],
    },
    createdAt: builtIn.createdAt + 1,
  });
}

describe('built-in Developer Role', () => {
  it('is deterministic and refuses to rewrite its immutable RoleVersion', async () => {
    await inFreshWorkspace(async () => {
      const definitionA = buildBuiltInDeveloperRoleDefinition();
      const definitionB = buildBuiltInDeveloperRoleDefinition();
      const versionA = buildBuiltInDeveloperRoleVersion();
      const versionB = buildBuiltInDeveloperRoleVersion();

      expect(definitionB).toEqual(definitionA);
      expect(definitionB).not.toBe(definitionA);
      expect(versionB).toEqual(versionA);
      expect(versionB).not.toBe(versionA);

      const first = await ensureBuiltInDeveloperRole();
      const retry = await ensureBuiltInDeveloperRole();
      expect(retry).toEqual(first);
      expect(await listRoleVersions(first.roleDefinition.id)).toEqual([first.roleVersion]);

      const conflicting = RoleVersionSchema.parse({
        ...first.roleVersion,
        mission: 'Silently replace the persisted built-in template.',
      });
      await expect(createRoleVersion(conflicting)).rejects.toThrow(/immutable/i);
      expect(await getRoleVersion(first.roleVersion.id)).toEqual(versionA);
    });
  });
});

describe('createPersonaFromRole', () => {
  it('creates Jim ready and idle with exactly the primary and maintain_memory Behaviors', async () => {
    await inFreshWorkspace(async () => {
      const bundle = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'create-jim',
      });

      expect(bundle.persona).toMatchObject({
        name: 'Jim',
        roleVersionId: BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
        lifecycleState: 'idle',
        provisioningState: 'ready',
      });
      const coreFlow = await flowService.getFlow(
        bundle.persona.composition!.coreFlowRef,
      );
      expect(coreFlow).toMatchObject({
        personaOwnership: {
          personaId: bundle.persona.id,
          kind: 'core',
        },
      });
      expect(coreFlow!.nodes
        .filter((candidate) => candidate.data.type === 'process')
        .map((candidate) => candidate.data.properties?.boundModel))
        .toEqual(expect.arrayContaining(['model-test']));
      expect(bundle.behaviorBindings.map((binding) => binding.slotKey).sort()).toEqual([
        'maintain_memory',
        'primary',
      ]);
      expect(bundle.behaviorBindings).toHaveLength(2);
      expect(bundle.behaviorRevisions).toHaveLength(2);
      const roleVersion = await getRoleVersion(BUILT_IN_DEVELOPER_ROLE_VERSION_ID);
      expect(roleVersion).not.toBeNull();
      expect(roleVersion!.coreTemplate!.nodes
        .filter((candidate) => candidate.data.type === 'process')
        .every((candidate) => candidate.data.properties?.boundModel === undefined))
        .toBe(true);
      for (const binding of bundle.behaviorBindings) {
        const revision = bundle.behaviorRevisions.find(
          (candidate) => candidate.id === binding.activeRevisionId,
        )!;
        const slot = roleVersion!.behaviorSlots.find(
          (candidate) => candidate.key === binding.slotKey,
        )!;
        expect(revision).toMatchObject({
          behaviorId: binding.id,
          personaId: bundle.persona.id,
          slotKey: binding.slotKey,
          revision: 1,
          source: {
            kind: 'role_template',
            roleVersionId: BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
            slotKey: binding.slotKey,
          },
        });
        expect(revision.contentHash).toBe(hashBehaviorFlow(revision.flowSnapshot));
        expect(slot.flowTemplate.nodes
          .filter((candidate) => candidate.data.type === 'process')
          .every((candidate) => candidate.data.properties?.boundModel === undefined))
          .toBe(true);
        expect(revision.flowSnapshot.nodes
          .filter((candidate) => candidate.data.type === 'process')
          .map((candidate) => candidate.data.properties?.boundModel))
          .toEqual(expect.arrayContaining(['model-test']));
      }

      // The deterministic factory must not invent biography or pre-populate
      // even candidate memory when the user supplied no facts.
      expect(bundle.memoryItems).toEqual([]);
      expect(bundle.persona.coreMemoryItemIds).toEqual([]);
      expect(bundle.workItems).toEqual([]);
      expect(bundle.activities).toEqual([]);
      expect(bundle.mailboxItems).toEqual([]);
      expect(bundle.lease).toBeNull();
    });
  });

  it('returns the same complete Persona on retry without duplicate children', async () => {
    await inFreshWorkspace(async () => {
      const input = { name: 'Jim', idempotencyKey: 'retry-jim' };
      const first = await createPersonaFromRole(input);
      const retry = await createPersonaFromRole(input);

      expect(retry).toEqual(first);
      expect(await listPersonas()).toEqual([first.persona]);
      expect(await listBehaviorBindings(first.persona.id)).toHaveLength(2);
      expect(await listBehaviorRevisions(first.persona.id)).toHaveLength(2);
      expect(await listMemoryItems(first.persona.id)).toEqual([]);
    });
  });

  it('rejects a changed payload that reuses an idempotency key', async () => {
    await inFreshWorkspace(async () => {
      const first = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'one-logical-persona',
      });

      await expect(createPersonaFromRole({
        name: 'James',
        idempotencyKey: 'one-logical-persona',
      })).rejects.toBeInstanceOf(PersonaFactoryConflictError);
      expect(await listPersonas()).toEqual([first.persona]);
    });
  });

  it('materializes only explicit memory as active, trusted, provenance-bearing memory', async () => {
    await inFreshWorkspace(async () => {
      const sourceRefs = [{
        kind: 'user_statement' as const,
        id: 'jim-preference-statement',
        messageId: 'message-123',
        observedAt: 1_786_320_000_000,
      }];
      const input = {
        name: 'Jim',
        idempotencyKey: 'jim-with-one-explicit-fact',
        initialMemories: [{
          content: 'Jim prefers TypeScript for application code.',
          kind: 'semantic' as const,
          scope: 'persona' as const,
          confidence: 0.95,
          importance: 0.8,
          sourceRefs,
        }],
      };

      const first = await createPersonaFromRole(input);
      expect(first.memoryItems).toHaveLength(1);
      expect(first.memoryItems[0]).toMatchObject({
        personaId: first.persona.id,
        kind: 'semantic',
        scope: 'persona',
        status: 'active',
        content: 'Jim prefers TypeScript for application code.',
        confidence: 0.95,
        importance: 0.8,
        trust: 'explicit_user',
        sourceRefs,
      });
      expect(first.persona.coreMemoryItemIds).toEqual([first.memoryItems[0].id]);
      expect(first.persona.composition?.memoryRefs).toEqual([first.memoryItems[0].id]);

      const retry = await createPersonaFromRole(input);
      expect(retry.memoryItems).toEqual(first.memoryItems);
      expect(retry.persona.coreMemoryItemIds).toEqual([first.memoryItems[0].id]);
      expect(retry.persona.composition?.memoryRefs).toEqual([first.memoryItems[0].id]);
      expect(await listMemoryItems(first.persona.id)).toHaveLength(1);
    });
  });

  it('freezes authored Flow authority and never carries ambient tool attachments into a revision', async () => {
    await inFreshWorkspace(async () => {
      await ensureBuiltInDeveloperRole();
      const sourceVersion = exactToolsRoleVersion();
      await createRoleVersion(sourceVersion);
      const bundle = await createPersonaFromRole({
        name: 'Jim',
        roleVersionId: sourceVersion.id,
        idempotencyKey: 'jim-exact-tools',
      });
      const revision = bundle.behaviorRevisions[0];
      const snapshotBeforeSourceMutation = clone(revision.flowSnapshot);

      expect(await getRoleVersion(sourceVersion.id)).toEqual(sourceVersion);
      expect(revision.contentHash).toBe(hashBehaviorFlow(revision.flowSnapshot));
      expect(revision.source).toEqual({
        kind: 'role_template',
        roleVersionId: sourceVersion.id,
        slotKey: 'primary',
        templateFlowId: 'developer_exact_tools_template',
      });
      expect(revision.flowSnapshot.permissionRules).toEqual([
        { action: 'read_issue', resource: 'github-jim', effect: 'allow' },
      ]);
      expect(node(revision.flowSnapshot, 'github-jim').data.properties).toEqual({
        boundServer: 'github-jim',
        enabledTools: ['read_issue'],
        roots: ['workspace'],
      });
      expect(node(revision.flowSnapshot, 'develop').data.properties).toEqual({
        promptTemplate: 'Inspect, implement, and validate.',
        boundModel: 'model-test',
      });
      expect(JSON.stringify(revision.flowSnapshot)).not.toContain('ambient-admin');
      expect(JSON.stringify(revision.flowSnapshot)).not.toContain('delete_repository');

      // Mutating the source object after materialization cannot rewrite the
      // persisted content-addressed Behavior revision.
      const sourceMcp = node(sourceVersion.behaviorSlots[0].flowTemplate, 'github-jim');
      sourceMcp.data.properties!.boundServer = 'github-someone-else';
      sourceMcp.data.properties!.enabledTools = ['delete_repository'];
      sourceVersion.behaviorSlots[0].flowTemplate.permissionRules = [];

      expect(await getBehaviorRevision(revision.id)).toMatchObject({
        contentHash: revision.contentHash,
        flowSnapshot: snapshotBeforeSourceMutation,
      });
    });
  });

  it('keeps Jim pinned to Developer v2 when Developer v3 is created', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'jim-pinned-role',
      });
      const v2 = buildBuiltInDeveloperRoleVersion();
      const v3 = RoleVersionSchema.parse({
        ...v2,
        id: 'rolever_builtin_developer_v3',
        version: 3,
        name: 'Developer v3',
        mission: 'Deliver reliable software changes under the deliberately upgraded v3 policy.',
        migrationNotes: 'Opt-in upgrade; existing Personas stay on v2.',
        createdAt: v2.createdAt + 1,
      });

      await createRoleVersion(v3);

      expect(await getRoleVersion(v3.id)).toEqual(v3);
      expect((await getPersona(jim.persona.id))?.roleVersionId)
        .toBe(BUILT_IN_DEVELOPER_ROLE_VERSION_ID);
      expect((await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'jim-pinned-role',
      })).persona.roleVersionId).toBe(BUILT_IN_DEVELOPER_ROLE_VERSION_ID);
      expect((await listBehaviorRevisions(jim.persona.id)).map(
        (revision) => revision.source.kind === 'role_template'
          ? revision.source.roleVersionId
          : null,
      )).toEqual([
        BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
        BUILT_IN_DEVELOPER_ROLE_VERSION_ID,
      ]);
    });
  });

  it('isolates the same explicit Persona id across concurrent workspaces', async () => {
    const suffix = `${process.pid}-${++workspaceSequence}`;
    const workspaceA = `enduring-isolation-a-${suffix}`;
    const workspaceB = `enduring-isolation-b-${suffix}`;
    const personaId = 'persona_same_workspace_local_id';

    const [personaA, personaB] = await Promise.all([
      runWithWorkspace(workspaceA, async () => {
        await saveItem(StorageKey.MODELS, [{
          id: 'model-test',
          name: 'test-model',
          displayName: 'Test model',
          provider: 'openai',
        }]);
        return createPersonaFromRole({
          id: personaId,
          name: 'Jim from workspace A',
        });
      }),
      runWithWorkspace(workspaceB, async () => {
        await saveItem(StorageKey.MODELS, [{
          id: 'model-test',
          name: 'test-model',
          displayName: 'Test model',
          provider: 'openai',
        }]);
        return createPersonaFromRole({
          id: personaId,
          name: 'Jim from workspace B',
        });
      }),
    ]);

    expect(personaA.persona.id).toBe(personaId);
    expect(personaB.persona.id).toBe(personaId);
    expect(personaA.persona.name).toBe('Jim from workspace A');
    expect(personaB.persona.name).toBe('Jim from workspace B');
    expect(await runWithWorkspace(workspaceA, () => getPersona(personaId)))
      .toEqual(personaA.persona);
    expect(await runWithWorkspace(workspaceB, () => getPersona(personaId)))
      .toEqual(personaB.persona);
    expect(await runWithWorkspace(workspaceA, () => listPersonas())).toHaveLength(1);
    expect(await runWithWorkspace(workspaceB, () => listPersonas())).toHaveLength(1);
  });
});
