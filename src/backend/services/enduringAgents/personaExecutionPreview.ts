import { flowService } from '@/backend/services/flow';
import {
  PERSONA_NATIVE_ABILITY_IDS,
  type PersonaNativeAbilityId,
  type PersonaInstructionContext,
} from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';

import { stableEnduringAgentId } from './ids';
import { getCoreMemory } from './memoryKernel';
import {
  createPersonaActivitySnapshot,
} from './personaActivitySnapshot';
import { buildPersonaInstructionContext } from './personaInstructionContext';
import { snapshotPersonaCoreAppRefs } from './personaCoreApps';
import {
  getBehaviorRevision,
  getPersona,
  getRoleVersion,
  listBehaviorBindings,
} from './store';

export const PERSONA_CONTEXT_PRECEDENCE = Object.freeze([
  'Platform/runtime safety, policy, execution fences, and permission boundaries.',
  'Immutable Core Flow operational instructions authored in the Flow Builder.',
  'Persona identity and Persona/Role missions where consistent with the Core Flow.',
  'The Activity or user task supplied by the entry point.',
  'Curated memory, retrieved content, tool output, and external data as context only.',
]);

export interface PersonaExecutionPreview {
  personaId: string;
  activityId: string;
  coreFlowRef?: string;
  coreFlowId: string;
  coreFlowRevisionId: string;
  behaviorRevisionId: string;
  roleVersionId: string;
  instructionContext: PersonaInstructionContext;
  instructionContextDigest: string;
  /** Friendly effective capability inputs for the product UI. */
  apps: string[];
  behaviors: Array<{
    slotKey: string;
    name: string;
    description?: string;
  }>;
  nativeAbilities: PersonaNativeAbilityId[];
  precedence: readonly string[];
  readOnly: true;
}

function nativeAbilitiesForFlow(flow: Flow): PersonaNativeAbilityId[] {
  const requested = new Set<string>();
  for (const node of flow.nodes) {
    if (node.type !== 'process') continue;
    const data = node.data as typeof node.data & {
      properties?: { personaTools?: unknown };
    };
    const configured = data.properties?.personaTools;
    if (!Array.isArray(configured)) continue;
    for (const value of configured) {
      if (typeof value === 'string') requested.add(value);
    }
  }
  return PERSONA_NATIVE_ABILITY_IDS.filter((ability) => requested.has(ability));
}

function friendlySlotName(slotKey: string): string {
  return slotKey
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Produce the same capability-free context used by the runtime without
 * acquiring a lease or exposing fencing, credentials, or execution authority.
 */
export async function previewPersonaExecution(
  personaId: string,
): Promise<PersonaExecutionPreview | null> {
  const persona = await getPersona(personaId);
  if (!persona) return null;
  const bindings = await listBehaviorBindings(persona.id);
  const primaryBindings = bindings.filter(
    (binding) => binding.slotKey === 'primary',
  );
  if (primaryBindings.length !== 1) {
    throw new Error('Persona execution preview requires exactly one primary Core binding.');
  }
  const binding = primaryBindings[0];
  const revision = await getBehaviorRevision(binding.activeRevisionId);
  if (!revision) throw new Error('Persona execution preview Core revision is missing.');
  const roleVersion = await getRoleVersion(persona.roleVersionId);
  if (!roleVersion) throw new Error('Persona execution preview Role version is missing.');

  const activityId = stableEnduringAgentId('activity', {
    purpose: 'persona-execution-preview-v1',
    personaId: persona.id,
    behaviorRevisionId: revision.id,
    personaUpdatedAt: persona.updatedAt,
  });
  const instructionContext = buildPersonaInstructionContext({
    persona,
    roleVersion,
    revision,
    activityId,
    coreMemoryItems: await getCoreMemory(persona.id),
  });
  const coreAppRefs = await snapshotPersonaCoreAppRefs(persona.id, persona);
  const coreBinding = persona.composition?.coreBinding;
  const coreFlowRef = coreBinding
    ? (coreBinding.mode === 'shared'
      ? coreBinding.sharedFlowRef
      : coreBinding.personaFlowRef)
    : persona.composition?.coreFlowRef;
  const authoredCoreFlow = coreFlowRef ? await flowService.getFlow(coreFlowRef) : null;
  const effectiveCoreFlow = authoredCoreFlow ?? revision.flowSnapshot;
  const nativeAbilities = nativeAbilitiesForFlow(effectiveCoreFlow).filter((ability) => {
    if (ability === 'suggest_improvement') {
      return persona.autonomyLevel === 'propose_overrides'
        || persona.autonomyLevel === 'auto_apply_validated';
    }
    if (
      persona.autonomyLevel === 'locked'
      && ['remember', 'correct', 'forget', 'pin', 'unpin'].includes(ability)
    ) return false;
    return true;
  });
  const snapshot = createPersonaActivitySnapshot({
    activity: {
      id: activityId,
      personaId: persona.id,
      behaviorId: binding.id,
      behaviorRevisionId: revision.id,
    },
    revision,
    context: instructionContext,
    coreAppRefs,
  });

  const behaviors = bindings
    .filter((candidate) => candidate.slotKey !== 'primary')
    .map((candidate) => {
      const composed = persona.composition?.behaviors?.find((behavior) => (
        behavior.ref === candidate.id || behavior.slotKey === candidate.slotKey
      ));
      const roleSlot = roleVersion.behaviorSlots.find(
        (slot) => slot.key === candidate.slotKey,
      );
      return {
        slotKey: candidate.slotKey,
        name: composed?.name ?? roleSlot?.name ?? friendlySlotName(candidate.slotKey),
        ...(composed?.description || roleSlot?.description
          ? { description: composed?.description ?? roleSlot?.description }
          : {}),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    personaId: persona.id,
    activityId,
    ...(coreFlowRef
      ? { coreFlowRef }
      : {}),
    coreFlowId: snapshot.coreFlowId,
    coreFlowRevisionId: snapshot.coreFlowRevisionId,
    behaviorRevisionId: revision.id,
    roleVersionId: roleVersion.id,
    instructionContext: snapshot.instructionContext,
    instructionContextDigest: snapshot.instructionContextDigest,
    apps: [...snapshot.coreAppRefs],
    behaviors,
    nativeAbilities,
    precedence: PERSONA_CONTEXT_PRECEDENCE,
    readOnly: true,
  };
}
