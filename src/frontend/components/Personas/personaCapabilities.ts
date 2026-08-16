import type { PersonaSummary } from '@/frontend/services/personas/summary';

export interface PersonaActionCapabilities {
  talk: boolean;
  open: boolean;
  assign: boolean;
}

/** The summary projection is authoritative for actions the UI can actually run. */
export function personaCapabilities(
  summary: PersonaSummary,
): PersonaActionCapabilities {
  return {
    talk: summary.capabilities.talk,
    open: summary.capabilities.open,
    assign: summary.capabilities.assign,
  };
}
