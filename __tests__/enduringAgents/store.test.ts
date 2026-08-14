import {
  behaviorRevisionId,
  createPersonaFromRole,
  ensureBuiltInDeveloperRole,
  hashBehaviorFlow,
  UnsupportedEnduringAgentSchemaError,
} from '@/backend/services/enduringAgents';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  createBehaviorBindingIfAbsent,
  createBehaviorRevision,
  createMemoryItem,
  createPersona,
  createRoleVersion,
  getBehaviorBinding,
  getPersona,
  listBehaviorRevisions,
  listPersonas,
  saveBehaviorBinding,
  updatePersona,
} from '@/backend/services/enduringAgents/store';
import {
  createMeetingRecord,
  getMeeting,
  MEETINGS_COLLECTION,
} from '@/backend/services/meetings/store';
import { SchedulerService } from '@/backend/services/scheduler';
import {
  BehaviorRevisionSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  FlowSnapshotSchema,
  MemoryItemSchema,
  PERSONA_SCHEMA_VERSION,
  RoleVersionSchema,
  type BehaviorRevision,
  type BehaviorRevisionSource,
  type MemoryItem,
} from '@/shared/types/enduringAgent';
import type { PlannedExecution } from '@/shared/types/plannedExecution';
import { StorageKey } from '@/shared/types/storage';
import {
  saveCollectionItem,
  saveItem,
} from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

async function inFreshWorkspace<T>(
  task: () => T | Promise<T>,
): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `enduring-store-${process.pid}-${workspaceSequence}`,
    async () => {
      // Role templates remain model-neutral. Persona materialization resolves
      // the one unambiguous workspace model and validates the generated Core
      // and Behavior Flows as runnable.
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

function derivedRevision(
  base: BehaviorRevision,
  options: {
    behaviorId?: string;
    personaId?: string;
    slotKey?: string;
    revision: number;
    marker: string;
    source?: BehaviorRevisionSource;
    mutateFlow?: (flow: BehaviorRevision['flowSnapshot']) => void;
  },
): BehaviorRevision {
  const flowSnapshot = JSON.parse(JSON.stringify(base.flowSnapshot)) as BehaviorRevision['flowSnapshot'];
  flowSnapshot.name = `${flowSnapshot.name} · ${options.marker}`;
  options.mutateFlow?.(flowSnapshot);
  const behaviorId = options.behaviorId ?? base.behaviorId;
  const personaId = options.personaId ?? base.personaId;
  const slotKey = options.slotKey ?? base.slotKey;
  const contentHash = hashBehaviorFlow(flowSnapshot);
  return BehaviorRevisionSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: behaviorRevisionId({
      personaId,
      behaviorId,
      revision: options.revision,
      contentHash,
    }),
    behaviorId,
    personaId,
    slotKey,
    revision: options.revision,
    contentHash,
    flowSnapshot,
    source: options.source ?? {
      kind: 'persona_override',
      parentRevisionId: base.id,
    },
    createdAt: base.createdAt + options.revision,
  });
}

function memoryItem(options: {
  id: string;
  personaId: string;
  status: MemoryItem['status'];
  trust: MemoryItem['trust'];
}): MemoryItem {
  return MemoryItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    ...options,
    kind: 'semantic',
    scope: 'persona',
    content: `Memory ${options.id}`,
    confidence: 1,
    importance: 1,
    sourceRefs: [{ kind: 'user_statement', id: `source-${options.id}` }],
    createdAt: 1_786_320_000_000,
    updatedAt: 1_786_320_000_000,
  });
}

