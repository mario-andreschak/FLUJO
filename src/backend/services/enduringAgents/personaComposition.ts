import { validateFlowObjectForRun } from '@/backend/execution/flow/validateFlowForRun';
import { flowService } from '@/backend/services/flow';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import {
  CopyPersonaFlowInputSchema,
  PersonaCompositionSchema,
  PersonaSchema,
  UpdatePersonaCompositionInputSchema,
  type CopyPersonaFlowInput,
  type CopyPersonaFlowResult,
  type MemoryItem,
  type Persona,
  type PersonaBehaviorComposition,
  type PersonaComposition,
  type PersonaCompositionPreferences,
  type PersonaFlowBinding,
  type PersonaFlowCard,
  type PersonaRoleComposition,
  type UpdatePersonaCompositionInput,
} from '@/shared/types/enduringAgent';

import { behaviorCompositionFlowRefs } from './behaviorRevisions';
import { stableEnduringAgentId } from './ids';
import {
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
  withPersonaDomainMutation,
} from './domainMutation';
import {
  getMemoryItem,
  getRoleDefinition,
  listPersonaBundle,
  type PersonaBundle,
} from './store';

function missing(recordKind: string, recordId: string): never {
  throw new PersonaDomainNotFoundError(recordKind, recordId);
}

async function requireFlow(flowRef: string): Promise<void> {
  if (!await flowService.getFlow(flowRef)) missing('Flow', flowRef);
}

function normalizeBehaviorBinding(
  behavior: PersonaBehaviorComposition,
): PersonaFlowBinding | null {
  if (behavior.binding) return behavior.binding;
  if (behavior.overrideFlowRef) {
    return {
      mode: 'persona_copy',
      ...(behavior.sourceFlowRef ? { sharedFlowRef: behavior.sourceFlowRef } : {}),
      personaFlowRef: behavior.overrideFlowRef,
    };
  }
  return behavior.sourceFlowRef
    ? { mode: 'shared', sharedFlowRef: behavior.sourceFlowRef }
    : null;
}

function effectiveFlowRef(binding: PersonaFlowBinding): string {
  return binding.mode === 'shared' ? binding.sharedFlowRef : binding.personaFlowRef;
}

async function projectFlowCard(
  personaId: string,
  binding: PersonaFlowBinding,
): Promise<PersonaFlowCard> {
  const flowRef = effectiveFlowRef(binding);
  const flow = await flowService.getFlow(flowRef);
  if (!flow || (flow.personaOwnership && flow.personaOwnership.personaId !== personaId)) {
    return {
      binding,
      effectiveFlowRef: flowRef,
      readiness: { state: 'missing', issues: ['The selected Flow is unavailable.'] },
    };
  }
  const validation = await validateFlowObjectForRun(flow);
  const issues = validation.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);
  return {
    binding,
    effectiveFlowRef: flowRef,
    flow,
    readiness: {
      state: validation.isRunnable ? 'ready' : 'invalid',
      issues,
    },
  };
}

async function assertBindingOwnership(
  personaId: string,
  binding: PersonaFlowBinding,
): Promise<void> {
  const flow = await flowService.getFlow(effectiveFlowRef(binding));
  if (!flow) missing('Flow', effectiveFlowRef(binding));
  if (binding.mode === 'persona_copy') {
    if (!flow.personaOwnership || flow.personaOwnership.personaId !== personaId) {
      throw new PersonaDomainConflictError(
        'The selected Persona Flow copy is not owned by this Persona.',
      );
    }
    if (
      binding.sharedFlowRef
      && flow.personaOwnership.sourceFlowId
      && flow.personaOwnership.sourceFlowId !== binding.sharedFlowRef
    ) {
      throw new PersonaDomainConflictError(
        'The selected Persona Flow copy does not match its shared source.',
      );
    }
  } else if (flow.personaOwnership) {
    throw new PersonaDomainConflictError(
      'Persona-owned Flow copies must use copy mode.',
    );
  }
}

