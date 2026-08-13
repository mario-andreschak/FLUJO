import type { PersonaSummary } from '@/frontend/services/personas/summary';

export interface PersonaActionCapabilities {
  talk: boolean;
  open: boolean;
  assign: boolean;
  call: boolean;
}

/**
 * The API projection is authoritative. In particular, voice presentation
 * metadata never promotes Call into a working action.
 */
export function personaCapabilities(
  summary: PersonaSummary,
): PersonaActionCapabilities {
  return {
    talk: summary.capabilities.talk,
    open: summary.capabilities.open,
    assign: summary.capabilities.assign,
    call: summary.capabilities.call,
  };
}
