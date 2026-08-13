import { createHash } from 'crypto';

import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorBindingSchema,
  BehaviorRevisionSchema,
  CreatePersonaInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  PERSONA_SCHEMA_VERSION,
  PersonaSchema,
  type BehaviorBinding,
  type BehaviorRevision,
  type CreatePersonaInput,
  type MemoryItem,
  type Persona,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import { assertSafeCollectionId } from '@/utils/storage/backend';

import {
  behaviorRevisionId,
  canonicalJson,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from './behaviorRevisions';
import { BUILT_IN_DEVELOPER_ROLE_VERSION_ID } from './builtInDeveloperRole';
import { ensureBuiltInDeveloperRole } from './builtInRoleStore';
import { randomEnduringAgentId, stableEnduringAgentId } from './ids';
import { ensurePersonaNamespaces } from './namespaces';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  createBehaviorRevision,
  createBehaviorBindingIfAbsent,
  createMemoryItem,
  createPersona,
  getMemoryItem,
  getPersona,
  getPersonaDeletionTombstone,
  getRoleVersion,
  listPersonaBundle,
  updatePersonaWithinRuntimeLock,
  type PersonaBundle,
} from './store';

export class PersonaFactoryConflictError extends Error {
  readonly code = 'PERSONA_FACTORY_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'PersonaFactoryConflictError';
  }
}

export class RoleVersionNotFoundError extends Error {
  readonly code = 'ROLE_VERSION_NOT_FOUND';