async function requireApps(appRefs: readonly string[]): Promise<void> {
  const configs = await loadServerConfigs();
  if (!Array.isArray(configs)) {
    throw new PersonaDomainConflictError(
      configs.error || 'MCP server configurations are currently unavailable.',
    );
  }
  for (const appRef of appRefs) {
    const config = configs.find((candidate) => candidate.name === appRef);
    if (!config) missing('MCPServerConfig', appRef);
    if (config.disabled === true || config.enableMcpApps !== true) {
      throw new PersonaDomainConflictError(
        `MCP App ${JSON.stringify(appRef)} is not enabled for direct use.`,
      );
    }
  }
}

async function requireMemories(persona: Persona, memoryRefs: readonly string[]): Promise<void> {
  for (const memoryRef of memoryRefs) {
    const memory = await getMemoryItem(memoryRef);
    // Missing and foreign references intentionally share one boundary error.
    if (!memory || memory.personaId !== persona.id) missing('MemoryItem', memoryRef);
    if (memory.status !== 'active') {
      throw new PersonaDomainConflictError(
        `MemoryItem ${JSON.stringify(memoryRef)} is not active.`,
      );
    }
    if (memory.trust !== 'explicit_user' && memory.trust !== 'verified_tool') {
      throw new PersonaDomainConflictError(
        `MemoryItem ${JSON.stringify(memoryRef)} is not eligible for core memory.`,
      );
    }
  }
}

async function requireRole(role: PersonaRoleComposition): Promise<void> {
  if (!await getRoleDefinition(role.ref)) missing('RoleDefinition', role.ref);
  await requireApps(role.suggestedAppRefs);
}

function memoryProjection(
  refs: readonly string[],
  items: readonly MemoryItem[],
): PersonaComposition['memories'] {
  return refs.map((ref) => {
    const item = items.find((candidate) => candidate.id === ref);
    if (!item) missing('MemoryItem', ref);
    return { ref: item.id, kind: item.kind, content: item.content };
  });
}

async function legacyBehaviorProjection(
  bundle: PersonaBundle,
): Promise<PersonaBehaviorComposition[]> {
  return Promise.all(bundle.behaviorBindings.map(async (binding) => {
    const revision = bundle.behaviorRevisions.find(
      (candidate) => candidate.id === binding.activeRevisionId,
    );
    if (!revision) missing('BehaviorRevision', binding.activeRevisionId);
    const slot = bundle.roleVersion.behaviorSlots.find(
      (candidate) => candidate.key === binding.slotKey,
    );

    const refs = behaviorCompositionFlowRefs(revision);
    const sourceFlowRef = refs.sourceFlowRef && await flowService.getFlow(refs.sourceFlowRef)
      ? refs.sourceFlowRef
      : undefined;
    const overrideFlowRef = refs.overrideFlowRef && await flowService.getFlow(refs.overrideFlowRef)
      ? refs.overrideFlowRef
      : undefined;

    return {
      ref: binding.id,
      name: slot?.name ?? binding.slotKey,
      ...(sourceFlowRef ? { sourceFlowRef } : {}),
      ...(overrideFlowRef ? { overrideFlowRef } : {}),
    };
  }));
}

async function ensureBehaviorAuthoringFlow(
  bundle: PersonaBundle,
  behavior: PersonaBehaviorComposition,
): Promise<PersonaBehaviorComposition> {
  if (normalizeBehaviorBinding(behavior)) return behavior;
  const durableBinding = bundle.behaviorBindings.find(
    (candidate) => candidate.id === behavior.ref,
  );
  if (!durableBinding) missing('BehaviorBinding', behavior.ref);
  const revision = bundle.behaviorRevisions.find(
    (candidate) => candidate.id === durableBinding.activeRevisionId,
  );
  if (!revision) missing('BehaviorRevision', durableBinding.activeRevisionId);

  const flowId = stableEnduringAgentId('personaflow', {
    personaId: bundle.persona.id,
    behaviorId: durableBinding.id,
  });
  let flow = await flowService.getFlow(flowId);
  if (!flow) {
    flow = {
      ...JSON.parse(JSON.stringify(revision.flowSnapshot)),
      id: flowId,
      name: `${behavior.name} · ${bundle.persona.name}`,
      createdAt: undefined,
      updatedAt: undefined,
      personaOwnership: { personaId: bundle.persona.id },
    };
    const saved = await flowService.saveFlow(flow);
    if (!saved.success) {
      throw new PersonaDomainConflictError(
        saved.error || 'The legacy Behavior Flow could not be migrated.',
      );
    }
  }
  return {
    ...behavior,
    binding: { mode: 'persona_copy', personaFlowRef: flowId },
    overrideFlowRef: flowId,
  };
}

