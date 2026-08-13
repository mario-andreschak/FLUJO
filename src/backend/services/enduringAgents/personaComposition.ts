import { flowService } from '@/backend/services/flow';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import {
  PersonaCompositionSchema,
  PersonaSchema,
  UpdatePersonaCompositionInputSchema,
  type MemoryItem,
  type Persona,
  type PersonaBehaviorComposition,
  type PersonaComposition,
  type PersonaCompositionPreferences,
  type PersonaRoleComposition,
  type UpdatePersonaCompositionInput,
} from '@/shared/types/enduringAgent';

import { behaviorCompositionFlowRefs } from './behaviorRevisions';
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

  if (preferences?.coreFlowRef) await requireFlow(preferences.coreFlowRef);
  const appRefs = preferences?.appRefs ?? bundle.appGrants.map((grant) => grant.mcpServerName);
  await requireApps(appRefs);

  const memoryRefs = preferences?.memoryRefs ?? persona.coreMemoryItemIds ?? [];
  await requireMemories(persona, memoryRefs);

  const behaviors = preferences?.behaviors ?? await legacyBehaviorProjection(bundle);
  for (const behavior of behaviors) {
    const binding = bundle.behaviorBindings.find((candidate) => candidate.id === behavior.ref);
    if (!binding) missing('BehaviorBinding', behavior.ref);
    if (behavior.sourceFlowRef) await requireFlow(behavior.sourceFlowRef);
    if (behavior.overrideFlowRef) await requireFlow(behavior.overrideFlowRef);
  }

  return PersonaCompositionSchema.parse({
    personaRef: persona.id,
    name: persona.name,
    description: preferences?.description ?? '',
    role: selectedRole,
    ...(preferences?.coreFlowRef ? { coreFlowRef: preferences.coreFlowRef } : {}),
    appRefs,
    memories: memoryProjection(memoryRefs, bundle.memoryItems),
    behaviors,
    expectedUpdatedAt: persona.updatedAt,
  }) as PersonaComposition;
}

export async function readPersonaComposition(
  personaId: string,
): Promise<PersonaComposition | null> {
  const bundle = await listPersonaBundle(personaId);
  return bundle ? projectBundle(bundle) : null;
}

async function validateUpdate(
  persona: Persona,
  bundle: PersonaBundle,
  input: UpdatePersonaCompositionInput,
): Promise<void> {
  if (input.role) await requireRole(input.role);
  if (input.coreFlowRef) await requireFlow(input.coreFlowRef);
  if (input.appRefs) await requireApps(input.appRefs);
  if (input.memoryRefs) await requireMemories(persona, input.memoryRefs);

  if (input.behaviors) {
    for (const behavior of input.behaviors) {
      const binding = bundle.behaviorBindings.find((candidate) => candidate.id === behavior.ref);
      if (!binding || binding.personaId !== persona.id) {
        missing('BehaviorBinding', behavior.ref);
      }
      await requireFlow(behavior.sourceFlowRef);
      if (behavior.overrideFlowRef) await requireFlow(behavior.overrideFlowRef);
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
      ? { coreFlowRef: input.coreFlowRef ?? undefined }
      : {}),
    ...(input.appRefs !== undefined ? { appRefs: input.appRefs } : {}),
    ...(input.memoryRefs !== undefined ? { memoryRefs: input.memoryRefs } : {}),
    ...(input.behaviors !== undefined
      ? {
          behaviors: input.behaviors.map((behavior) => ({
            ref: behavior.ref,
            name: behavior.name,
            sourceFlowRef: behavior.sourceFlowRef,
            ...(behavior.overrideFlowRef
              ? { overrideFlowRef: behavior.overrideFlowRef }
              : {}),
          })),
        }
      : {}),
  };
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