describe('enduring-agent store ownership', () => {
  it('rejects activating a Behavior revision owned by another Persona', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'ownership-jim',
      });
      const sarah = await createPersonaFromRole({
        name: 'Sarah',
        idempotencyKey: 'ownership-sarah',
      });
      const jimPrimary = jim.behaviorBindings.find((binding) => binding.slotKey === 'primary')!;
      const sarahPrimaryRevision = sarah.behaviorRevisions.find(
        (revision) => revision.slotKey === 'primary',
      )!;

      await expect(saveBehaviorBinding({
        ...jimPrimary,
        activeRevisionId: sarahPrimaryRevision.id,
        updatedAt: jimPrimary.updatedAt + 1,
      })).rejects.toThrow(/ownership differs/i);
    });
  });

  it('preserves an existing override during default binding initialization and rejects blind updates', async () => {
    await inFreshWorkspace(async () => {
      const factoryInput = {
        name: 'Jim',
        idempotencyKey: 'binding-create-if-absent',
      };
      const jim = await createPersonaFromRole(factoryInput);
      const binding = jim.behaviorBindings.find((candidate) => candidate.slotKey === 'primary')!;
      const original = jim.behaviorRevisions.find(
        (candidate) => candidate.id === binding.activeRevisionId,
      )!;
      const override = derivedRevision(original, {
        revision: 2,
        marker: 'reviewed override',
      });
      await createBehaviorRevision(override);

      const reviewedBinding = {
        ...binding,
        activeRevisionId: override.id,
        updatedAt: binding.updatedAt + 1,
      };
      // Simulate the future reviewed/CAS activation path having won just
      // before a factory retry tries to install the Role default.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.behaviorBindings,
        binding.id,
        reviewedBinding,
      );

      await expect(createBehaviorBindingIfAbsent(binding)).resolves.toEqual(reviewedBinding);
      expect(await getBehaviorBinding(binding.id)).toEqual(reviewedBinding);
      const retry = await createPersonaFromRole(factoryInput);
      expect(retry.behaviorBindings.find((candidate) => candidate.id === binding.id))
        .toEqual(reviewedBinding);
      await expect(saveBehaviorBinding({
        ...reviewedBinding,
        activeRevisionId: original.id,
        updatedAt: reviewedBinding.updatedAt + 1,
      })).rejects.toThrow(/compare-and-swap/i);
      expect(await getBehaviorBinding(binding.id)).toEqual(reviewedBinding);
    });
  });

  it('serializes Behavior revision ordinals and rejects conflicting ownership', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'revision-ordinal-jim',
      });
      const sarah = await createPersonaFromRole({
        name: 'Sarah',
        idempotencyKey: 'revision-ordinal-sarah',
      });
      const original = jim.behaviorRevisions.find((candidate) => candidate.slotKey === 'primary')!;
      const competing = [
        derivedRevision(original, { revision: 2, marker: 'candidate A' }),
        derivedRevision(original, { revision: 2, marker: 'candidate B' }),
      ];

      const outcomes = await Promise.allSettled(competing.map(createBehaviorRevision));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      expect((await listBehaviorRevisions(jim.persona.id)).filter(
        (candidate) => candidate.behaviorId === original.behaviorId,
      )).toHaveLength(2);

      const stolenBehavior = derivedRevision(original, {
        personaId: sarah.persona.id,
        revision: 3,
        marker: 'ownership collision',
        source: { kind: 'import', sourceRef: 'test' },
      });
      await expect(createBehaviorRevision(stolenBehavior)).rejects.toThrow(
        /already owned by another Persona or slot/i,
      );
    });
  });

  it('validates Behavior revision source provenance and parent ownership', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'revision-source-jim',
      });
      const sarah = await createPersonaFromRole({
        name: 'Sarah',
        idempotencyKey: 'revision-source-sarah',
      });
      const original = jim.behaviorRevisions.find((candidate) => candidate.slotKey === 'primary')!;
      const sarahRevision = sarah.behaviorRevisions.find(
        (candidate) => candidate.slotKey === 'primary',
      )!;

      const falseTemplateClaim = derivedRevision(original, {
        behaviorId: 'behavior_false_template_claim',
        revision: 1,
        marker: 'content not present in template',
        source: original.source,
        mutateFlow: (flow) => {
          flow.permissionRules = [{ action: 'unclaimed', resource: '*', effect: 'allow' }];
        },
      });
      await expect(createBehaviorRevision(falseTemplateClaim)).rejects.toThrow(
        /does not match its claimed RoleVersion template/i,
      );

      const foreignParent = derivedRevision(original, {
        revision: 2,
        marker: 'foreign parent',
        source: {
          kind: 'persona_override',
          parentRevisionId: sarahRevision.id,
        },
      });
      await expect(createBehaviorRevision(foreignParent)).rejects.toThrow(
        /parent is owned by another Persona, Behavior, or slot/i,
      );
    });
  });

  it('fails closed when a persisted Behavior revision has invalid content integrity', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'revision-corruption',
      });
      const revision = jim.behaviorRevisions[0];
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.behaviorRevisions,
        revision.id,
        { ...revision, contentHash: '0'.repeat(64) },
      );

      await expect(listBehaviorRevisions(jim.persona.id)).rejects.toThrow(
        /content hash is invalid/i,
      );
    });
  });
});