async function projectBundle(bundle: PersonaBundle): Promise<PersonaComposition> {
  const { persona, roleVersion } = bundle;
  const preferences = persona.composition;
  const selectedRole = preferences?.role ?? {
    ref: roleVersion.roleDefinitionId,
    name: roleVersion.name,
    prompt: roleVersion.mission,
    suggestedAppRefs: roleVersion.capabilityRequirements?.preferredMcpServers ?? [],
  };
  if (preferences?.role) await requireRole(selectedRole);
  else if (!await getRoleDefinition(selectedRole.ref)) missing('RoleDefinition', selectedRole.ref);

  const coreBinding = preferences?.coreBinding
    ?? (preferences?.coreFlowRef
      ? { mode: 'shared' as const, sharedFlowRef: preferences.coreFlowRef }
      : undefined);
  const core = coreBinding
    ? await projectFlowCard(persona.id, coreBinding)
    : undefined;

  const appRefs = preferences?.appRefs ?? bundle.appGrants.map((grant) => grant.mcpServerName);
  await requireApps(appRefs);

  const memoryRefs = preferences?.memoryRefs ?? persona.coreMemoryItemIds ?? [];
  await requireMemories(persona, memoryRefs);

  const rawBehaviors = await Promise.all(
    (preferences?.behaviors ?? await legacyBehaviorProjection(bundle))
      .map((behavior) => ensureBehaviorAuthoringFlow(bundle, behavior)),
  );
  const behaviors = rawBehaviors.map((behavior, index) => {
    const durableBinding = bundle.behaviorBindings.find(
      (candidate) => candidate.id === behavior.ref,
    );
    if (!durableBinding) missing('BehaviorBinding', behavior.ref);
    const slot = roleVersion.behaviorSlots.find(
      (candidate) => candidate.key === durableBinding.slotKey,
    );
    return {
      ...behavior,
      slotKey: behavior.slotKey ?? durableBinding.slotKey,
      description: behavior.description ?? slot?.description,
      order: behavior.order ?? index,
    };
  }).sort((left, right) => (left.order ?? 0) - (right.order ?? 0));

  const behaviorCards = (await Promise.all(behaviors.map(async (behavior) => {
    const binding = normalizeBehaviorBinding(behavior);
    if (!binding) return null;
    const card = await projectFlowCard(persona.id, binding);
    return {
      ...card,
      ref: behavior.ref,
      slotKey: behavior.slotKey!,
      name: behavior.name,
      ...(behavior.description ? { description: behavior.description } : {}),
      order: behavior.order!,
    };
  }))).filter((card) => card !== null);

  return PersonaCompositionSchema.parse({
    personaRef: persona.id,
    name: persona.name,
    description: preferences?.description ?? '',
    role: selectedRole,
    ...(core ? { coreFlowRef: core.effectiveFlowRef, core } : {}),
    appRefs,
    memories: memoryProjection(memoryRefs, bundle.memoryItems),
    behaviors,
    behaviorCards,
    expectedUpdatedAt: persona.updatedAt,
  }) as PersonaComposition;
}

export async function readPersonaComposition(
  personaId: string,
): Promise<PersonaComposition | null> {
  let bundle = await listPersonaBundle(personaId);
  if (!bundle) return null;

  const configured = bundle.persona.composition?.behaviors;
  const needsMigration = !configured
    || configured.some((behavior) => !normalizeBehaviorBinding(behavior));
  if (needsMigration) {
    await withPersonaDomainMutation(personaId, {}, async ({ persona, updatePersona }) => {
      const currentBundle = await listPersonaBundle(personaId);
      if (!currentBundle) missing('Persona', personaId);
      const currentBehaviors = currentBundle.persona.composition?.behaviors
        ?? await legacyBehaviorProjection(currentBundle);
      const behaviors = await Promise.all(
        currentBehaviors.map((behavior) => ensureBehaviorAuthoringFlow(
          currentBundle,
          behavior,
        )),
      );
      await updatePersona(PersonaSchema.parse({
        ...persona,
        composition: {
          ...persona.composition,
          behaviors,
        },
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      }));
    });
    bundle = await listPersonaBundle(personaId);
    if (!bundle) return null;
  }

  return projectBundle(bundle);
}

