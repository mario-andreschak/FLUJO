import { buildDefaultRoleBehaviorSlots } from '@/backend/services/enduringAgents/roleBehaviorDefaults';
import { translate } from '@/frontend/i18n/core';
import type { SupportedLocale } from '@/frontend/i18n/locales';
import { localizeRoleBehavior } from '@/frontend/utils/roleBehaviorLabels';

const defaults = buildDefaultRoleBehaviorSlots('role_test', 'Test');

describe('Role default labels', () => {
  it.each(['en', 'es', 'de', 'fr', 'it', 'pt', 'zh'] as SupportedLocale[])(
    'localizes platform labels in %s without mutating stored Role templates', (locale) => {
      const original = JSON.stringify(defaults);
      const localized = defaults.map((behavior) => localizeRoleBehavior(behavior, (key) => translate(locale, key)));
      expect(localized.map(({ name }) => name)).toEqual([
        translate(locale, 'roles.behavior.primary.name'),
        translate(locale, 'roles.behavior.memory.name'),
      ]);
      expect(localized.map(({ description }) => description)).toEqual([
        translate(locale, 'roles.behavior.primary.description'),
        translate(locale, 'roles.behavior.memory.description'),
      ]);
      expect(JSON.stringify(defaults)).toBe(original);
    },
  );

  it('keeps owner-authored labels verbatim, including labels on reserved slots', () => {
    const t = (key: Parameters<typeof translate>[1]) => translate('de', key);
    for (const behavior of defaults) {
      for (const custom of [
        { ...behavior, name: 'My own behavior' },
        { ...behavior, description: 'My own instructions' },
        { ...behavior, description: undefined },
        { ...behavior, key: 'custom' },
      ]) {
        expect(localizeRoleBehavior(custom, t)).toBe(custom);
      }
    }
  });
});
