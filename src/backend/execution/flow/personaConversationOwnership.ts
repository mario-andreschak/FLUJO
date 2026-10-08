/**
 * Capability-free markers that make a conversation part of the Persona
 * control plane. Draft targets and frozen instruction contexts are ownership
 * signals even before (or if corruption prevents) the full attribution triple
 * from being stamped.
 */
export interface PersonaConversationOwnershipMarkers {
  personaAttribution?: unknown;
  personaTargetId?: unknown;
  personaInstructionContext?: unknown;
  personaArchived?: unknown;
  /** Legacy summary/import marker. */
  personaOwned?: unknown;
}

export function isPersonaOwnedConversationState(
  state: PersonaConversationOwnershipMarkers | null | undefined,
): boolean {
  return Boolean(state && (
    Object.prototype.hasOwnProperty.call(state, 'personaAttribution')
    || Object.prototype.hasOwnProperty.call(state, 'personaTargetId')
    || Object.prototype.hasOwnProperty.call(state, 'personaInstructionContext')
    || state.personaArchived === true
    || state.personaOwned === true
  ));
}