describe('enduring-agent referential integrity', () => {
  it('accepts only active, trusted, same-Persona core memories', async () => {
    await inFreshWorkspace(async () => {
      const jim = await createPersonaFromRole({
        name: 'Jim',
        idempotencyKey: 'core-memory-jim',
        initialMemories: [{ content: 'User-verified fact.' }],
      });
      const sarah = await createPersonaFromRole({
        name: 'Sarah',
        idempotencyKey: 'core-memory-sarah',
        initialMemories: [{ content: 'Sarah fact.' }],
      });
      const explicitMemory = jim.memoryItems[0];

      await expect(updatePersona({
        ...jim.persona,
        coreMemoryItemIds: [explicitMemory.id],
        updatedAt: jim.persona.updatedAt + 1,
      })).resolves.toMatchObject({ coreMemoryItemIds: [explicitMemory.id] });

      const rejected = [
        memoryItem({
          id: 'memory_candidate_core',
          personaId: jim.persona.id,
          status: 'candidate',
          trust: 'verified_tool',
        }),
        memoryItem({
          id: 'memory_inferred_core',
          personaId: jim.persona.id,
          status: 'active',
          trust: 'model_inference',
        }),
        memoryItem({
          id: 'memory_external_core',
          personaId: jim.persona.id,
          status: 'active',
          trust: 'external_untrusted',
        }),
      ];
      for (const memory of rejected) await createMemoryItem(memory);

      await expect(updatePersona({
        ...(await getPersona(jim.persona.id))!,
        coreMemoryItemIds: [rejected[0].id],
        updatedAt: Date.now(),
      })).rejects.toThrow(/must be active/i);
      await expect(updatePersona({
        ...(await getPersona(jim.persona.id))!,
        coreMemoryItemIds: [rejected[1].id],
        updatedAt: Date.now(),
      })).rejects.toThrow(/explicit_user or verified_tool/i);
      await expect(updatePersona({
        ...(await getPersona(jim.persona.id))!,
        coreMemoryItemIds: [rejected[2].id],
        updatedAt: Date.now(),
      })).rejects.toThrow(/explicit_user or verified_tool/i);
      await expect(updatePersona({
        ...(await getPersona(jim.persona.id))!,
        coreMemoryItemIds: [sarah.memoryItems[0].id],
        updatedAt: Date.now(),
      })).rejects.toThrow(/owned by another Persona/i);

      const verified = memoryItem({
        id: 'memory_verified_core',
        personaId: jim.persona.id,
        status: 'active',
        trust: 'verified_tool',
      });
      await createMemoryItem(verified);
      await expect(updatePersona({
        ...(await getPersona(jim.persona.id))!,
        coreMemoryItemIds: [verified.id],
        updatedAt: Date.now(),
      })).resolves.toMatchObject({ coreMemoryItemIds: [verified.id] });

      await expect(createPersona({
        ...jim.persona,
        id: 'persona_missing_core_memory',
        name: 'Missing core memory',
        coreMemoryItemIds: ['memory_does_not_exist'],
        factoryKeyHash: undefined,
      })).rejects.toThrow(/missing MemoryItem/i);
    });
  });

  it('enforces one RoleVersion id per RoleDefinition ordinal under concurrency', async () => {
    await inFreshWorkspace(async () => {
      const { roleVersion } = await ensureBuiltInDeveloperRole();
      const candidates = ['rolever_concurrent_a', 'rolever_concurrent_b'].map((id, index) => (
        RoleVersionSchema.parse({
          ...roleVersion,
          id,
          version: 99,
          name: `Concurrent Developer ${index}`,
          mission: `Concurrent immutable RoleVersion candidate ${index}.`,
          createdAt: roleVersion.createdAt + index + 1,
        })
      ));

      const outcomes = await Promise.allSettled(candidates.map(createRoleVersion));
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    });
  });
});