  constructor(readonly roleVersionId: string) {
    super(`RoleVersion ${JSON.stringify(roleVersionId)} not found.`);
    this.name = 'RoleVersionNotFoundError';
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function resolvePersonaId(input: CreatePersonaInput): string {
  if (input.id) return input.id;
  if (input.idempotencyKey) {
    return stableEnduringAgentId('persona', {
      purpose: 'persona-factory-v1',
      idempotencyKey: input.idempotencyKey,
    });
  }
  return randomEnduringAgentId('persona');
}

async function resolveRoleVersion(roleVersionId?: string): Promise<RoleVersion> {
  const builtIn = await ensureBuiltInDeveloperRole();
  if (!roleVersionId || roleVersionId === BUILT_IN_DEVELOPER_ROLE_VERSION_ID) {
    return builtIn.roleVersion;
  }
  const selected = await getRoleVersion(roleVersionId);
  if (!selected) throw new RoleVersionNotFoundError(roleVersionId);
  return selected;
}

function effectiveFactoryRequest(
  input: CreatePersonaInput,
  roleVersion: RoleVersion,
): Record<string, unknown> {
  return {
    name: input.name,
    roleVersionId: roleVersion.id,
    mission: input.mission ?? roleVersion.mission,
    presentation: input.presentation ?? roleVersion.defaults?.presentation ?? null,
    autonomyLevel: input.autonomyLevel ?? roleVersion.defaults?.autonomyLevel ?? 'locked',
    interruptionPolicy:
      input.interruptionPolicy ?? roleVersion.defaults?.interruptionPolicy ?? 'queue',
    initialMemories: input.initialMemories ?? [],
  };
}

function assertRetryMatches(
  existing: Persona,
  personaId: string,
  requestHash: string,
  request: Record<string, unknown>,
): void {
  if (
    existing.factoryKeyHash !== requestHash
    || existing.name !== request.name
    || existing.roleVersionId !== request.roleVersionId
  ) {
    throw new PersonaFactoryConflictError(
      `Persona ${JSON.stringify(personaId)} already exists and was not created by `
      + 'the same deterministic factory request.',
    );
  }
}

async function materializeBehavior(
  persona: Persona,
  roleVersion: RoleVersion,
  slot: RoleVersion['behaviorSlots'][number],
): Promise<void> {
  const behaviorId = stableEnduringAgentId('behavior', {
    personaId: persona.id,
    slotKey: slot.key,
  });
  const flow = snapshotBehaviorFlow({
    ...slot.flowTemplate,
    id: stableEnduringAgentId('flow', { behaviorId, revision: 1 }),
    name: `${persona.name} · ${slot.name}`,
  });
  const contentHash = hashBehaviorFlow(flow);
  const revision: BehaviorRevision = BehaviorRevisionSchema.parse({
    schemaVersion: BEHAVIOR_REVISION_SCHEMA_VERSION,
    id: behaviorRevisionId({
      personaId: persona.id,
      behaviorId,
      revision: 1,
      contentHash,
    }),
    behaviorId,
    personaId: persona.id,
    slotKey: slot.key,
    revision: 1,
    contentHash,
    flowSnapshot: flow,
    source: {
      kind: 'role_template',
      roleVersionId: roleVersion.id,
      slotKey: slot.key,
      templateFlowId: slot.flowTemplate.id,
    },
    createdAt: persona.createdAt,
  });
  await createBehaviorRevision(revision);

  const binding: BehaviorBinding = BehaviorBindingSchema.parse({
    schemaVersion: BEHAVIOR_BINDING_SCHEMA_VERSION,
    id: behaviorId,
    personaId: persona.id,
    slotKey: slot.key,
    activeRevisionId: revision.id,
    createdAt: persona.createdAt,
    updatedAt: persona.createdAt,
  });
  // One binding-key critical section both repairs a missing default and
  // preserves any reviewed override that won the initialization race.
  await createBehaviorBindingIfAbsent(binding);
}

async function materializeInitialMemories(
  persona: Persona,
  input: CreatePersonaInput,
): Promise<string[]> {
  const memoryIds: string[] = [];
  for (const [index, candidate] of (input.initialMemories ?? []).entries()) {
    const id = stableEnduringAgentId('memory', {
      personaId: persona.id,
      index,
      content: candidate.content,
      kind: candidate.kind ?? 'semantic',
      scope: candidate.scope ?? 'persona',
    });
    memoryIds.push(id);
    // Do not resurrect a memory that a user corrected/forgot after factory
    // completion. Presence proves this deterministic input was materialized.
    if (await getMemoryItem(id)) continue;
    const memory: MemoryItem = MemoryItemSchema.parse({
      schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
      id,
      personaId: persona.id,
      kind: candidate.kind ?? 'semantic',
      scope: candidate.scope ?? 'persona',
      status: 'active',
      content: candidate.content,
      confidence: candidate.confidence ?? 1,
      importance: candidate.importance ?? 0.5,
      sourceRefs: candidate.sourceRefs ?? [{
        kind: 'user_statement',
        id: `persona-factory:${persona.id}:${index}`,
        observedAt: persona.createdAt,
      }],
      trust: 'explicit_user',
      createdAt: persona.createdAt,
      updatedAt: persona.createdAt,
    });
    await createMemoryItem(memory);
  }
  return memoryIds;
}

/**
 * Deterministically materialize a durable Persona and its Role-owned default
 * Behaviors. The Persona is committed last by moving provisioningState to
 * `ready`; a crash leaves a disabled/pending record that the same request can
 * safely repair because every child id and timestamp is deterministic.
 */
export async function createPersonaFromRole(value: unknown): Promise<PersonaBundle> {
  const input = CreatePersonaInputSchema.parse(value) as CreatePersonaInput;
  const personaId = resolvePersonaId(input);
  assertSafeCollectionId(personaId);

  return withPersonaRuntimeLock(personaId, async (lock) => {
    if (await getPersonaDeletionTombstone(personaId)) {
      throw new PersonaFactoryConflictError(
        `Persona ${JSON.stringify(personaId)} was deleted and cannot be recreated in this workspace.`,
      );
    }
    const roleVersion = await resolveRoleVersion(input.roleVersionId);
    const effectiveRequest = effectiveFactoryRequest(input, roleVersion);
    const requestHash = sha256({
      idempotencyKey: input.idempotencyKey ?? null,
      request: effectiveRequest,
    });

    await ensurePersonaNamespaces(personaId);
    let persona = await getPersona(personaId);
    if (persona) {
      assertRetryMatches(persona, personaId, requestHash, effectiveRequest);
    } else {
      const now = Date.now();
      persona = PersonaSchema.parse({
        schemaVersion: PERSONA_SCHEMA_VERSION,
        id: personaId,
        name: input.name,
        roleVersionId: roleVersion.id,
        lifecycleState: 'disabled',
        mission: input.mission ?? roleVersion.mission,
        ...(input.presentation ?? roleVersion.defaults?.presentation
          ? { presentation: input.presentation ?? roleVersion.defaults?.presentation }
          : {}),
        autonomyLevel:
          input.autonomyLevel ?? roleVersion.defaults?.autonomyLevel ?? 'locked',
        interruptionPolicy:
          input.interruptionPolicy ?? roleVersion.defaults?.interruptionPolicy ?? 'queue',
        coreMemoryItemIds: [],
        factoryKeyHash: requestHash,
        provisioningState: 'pending',
        createdAt: now,
        updatedAt: now,
      });
      await createPersona(persona);
    }

    await Promise.all(
      roleVersion.behaviorSlots.map((slot) => materializeBehavior(persona!, roleVersion, slot)),
    );
    const initialMemoryIds = await materializeInitialMemories(persona, input);

    if (persona.provisioningState !== 'ready') {
      persona = await updatePersonaWithinRuntimeLock(PersonaSchema.parse({
        ...persona,
        lifecycleState: 'idle',
        provisioningState: 'ready',
        coreMemoryItemIds: initialMemoryIds,
        composition: {
          description: '',
          appRefs: [],
          memoryRefs: initialMemoryIds,
          behaviors: roleVersion.behaviorSlots.map((slot) => ({
            ref: stableEnduringAgentId('behavior', {
              personaId: persona!.id,
              slotKey: slot.key,
            }),
            name: slot.name,
          })),
        },
        updatedAt: Date.now(),
      }), lock);
    }

    const bundle = await listPersonaBundle(persona.id);
    if (!bundle) throw new Error(`Persona ${JSON.stringify(persona.id)} vanished after creation.`);
    return bundle;
  });
}
