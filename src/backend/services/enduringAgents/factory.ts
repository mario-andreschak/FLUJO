import { createHash } from 'crypto';

import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import { modelService } from '@/backend/services/model';
import type { Flow } from '@/shared/types/flow';
import {
  BEHAVIOR_BINDING_SCHEMA_VERSION,
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorBindingSchema,
  BehaviorRevisionSchema,
  CreatePersonaInputSchema,
  DEFAULT_PERSONA_NATIVE_ABILITY_IDS,
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
  type PersonaPresentation,
  type RoleVersion,
} from '@/shared/types/enduringAgent';
import { createLogger } from '@/utils/logger';
import { generatedFlowName } from '@/utils/shared/flowNamePolicy';
import { assertSafeCollectionId } from '@/utils/storage/backend';

import {
  behaviorRevisionId,
  bindDefaultModelToFlow,
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

const log = createLogger('backend/services/enduringAgents/factory');

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

function withDefaultPersonaAbilities(source: Flow): Flow {
  const flow = structuredClone(source);
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const data = node.data as typeof node.data & {
      properties?: Record<string, unknown> & { personaTools?: unknown };
    };
    const properties = data.properties ?? {};
    if (properties.personaTools === undefined) {
      properties.personaTools = [...DEFAULT_PERSONA_NATIVE_ABILITY_IDS];
    }
    data.properties = properties;
  }
  return flow;
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

function editablePersonaPresentation(
  presentation: PersonaPresentation | undefined,
): Pick<PersonaPresentation, 'avatarUrl' | 'language'> | undefined {
  if (!presentation) return undefined;
  const editable = {
    ...(presentation.avatarUrl ? { avatarUrl: presentation.avatarUrl } : {}),
    ...(presentation.language ? { language: presentation.language } : {}),
  };
  return Object.keys(editable).length > 0 ? editable : undefined;
}

function effectiveFactoryRequest(
  input: CreatePersonaInput,
  roleVersion: RoleVersion,
): Record<string, unknown> {
  const presentation = editablePersonaPresentation(
    input.presentation ?? roleVersion.defaults?.presentation,
  );
  return {
    name: input.name,
    coreFlowRef: input.coreFlowRef ?? null,
    roleVersionId: roleVersion.id,
    appRefs: input.appRefs ?? null,
    ...(input.behaviorFlowRefs?.length
      ? { behaviorFlowRefs: input.behaviorFlowRefs }
      : {}),
    mission: input.mission ?? roleVersion.mission,
    presentation: presentation ?? null,
    // New Personas safely learn by default: memory remains reviewable and
    // Behavior changes still require the owner unless the Role says otherwise.
    autonomyLevel:
      input.autonomyLevel ?? roleVersion.defaults?.autonomyLevel ?? 'propose_overrides',
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
  preparedTemplate: Flow,
): Promise<BehaviorBinding> {
  const behaviorId = stableEnduringAgentId('behavior', {
    personaId: persona.id,
    slotKey: slot.key,
  });
  const flow = snapshotBehaviorFlow({
    ...preparedTemplate,
    id: stableEnduringAgentId('flow', { behaviorId, revision: 1 }),
    name: generatedFlowName(`${persona.name} ${slot.name}`, [], behaviorId),
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
  return createBehaviorBindingIfAbsent(binding);
}

function personaFlowGroupId(personaId: string): string {
  return stableEnduringAgentId('personaflowgroup', { personaId });
}

function firstBoundModel(flow?: Flow): string | undefined {
  return flow?.nodes.find((node) => (
    node.data.type === 'process'
    && typeof node.data.properties?.boundModel === 'string'
    && node.data.properties.boundModel
  ))?.data.properties?.boundModel as string | undefined;
}

async function resolveDefaultModelId(
  roleVersion: RoleVersion,
  coreTemplate: Flow,
): Promise<string | undefined> {
  const authoredDefault = roleVersion.defaultModelId ?? firstBoundModel(coreTemplate);
  if (authoredDefault) return authoredDefault;

  // A sole configured model is the only unambiguous workspace fallback. With
  // zero or multiple models, provisioning must stay blocked rather than pick an
  // arbitrary provider/model.
  const models = await modelService.loadModels();
  return models.length === 1 ? models[0].id : undefined;
}

async function requireRunnableGeneratedFlow(flow: Flow, label: string): Promise<Flow> {
  const readiness = await validateFlowObjectForRun(flow);
  if (!readiness.isRunnable) {
    const issues = readiness.issues
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.message);
    throw new PersonaFactoryConflictError(
      `${label} is not runnable.${issues.length ? ` ${issues.join(' ')}` : ''}`,
    );
  }
  return flow;
}

async function savePersonaOwnedFlow(input: {
  persona: Persona;
  source: Flow;
  id: string;
  name: string;
  sourceFlowId?: string;
  kind: 'core' | 'role_behavior' | 'supplemental';
}): Promise<Flow> {
  const existing = await flowService.getFlow(input.id);
  if (existing) {
    if (existing.personaOwnership?.personaId !== input.persona.id) {
      throw new PersonaFactoryConflictError('A generated Persona Flow has conflicting ownership.');
    }
    return existing;
  }

  const flow: Flow = {
    ...JSON.parse(JSON.stringify(input.source)),
    id: input.id,
    name: generatedFlowName(input.name, [], input.id),
    folder: `Persona ${input.persona.name}`,
    favorite: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    personaOwnership: {
      personaId: input.persona.id,
      ...(input.sourceFlowId ? { sourceFlowId: input.sourceFlowId } : {}),
      groupId: personaFlowGroupId(input.persona.id),
      kind: input.kind,
    },
  };
  const saved = await flowService.saveFlow(flow);
  if (!saved.success) {
    throw new PersonaFactoryConflictError(
      saved.error || 'A generated Persona Flow could not be saved.',
    );
  }
  return flow;
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
  const selectedCoreFlow = input.coreFlowRef
    ? await requireReadySharedFlow(input.coreFlowRef, 'Core Flow')
    : undefined;
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
    const coreTemplate = selectedCoreFlow ?? roleVersion.coreFlowTemplate;
    if (!coreTemplate) {
      log.warn('Persona provisioning rejected: no Core template', {
        roleVersionId: roleVersion.id,
        expectedSlotCount: roleVersion.behaviorSlots.length,
        failureCategory: 'missing_core_template',
      });
      throw new PersonaFactoryConflictError(
        'The selected Role has no Core template. Choose a ready Core Flow and try again.',
      );
    }
    if (roleVersion.behaviorSlots.length === 0) {
      throw new PersonaFactoryConflictError(
        'The selected Role version has no usable required Behaviors.',
      );
    }

    const defaultModelId = await resolveDefaultModelId(roleVersion, coreTemplate as Flow);
    const preparedCore = await requireRunnableGeneratedFlow(
      bindDefaultModelToFlow(withDefaultPersonaAbilities(coreTemplate as Flow), defaultModelId),
      'Core Flow',
    );
    const preparedRoleFlows = await Promise.all(roleVersion.behaviorSlots.map(
      (slot) => requireRunnableGeneratedFlow(
        bindDefaultModelToFlow(slot.flowTemplate as Flow, defaultModelId),
        `Required Behavior ${JSON.stringify(slot.key)}`,
      ),
    ));
    log.info('Persona Role version validated for provisioning', {
      roleVersionId: roleVersion.id,
      expectedSlotCount: roleVersion.behaviorSlots.length,
      failureCategory: null,
    });

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
      const presentation = editablePersonaPresentation(
        input.presentation ?? roleVersion.defaults?.presentation,
      );
      persona = PersonaSchema.parse({
        schemaVersion: PERSONA_SCHEMA_VERSION,
        id: personaId,
        name: input.name,
        roleVersionId: roleVersion.id,
        lifecycleState: 'disabled',
        mission: input.mission ?? roleVersion.mission,
        ...(presentation ? { presentation } : {}),
        autonomyLevel:
          input.autonomyLevel
          ?? roleVersion.defaults?.autonomyLevel
          ?? 'propose_overrides',
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

    const roleBehaviorBindings = await Promise.all(
      roleVersion.behaviorSlots.map((slot, index) => (
        materializeBehavior(persona!, roleVersion, slot, preparedRoleFlows[index])
      )),
    );
    const roleBehaviorFlows = await Promise.all(roleVersion.behaviorSlots.map((slot, index) => (
      savePersonaOwnedFlow({
        persona: persona!,
        source: preparedRoleFlows[index],
        id: stableEnduringAgentId('personaflow', {
          personaId: persona!.id,
          behaviorId: roleBehaviorBindings[index].id,
        }),
        name: `${persona!.name} ${slot.name}`,
        sourceFlowId: slot.flowTemplate.id,
        kind: 'role_behavior',
      })
    )));
    const selectedBehaviorBindings = await Promise.all(
      behaviorFlows.map((flow) => materializeSelectedBehavior(persona!, flow)),
    );
    const supplementalFlows = await Promise.all(behaviorFlows.map((flow) => (
      savePersonaOwnedFlow({
        persona: persona!,
        source: flow,
        id: stableEnduringAgentId('personaflow', {
          personaId: persona!.id,
          sourceFlowId: flow.id,
          kind: 'supplemental',
        }),
        name: `${persona!.name} ${flow.name}`,
        sourceFlowId: flow.id,
        kind: 'supplemental',
      })
    )));
    const coreFlow = await savePersonaOwnedFlow({
      persona: persona!,
      source: preparedCore,
      id: stableEnduringAgentId('personaflow', {
        personaId: persona!.id,
        kind: 'core',
      }),
      name: `${persona!.name} Core`,
      sourceFlowId: coreTemplate.id,
      kind: 'core',
    });
    const initialMemoryIds = await materializeInitialMemories(persona, input);

    log.info('Persona Flows materialized', {
      roleVersionId: roleVersion.id,
      expectedSlotCount: roleVersion.behaviorSlots.length,
      materializedBindingCount: roleBehaviorBindings.length,
      supplementalCount: supplementalFlows.length,
      failureCategory: null,
    });

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
          coreFlowRef: coreFlow.id,
          coreBinding: {
            mode: 'persona_copy',
            ...(selectedCoreFlow ? { sharedFlowRef: selectedCoreFlow.id } : {}),
            personaFlowRef: coreFlow.id,
          },
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
              binding: {
                mode: 'persona_copy' as const,
                personaFlowRef: roleBehaviorFlows[index].id,
              },
            })),
            ...behaviorFlows.map((flow, index) => ({
              ref: selectedBehaviorBindings[index].id,
              slotKey: selectedBehaviorBindings[index].slotKey,
              name: flow.name,
              ...(flow.description ? { description: flow.description } : {}),
              order: roleVersion.behaviorSlots.length + index,
              binding: {
                mode: 'persona_copy' as const,
                sharedFlowRef: flow.id,
                personaFlowRef: supplementalFlows[index].id,
              },
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
