import type { Flow } from '@/shared/types/flow';
import type { PersonaAttribution, PersonaInstructionContext } from '@/shared/types/enduringAgent';
import { behaviorFlowMatchesContentHash } from '@/backend/services/enduringAgents/behaviorRevisions';

/**
 * Compare the attributed Persona context and its immutable Behavior snapshot.
 * runFlow owns schema parsing, top-level admission, authority, and operation order.
 */
export function instructionContextsEqual(
  left: PersonaInstructionContext,
  right: PersonaInstructionContext,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.personaId === right.personaId
    && left.activityId === right.activityId
    && left.behaviorRevisionId === right.behaviorRevisionId
    && left.behaviorContentHash === right.behaviorContentHash
    && left.behaviorSlotKey === right.behaviorSlotKey
    && left.rootFlowId === right.rootFlowId
    && left.roleVersionId === right.roleVersionId
    && left.personaName === right.personaName
    && left.personaMission === right.personaMission
    && left.roleName === right.roleName
    && left.roleMission === right.roleMission
    && left.instruction === right.instruction;
}

export function assertInstructionContextAttribution(
  context: PersonaInstructionContext,
  attribution: PersonaAttribution | undefined,
  label: string,
): void {
  if (
    !attribution
    || context.personaId !== attribution.personaId
    || context.activityId !== attribution.activityId
    || context.behaviorRevisionId !== attribution.behaviorRevisionId
  ) {
    throw new Error(`${label} Persona instruction context does not match its attribution triple.`);
  }
}

export function assertBehaviorSnapshotMatchesInstructionContext(
  flow: Flow,
  context: PersonaInstructionContext,
  label: string,
): void {
  if (flow.id !== context.rootFlowId) {
    throw new Error(`${label} Behavior snapshot does not match the Persona instruction root Flow.`);
  }
  if (!behaviorFlowMatchesContentHash(flow, context.behaviorContentHash)) {
    throw new Error(`${label} Behavior snapshot does not match the attributed immutable revision.`);
  }
}