async function validateUpdate(
  persona: Persona,
  bundle: PersonaBundle,
  input: UpdatePersonaCompositionInput,
): Promise<void> {
  if (input.role) await requireRole(input.role);
  if (input.coreFlowRef) {
    await assertBindingOwnership(persona.id, {
      mode: 'shared',
      sharedFlowRef: input.coreFlowRef,
    });
  }
  if (input.appRefs) await requireApps(input.appRefs);
  if (input.memoryRefs) await requireMemories(persona, input.memoryRefs);

  if (input.behaviors) {
    const orders = input.behaviors.map((behavior, index) => behavior.order ?? index);
    if (new Set(orders).size !== orders.length) {
      throw new PersonaDomainConflictError('Behavior order values must be unique.');
    }
    for (const behavior of input.behaviors) {
      const durableBinding = bundle.behaviorBindings.find(
        (candidate) => candidate.id === behavior.ref,
      );
      if (!durableBinding || durableBinding.personaId !== persona.id) {
        missing('BehaviorBinding', behavior.ref);
      }
      if (behavior.slotKey && behavior.slotKey !== durableBinding.slotKey) {
        throw new PersonaDomainConflictError(
          'A Behavior cannot be moved into another durable slot.',
        );
      }
      const selectedBinding = behavior.binding ?? (
        behavior.overrideFlowRef
          ? {
              mode: 'persona_copy' as const,
              sharedFlowRef: behavior.sourceFlowRef,
              personaFlowRef: behavior.overrideFlowRef,
            }
          : { mode: 'shared' as const, sharedFlowRef: behavior.sourceFlowRef! }
      );
      await assertBindingOwnership(persona.id, selectedBinding);
    }
  }
}

function nextPreferences(
  current: PersonaCompositionPreferences | undefined,
  input: UpdatePersonaCompositionInput,
): PersonaCompositionPreferences {
  return {
    ...current,
    ...(input.description !== undefined
      ? { description: input.description ?? undefined }
      : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.coreFlowRef !== undefined
      ? {
          coreFlowRef: input.coreFlowRef ?? undefined,
          coreBinding: input.coreFlowRef
            ? { mode: 'shared' as const, sharedFlowRef: input.coreFlowRef }
            : undefined,
        }
      : {}),
    ...(input.appRefs !== undefined ? { appRefs: input.appRefs } : {}),
    ...(input.memoryRefs !== undefined ? { memoryRefs: input.memoryRefs } : {}),
    ...(input.behaviors !== undefined
      ? {
          behaviors: input.behaviors.map((behavior, index) => {
            const binding = behavior.binding ?? (
              behavior.overrideFlowRef
                ? {
                    mode: 'persona_copy' as const,
                    ...(behavior.sourceFlowRef
                      ? { sharedFlowRef: behavior.sourceFlowRef }
                      : {}),
                    personaFlowRef: behavior.overrideFlowRef,
                  }
                : {
                    mode: 'shared' as const,
                    sharedFlowRef: behavior.sourceFlowRef!,
                  }
            );
            return {
              ref: behavior.ref,
              ...(behavior.slotKey ? { slotKey: behavior.slotKey } : {}),
              name: behavior.name,
              ...(behavior.description ? { description: behavior.description } : {}),
              order: behavior.order ?? index,
              binding,
              sourceFlowRef: binding.sharedFlowRef,
              ...(binding.mode === 'persona_copy'
                ? { overrideFlowRef: binding.personaFlowRef }
                : {}),
            };
          }),
        }
      : {}),
  };
}


/**
 * Create a canonical Persona-owned Flow copy and atomically switch the selected
 * Core/Behavior binding. The copy is retained as an ordinary detached Flow if
 * the binding is later reset or removed.
 */