describe('enduring-agent schema boundary', () => {
  it.each([
    ['a future schema version', PERSONA_SCHEMA_VERSION + 1],
    ['a missing schema version', undefined],
  ])('rejects %s instead of guessing or rewriting it', async (_label, schemaVersion) => {
    await inFreshWorkspace(async () => {
      const valid = (await createPersonaFromRole({
        name: 'Schema source',
        idempotencyKey: `schema-source-${String(schemaVersion)}`,
      })).persona;
      const id = schemaVersion === undefined
        ? 'persona_missing_schema_version'
        : 'persona_future_schema_version';
      const raw: Record<string, unknown> = {
        ...valid,
        id,
        schemaVersion,
      };
      if (schemaVersion === undefined) delete raw.schemaVersion;
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, id, raw);

      await expect(getPersona(id)).rejects.toBeInstanceOf(
        UnsupportedEnduringAgentSchemaError,
      );
      await expect(listPersonas()).rejects.toBeInstanceOf(
        UnsupportedEnduringAgentSchemaError,
      );
    });
  });
});

describe('legacy persona-less compatibility fixtures', () => {
  it('parses a legacy Flow shape without inventing Persona attribution', () => {
    const legacyFlow = {
      id: 'legacy-flow',
      name: 'Legacy utility Flow',
      nodes: [
        {
          id: 'start',
          type: 'start',
          position: { x: 0, y: 0 },
          data: { label: 'Start', type: 'start' },
        },
        {
          id: 'finish',
          type: 'finish',
          position: { x: 200, y: 0 },
          data: { label: 'Finish', type: 'finish' },
        },
      ],
      edges: [{ id: 'start-finish', source: 'start', target: 'finish' }],
    };

    const parsed = FlowSnapshotSchema.parse(legacyFlow);
    expect(parsed).toEqual(legacyFlow);
    expect(parsed).not.toHaveProperty('personaId');
    expect(parsed).not.toHaveProperty('activityId');
    expect(parsed).not.toHaveProperty('behaviorRevisionId');
  });

  it('loads a legacy Meeting snapshot without Persona attribution', async () => {
    await inFreshWorkspace(async () => {
      const legacyMeeting = createMeetingRecord({
        id: 'legacy_meeting',
        title: 'Legacy meeting',
        openingPrompt: 'Discuss the existing design.',
        participants: [
          {
            id: 'participant_one',
            name: 'One',
            flowId: 'flow_one',
            conversationId: 'conversation_one',
          },
          {
            id: 'participant_two',
            name: 'Two',
            flowId: 'flow_two',
            conversationId: 'conversation_two',
          },
        ],
      });
      await saveCollectionItem(MEETINGS_COLLECTION, legacyMeeting.id, legacyMeeting);

      const loaded = await getMeeting(legacyMeeting.id);
      expect(loaded).toEqual(legacyMeeting);
      expect(loaded).not.toHaveProperty('personaId');
      expect(loaded?.participants.every(
        (participant) => !Object.hasOwn(participant, 'personaId'),
      )).toBe(true);
    });
  });

  it('loads a legacy planned execution without Persona attribution', async () => {
    await inFreshWorkspace(async () => {
      const legacyExecution: PlannedExecution = {
        id: 'legacy_planned_execution',
        name: 'Legacy schedule',
        enabled: false,
        flowId: 'legacy-flow',
        prompt: 'Run the legacy utility Flow.',
        trigger: {
          type: 'schedule',
          cron: '0 9 * * *',
          timezone: 'America/Bogota',
        },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      await saveItem(StorageKey.PLANNED_EXECUTIONS, {
        version: 1,
        paused: false,
        executions: [legacyExecution],
      });

      const loaded = await new SchedulerService().get(legacyExecution.id);
      expect(loaded).toEqual(legacyExecution);
      expect(loaded).not.toHaveProperty('personaId');
      expect(loaded).not.toHaveProperty('activityId');
      expect(loaded).not.toHaveProperty('behaviorRevisionId');
    });
  });
});
