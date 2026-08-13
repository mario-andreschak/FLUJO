import {
  type PersonaInstructionContext,
} from '@/shared/types/enduringAgent';

import { stableEnduringAgentId } from './ids';
import { getCoreMemory } from './memoryKernel';
import {
  createPersonaActivitySnapshot,
} from './personaActivitySnapshot';
import { buildPersonaInstructionContext } from './personaInstructionContext';
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
  precedence: readonly string[];
  readOnly: true;
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
  const primaryBindings = (await listBehaviorBindings(persona.id)).filter(
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
  const snapshot = createPersonaActivitySnapshot({
    activity: {
      id: activityId,
      personaId: persona.id,
      behaviorId: binding.id,
      behaviorRevisionId: revision.id,
    },
    revision,
    context: instructionContext,
  });

  return {
    personaId: persona.id,
    activityId,
    ...(persona.composition?.coreFlowRef
      ? { coreFlowRef: persona.composition.coreFlowRef }
      : {}),
    coreFlowId: snapshot.coreFlowId,
    coreFlowRevisionId: snapshot.coreFlowRevisionId,
    behaviorRevisionId: revision.id,
    roleVersionId: roleVersion.id,
    instructionContext: snapshot.instructionContext,
    instructionContextDigest: snapshot.instructionContextDigest,
    precedence: PERSONA_CONTEXT_PRECEDENCE,
    readOnly: true,
  };
}
