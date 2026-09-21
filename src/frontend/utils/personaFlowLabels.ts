import type { Translator } from '@/frontend/i18n/core';
import type { Flow } from '@/frontend/types/flow/flow';
import { generatedFlowName } from '@/utils/shared/flowNamePolicy';

/** Presentation only: keep authoring records and immutable execution snapshots intact. */
export function localizePersonaFlow(
  flow: Flow,
  persona: { id: string; name: string },
  t: Translator,
): Flow {
  if (flow.personaOwnership?.personaId !== persona.id || !persona.name) return flow;
  const kind = flow.personaOwnership.kind;
  let behavior: string;
  let description: string;
  if ((kind === 'core' || kind === 'role_behavior')
    && flow.description === 'Internal primary Flow for this Role.'
    && flow.name === generatedFlowName(`${persona.name} ${kind === 'core' ? 'Core' : 'Primary'}`)) {
    behavior = t(kind === 'core' ? 'personas.behaviors.core' : 'roles.behavior.primary.name');
    description = t('personas.flows.generatedPrimaryDescription');
  } else if (kind === 'role_behavior'
    && flow.description === 'Restricted, evidence-preserving candidate-memory proposal behavior.'
    && flow.name === generatedFlowName(`${persona.name} Maintain memory`)) {
    behavior = t('roles.behavior.memory.name');
    description = t('personas.flows.generatedMemoryDescription');
  } else {
    // Names and descriptions are editable. A reserved owner/kind alone never
    // grants permission to reinterpret an author's copy as a platform label.
    return flow;
  }
  return { ...flow, name: t('personas.flows.generatedName', { persona: persona.name, behavior }), description };
}