export async function copyPersonaCompositionFlow(
  personaId: string,
  value: unknown,
): Promise<CopyPersonaFlowResult> {
  const input = CopyPersonaFlowInputSchema.parse(value) as CopyPersonaFlowInput;
  let copiedFlow: CopyPersonaFlowResult['flow'] | undefined;

  try {
    await withPersonaDomainMutation(personaId, {}, async ({ persona, updatePersona }) => {
      if (input.expectedUpdatedAt !== persona.updatedAt) {
        throw new PersonaDomainConflictError(
          'Persona composition changed since it was inspected.',
        );
      }
      if (persona.provisioningState === 'pending') {
        throw new PersonaDomainConflictError(
          'Persona composition cannot change while provisioning is pending.',
        );
      }
      const source = await flowService.getFlow(input.sourceFlowRef);
      if (!source) missing('Flow', input.sourceFlowRef);
      if (source.personaOwnership && source.personaOwnership.personaId !== persona.id) {
        throw new PersonaDomainConflictError(
          'A Flow copy owned by another Persona cannot be copied.',
        );
      }

      const cloned = await flowService.cloneFlowForPersona(
        input.sourceFlowRef,
        persona.id,
        `${source.name} · ${persona.name}`,
      );
      if (!cloned.success || !cloned.flow) {
        throw new PersonaDomainConflictError(
          cloned.error || 'The Persona Flow copy could not be created.',
        );
      }
      copiedFlow = cloned.flow;

      const current = persona.composition ?? {};
      let next: PersonaCompositionPreferences;
      if (input.target === 'core') {
        next = {
          ...current,
          coreFlowRef: cloned.flow.id,
          coreBinding: {
            mode: 'persona_copy',
            sharedFlowRef: input.sourceFlowRef,
            personaFlowRef: cloned.flow.id,
          },
        };
      } else {
        const behaviorRef = input.behaviorRef!;
        const behaviors = [...(current.behaviors ?? [])];
        const index = behaviors.findIndex((behavior) => behavior.ref === behaviorRef);
        if (index < 0) missing('BehaviorBinding', behaviorRef);
        const behavior = behaviors[index];
        behaviors[index] = {
          ...behavior,
          binding: {
            mode: 'persona_copy',
            sharedFlowRef: input.sourceFlowRef,
            personaFlowRef: cloned.flow.id,
          },
          sourceFlowRef: input.sourceFlowRef,
          overrideFlowRef: cloned.flow.id,
        };
        next = { ...current, behaviors };
      }

      await updatePersona(PersonaSchema.parse({
        ...persona,
        composition: next,
        updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
      }));
    });
  } catch (error) {
    if (copiedFlow) await flowService.deleteFlow(copiedFlow.id);
    throw error;
  }

  const composition = await readPersonaComposition(personaId);
  if (!composition || !copiedFlow) missing('Persona', personaId);
  return { composition, flow: copiedFlow };
}


/**
 * Validate the complete patch before one Persona-record commit. This keeps
 * mutable authoring references atomic without changing durable runtime records.
 */
export async function updatePersonaComposition(
  personaId: string,
  value: unknown,
): Promise<PersonaComposition> {
  const input = UpdatePersonaCompositionInputSchema.parse(value)
    as UpdatePersonaCompositionInput;

  await withPersonaDomainMutation(personaId, {}, async ({ persona, updatePersona }) => {
    if (input.expectedUpdatedAt !== persona.updatedAt) {
      throw new PersonaDomainConflictError(
        'Persona composition changed since it was inspected.',
      );
    }
    if (persona.provisioningState === 'pending') {
      throw new PersonaDomainConflictError(
        'Persona composition cannot change while provisioning is pending.',
      );
    }

    const bundle = await listPersonaBundle(personaId);
    if (!bundle) missing('Persona', personaId);
    await validateUpdate(persona, bundle, input);

    const composition = nextPreferences(persona.composition, input);
    await updatePersona(PersonaSchema.parse({
      ...persona,
      ...(input.name !== undefined ? { name: input.name } : {}),
      composition,
      ...(input.memoryRefs !== undefined
        ? { coreMemoryItemIds: input.memoryRefs }
        : {}),
      updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
    }));
  });

  const composition = await readPersonaComposition(personaId);
  if (!composition) missing('Persona', personaId);
  return composition;
}
