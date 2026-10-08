import { buildDefaultRoleBehaviorSlots } from '@/backend/services/enduringAgents/roleBehaviorDefaults';
import { translate } from '@/frontend/i18n/core';
import type { SupportedLocale } from '@/frontend/i18n/locales';
import type { Flow } from '@/frontend/types/flow/flow';
import { localizePersonaFlow } from '@/frontend/utils/personaFlowLabels';
import { generatedFlowName } from '@/utils/shared/flowNamePolicy';

const persona = { id: 'alex', name: 'Alex' };
const [primary, maintenance] = buildDefaultRoleBehaviorSlots('role', 'My Role');
const defaults: Flow[] = [
  { ...primary.flowTemplate, name: 'Alex Core', personaOwnership: { personaId: 'alex', kind: 'core' } },
  { ...primary.flowTemplate, name: 'Alex Primary', personaOwnership: { personaId: 'alex', kind: 'role_behavior' } },
  { ...maintenance.flowTemplate, name: 'Alex Maintain memory', personaOwnership: { personaId: 'alex', kind: 'role_behavior' } },
];

it.each(['en', 'es', 'de', 'fr', 'it', 'pt', 'zh'] as SupportedLocale[])('localizes generated Persona Flow copy in %s without changing execution data', locale => {
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate(locale, key, values);
  const original = JSON.stringify(defaults);
  const labels = ['personas.behaviors.core', 'roles.behavior.primary.name', 'roles.behavior.memory.name'] as const;
  defaults.forEach((flow, index) => {
    const localized = localizePersonaFlow(flow, persona, t);
    expect(localized.name).toBe(t('personas.flows.generatedName', { persona: 'Alex', behavior: t(labels[index]) }));
    expect(localized.description).toBe(t(index === 2 ? 'personas.flows.generatedMemoryDescription' : 'personas.flows.generatedPrimaryDescription'));
    expect(localized.id).toBe(flow.id);
    expect(localized.nodes).toBe(flow.nodes);
    expect(localized.edges).toBe(flow.edges);
    expect(localized.personaOwnership).toBe(flow.personaOwnership);
  });
  expect(JSON.stringify(defaults)).toBe(original);
});

it('preserves edited, shared, foreign and custom-source Flow copy', () => {
  const t = (key: Parameters<typeof translate>[1]) => translate('de', key);
  for (const flow of defaults) {
    for (const custom of [
      { ...flow, name: 'My custom Flow' },
      { ...flow, description: 'My instructions' },
      { ...flow, description: undefined },
      { ...flow, personaOwnership: undefined },
      { ...flow, personaOwnership: { personaId: 'someone-else', kind: 'core' as const } },
      { ...flow, personaOwnership: { personaId: 'alex', kind: 'custom' as const } },
    ]) expect(localizePersonaFlow(custom, persona, t)).toBe(custom);
    expect(localizePersonaFlow(flow, { ...persona, name: 'Renamed Alex' }, t)).toBe(flow);
  }
});

it('recognizes the factory’s sanitized generated name while retaining the Persona’s chosen name', () => {
  const named = { ...persona, name: 'Alex / Zürich' };
  const flow = { ...defaults[2], name: generatedFlowName(`${named.name} Maintain memory`) };
  const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate('de', key, values);
  expect(localizePersonaFlow(flow, named, t).name).toBe('Alex / Zürich · Erinnerungen pflegen');
});
