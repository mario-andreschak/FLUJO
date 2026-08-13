import { createHash } from 'crypto';

import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import type { Flow } from '@/shared/types/flow';
import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorBindingSchema,
  BehaviorRevisionSchema,
  CreatePersonaInputSchema,
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  PERSONA_SCHEMA_VERSION,
  PersonaAppGrantSchema,
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
import {
  personaAppGrantId,
  randomEnduringAgentId,
  stableEnduringAgentId,
} from './ids';
import { ensurePersonaNamespaces } from './namespaces';
import { resolveAvailablePersonaAppRefs } from './personaCoreApps';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  createBehaviorRevision,
  createBehaviorBindingIfAbsent,
  createMemoryItem,
  createPersona,
  createPersonaAppGrant,
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
    coreFlowRef: input.coreFlowRef ?? null,
    roleVersionId: roleVersion.id,
    appRefs: input.appRefs ?? null,
    ...(input.behaviorFlowRefs?.length
      ? { behaviorFlowRefs: input.behaviorFlowRefs }
      : {}),
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

async function requireReadySharedFlow(flowRef: string, label: string): Promise<Flow> {
  const flow = await flowService.getFlow(flowRef);
  if (!flow || flow.personaOwnership) {
    throw new PersonaFactoryConflictError(
      `${label} ${JSON.stringify(flowRef)} is unavailable in this workspace.`,
    );
  }
  const readiness = await validateFlowObjectForRun(flow);
  if (!readiness.isRunnable) {
    const issues = readiness.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message);
    throw new PersonaFactoryConflictError(
      `${label} ${JSON.stringify(flowRef)} needs attention before it can be used.`
      + (issues.length > 0 ? ` ${issues.join(' ')}` : ''),
    );
  }
  return flow;
}

async function materializeSelectedBehavior(
  persona: Persona,
  flow: Flow,
): Promise<BehaviorBinding> {
  const behaviorId = stableEnduringAgentId('behavior', {
    personaId: persona.id,
    source: 'selected-flow',
    flowRef: flow.id,
  });
  const slotKey = `picked_${behaviorId.slice(-40)}`;
  const snapshot = snapshotBehaviorFlow({
    ...flow,
    id: stableEnduringAgentId('flow', { behaviorId, revision: 1 }),
  });
  const contentHash = hashBehaviorFlow(snapshot);
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
    slotKey,
    revision: 1,
    contentHash,
    flowSnapshot: snapshot,
    source: {
      kind: 'persona_override',
      sourceFlowRef: flow.id,
      selectedFlowRef: flow.id,
    },
    createdAt: persona.createdAt,
  });
  await createBehaviorRevision(revision);
  return createBehaviorBindingIfAbsent(BehaviorBindingSchema.parse({
    schemaVersion: BEHAVIOR_BINDING_SCHEMA_VERSION,
    id: behaviorId,
    personaId: persona.id,
    slotKey,
    activeRevisionId: revision.id,
    createdAt: persona.createdAt,
    updatedAt: persona.createdAt,
  }));
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
  if (input.coreFlowRef) {
    await requireReadySharedFlow(input.coreFlowRef, 'Core Flow');
  }
  const behaviorFlows = await Promise.all(
    (input.behaviorFlowRefs ?? []).map(
      (flowRef) => requireReadySharedFlow(flowRef, 'Behavior Flow'),
    ),
  );
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
    const selectedBehaviorBindings = await Promise.all(
      behaviorFlows.map((flow) => materializeSelectedBehavior(persona!, flow)),
    );
    const initialMemoryIds = await materializeInitialMemories(persona, input);

    if (persona.provisioningState !== 'ready') {
      const initialAppRefs = await resolveAvailablePersonaAppRefs(
        input.appRefs ?? roleVersion.capabilityRequirements?.preferredMcpServers ?? [],
      );
      await Promise.all(initialAppRefs.map((mcpServerName) => createPersonaAppGrant(
        PersonaAppGrantSchema.parse({
          schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
          id: personaAppGrantId(persona!.id, mcpServerName),
          personaId: persona!.id,
          mcpServerName,
          createdAt: persona!.createdAt,
          updatedAt: persona!.createdAt,
        }),
      )));
      persona = await updatePersonaWithinRuntimeLock(PersonaSchema.parse({
        ...persona,
        lifecycleState: 'idle',
        provisioningState: 'ready',
        coreMemoryItemIds: initialMemoryIds,
        composition: {
          description: '',
          ...(input.coreFlowRef ? { coreFlowRef: input.coreFlowRef } : {}),
          appRefs: initialAppRefs,
          memoryRefs: initialMemoryIds,
          behaviors: [
            ...roleVersion.behaviorSlots.map((slot, index) => ({
              ref: stableEnduringAgentId('behavior', {
                personaId: persona!.id,
                slotKey: slot.key,
              }),
              slotKey: slot.key,
              name: slot.name,
              ...(slot.description ? { description: slot.description } : {}),
              order: index,
            })),
            ...behaviorFlows.map((flow, index) => ({
              ref: selectedBehaviorBindings[index].id,
              slotKey: selectedBehaviorBindings[index].slotKey,
              name: flow.name,
              ...(flow.description ? { description: flow.description } : {}),
              order: roleVersion.behaviorSlots.length + index,
              binding: { mode: 'shared' as const, sharedFlowRef: flow.id },
            })),
          ],
        },
        updatedAt: Date.now(),
      }), lock);
    }

    const bundle = await listPersonaBundle(persona.id);
    if (!bundle) throw new Error(`Persona ${JSON.stringify(persona.id)} vanished after creation.`);
    return bundle;
  });
}
