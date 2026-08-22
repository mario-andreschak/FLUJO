import {
  createPersonaFromRole as createPersonaFromRoleProduction,
  hashBehaviorFlow,
  PersonaFactoryConflictError,
  reconcilePersonaRoleBehaviors,
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
  DEFAULT_PERSONA_NATIVE_ABILITY_IDS,
  RoleVersionSchema,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { StorageKey } from '@/shared/types/storage';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';
import {
  TEST_ROLE_VERSION_ID,
  buildTestRoleVersion,
  ensureTestRole,
} from './fixtures/personaFactory';

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
      await ensureTestRole();
      return task();
    },
  );
}

function createPersonaFromRole(value: Record<string, unknown>) {
  return createPersonaFromRoleProduction({
    roleVersionId: TEST_ROLE_VERSION_ID,
    ...value,
  });
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
  const base = buildTestRoleVersion();
  return RoleVersionSchema.parse({
    ...base,
    id: 'rolever_exact_tools_v30',
    version: 30,
    name: 'Exact tools Role v30',
    mission: 'Develop carefully with only the exact account and tools authored in the Behavior.',
    behaviorSlots: [
      {
        key: 'primary',
        name: 'Primary with exact tools',
        requiredCapabilities: ['source-control.read-write'],
        flowTemplate: {
          id: 'exact_tools_template',
          name: 'Exact tools template',
          behaviorRules: [
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
    createdAt: base.createdAt + 1,
  });
}

describe('workspace-authored Roles', () => {
  it('does not seed any Role or Persona into an empty workspace', async () => {
    const emptyWorkspace = `enduring-factory-empty-${process.pid}-${++workspaceSequence}`;
    await runWithWorkspace(emptyWorkspace, async () => {
      expect(await listRoleVersions()).toEqual([]);
      expect(await listPersonas()).toEqual([]);
    });
  });

  it('requires Persona creation to select an explicit workspace Role version', async () => {
    await inFreshWorkspace(async () => {
      await expect(createPersonaFromRoleProduction({ name: 'No implicit Role' }))
        .rejects.toThrow();
      expect(await listPersonas()).toEqual([]);
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
        roleVersionId: TEST_ROLE_VERSION_ID,
        lifecycleState: 'idle',
        provisioningState: 'ready',
      });
      const coreFlowRef = bundle.persona.composition?.coreFlowRef;
      if (!coreFlowRef) {
        throw new Error('Expected Persona composition to contain a coreFlowRef.');
      }
      const coreFlow = await flowService.getFlow(coreFlowRef);
      expect(coreFlow).toMatchObject({
        personaOwnership: {
          personaId: bundle.persona.id,
          kind: 'core',
        },
      });
      expect(coreFlow!.nodes
        .filter((candidate: FlowNode) => candidate.data.type === 'process')
        .map((candidate: FlowNode) => candidate.data.properties?.boundModel))
        .toEqual(expect.arrayContaining(['model-test']));
      expect(coreFlow!.nodes
        .filter((candidate: FlowNode) => candidate.data.type === 'process')
        .map((candidate: FlowNode) => candidate.data.properties?.personaTools))
        .toEqual(expect.arrayContaining([[...DEFAULT_PERSONA_NATIVE_ABILITY_IDS]]));
      expect(bundle.behaviorBindings.map((binding) => binding.slotKey).sort()).toEqual([
        'maintain_memory',
        'primary',
      ]);
      expect(bundle.behaviorBindings).toHaveLength(2);
      expect(bundle.behaviorRevisions).toHaveLength(2);
      const roleVersion = await getRoleVersion(TEST_ROLE_VERSION_ID);
      expect(roleVersion).not.toBeNull();
      expect(roleVersion!.coreFlowTemplate!.nodes
        .filter((candidate: FlowNode) => candidate.data.type === 'process')
        .every((candidate: FlowNode) => (
          candidate.data.properties?.boundModel === undefined
        )))
        .toBe(true);
      for (const binding of bundle.behaviorBindings) {
        const revision = bundle.behaviorRevisions.find(
          (candidate: typeof bundle.behaviorRevisions[number]) => (
            candidate.id === binding.activeRevisionId
          ),
        )!;
        const slot = roleVersion!.behaviorSlots.find(
          (candidate: RoleVersion['behaviorSlots'][number]) => (
            candidate.key === binding.slotKey
          ),
        )!;
        expect(revision).toMatchObject({
          behaviorId: binding.id,
          personaId: bundle.persona.id,
          slotKey: binding.slotKey,
          revision: 1,
          source: {
            kind: 'role_template',
            roleVersionId: TEST_ROLE_VERSION_ID,
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

  it('repairs memory maintenance for a Persona pinned to a legacy Role version', async () => {
    await inFreshWorkspace(async () => {
      const base = buildTestRoleVersion();
      const legacyVersion = RoleVersionSchema.parse({
        ...base,
        id: 'rolever_legacy_without_memory',
        version: 99,
        name: 'Legacy Product Owner',
        behaviorSlots: [base.behaviorSlots.find((slot) => slot.key === 'primary')!],
        createdAt: base.createdAt + 99,
      });
      await createRoleVersion(legacyVersion);
      const created = await createPersonaFromRole({
        name: 'Jim',
        roleVersionId: legacyVersion.id,
        idempotencyKey: 'legacy-jim-without-memory',
      });
      expect(created.behaviorBindings.map((binding) => binding.slotKey)).toEqual(['primary']);

      // Simulate the exact persisted v2 shape upgraded by the v2 -> v3
      // RoleVersion record migration in a later application release.
      await saveCollectionItem('role-versions', legacyVersion.id, {
        ...legacyVersion,
        schemaVersion: 2,
      });
      await reconcilePersonaRoleBehaviors(created.persona.id);

      expect((await getPersona(created.persona.id))?.roleVersionId).toBe(legacyVersion.id);
      expect((await listBehaviorBindings(created.persona.id))
        .map((binding) => binding.slotKey).sort())
        .toEqual(['maintain_memory', 'primary']);
      expect(((await getPersona(created.persona.id))?.composition?.behaviors ?? [])
        .map((behavior) => behavior.slotKey))
        .toEqual(['primary', 'maintain_memory']);
    });
  });

  it('uses a simple Role Primary behavior as Core and keeps its tool-only MCP suggestions', async () => {
    await inFreshWorkspace(async () => {
      const base = buildTestRoleVersion();
      const simpleRole = RoleVersionSchema.parse({
        ...base,
        id: 'rolever_simple_tools_v1',
        version: 50,
        name: 'Simple tools Role',
        coreFlowTemplate: undefined,
        suggestedApps: [{ mcpServerName: 'tools-only' }],
        capabilityRequirements: undefined,
        createdAt: base.createdAt + 50,
      });
      await createRoleVersion(simpleRole);
      await saveItem(StorageKey.MCP_SERVERS, {
        'tools-only': {
          transport: 'stdio',
          command: 'node',
          args: [],
          disabled: false,
          enableMcpApps: false,
        },
      });

      const bundle = await createPersonaFromRoleProduction({
        name: 'Mina',
        roleVersionId: simpleRole.id,
        idempotencyKey: 'simple-tools-mina',
      });

      expect(bundle.persona.provisioningState).toBe('ready');
      expect(bundle.appGrants.map((grant) => grant.mcpServerName)).toEqual(['tools-only']);
      const coreFlow = await flowService.getFlow(bundle.persona.composition!.coreFlowRef!);
      expect(coreFlow?.personaOwnership?.kind).toBe('core');
      expect(coreFlow?.personaOwnership?.sourceFlowId)
        .toBe(simpleRole.behaviorSlots.find((slot) => slot.key === 'primary')!.flowTemplate.id);
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
        templateFlowId: 'exact_tools_template',
      });
      expect(revision.flowSnapshot.behaviorRules).toEqual([
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
      sourceVersion.behaviorSlots[0].flowTemplate.behaviorRules = [];

      expect(await getBehaviorRevision(revision.id)).toMatchObject({
        contentHash: revision.contentHash,
        flowSnapshot: snapshotBeforeSourceMutation,
      });
    });
  });

  it('keeps a Persona pinned when its workspace Role publishes a later version', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'jim-pinned-role',
      });
      const v1 = buildTestRoleVersion();
      const v2 = RoleVersionSchema.parse({
        ...v1,
        id: 'rolever_test_general_v2',
        version: 2,
        name: 'Test general Role v2',
        mission: 'Exercise explicit immutable Role version upgrades.',
        migrationNotes: 'Existing Personas stay on the explicitly selected v1.',
        createdAt: v1.createdAt + 1,
      });

      await createRoleVersion(v2);

      expect(await getRoleVersion(v2.id)).toEqual(v2);
      expect((await getPersona(jim.persona.id))?.roleVersionId)
        .toBe(TEST_ROLE_VERSION_ID);
      expect((await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'jim-pinned-role',
      })).persona.roleVersionId).toBe(TEST_ROLE_VERSION_ID);
      expect((await listBehaviorRevisions(jim.persona.id)).map(
        (revision) => revision.source.kind === 'role_template'
          ? revision.source.roleVersionId
          : null,
      )).toEqual([
        TEST_ROLE_VERSION_ID,
        TEST_ROLE_VERSION_ID,
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
        await ensureTestRole();
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
        await ensureTestRole();
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
