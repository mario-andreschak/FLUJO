import {
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_INTERRUPTION_POLICIES,
  PersonaSettingsOptionsSchema,
  type PersonaSettingsOptions,
} from '@/shared/types/enduringAgent';

import { ensureBuiltInDeveloperRole } from './builtInRoleStore';
import { listRoleDefinitions, listRoleVersions } from './store';

const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'zh', label: '中文' },
] as const;

/**
 * Workspace-owned settings choices. Provider-dependent choices remain absent
 * until a provider exposes a stable catalog and a working end-to-end action.
 */
export async function getPersonaSettingsOptions(): Promise<PersonaSettingsOptions> {
  await ensureBuiltInDeveloperRole();
  const [definitions, versions] = await Promise.all([
    listRoleDefinitions(),
    listRoleVersions(),
  ]);
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const roles = definitions.flatMap((definition) => {
    if (definition.archivedAt !== undefined || !definition.currentVersionId) return [];
    const version = versionById.get(definition.currentVersionId);
    if (!version || !version.behaviorSlots.some((slot) => slot.key === 'primary')) return [];
    return [{
      roleVersionId: version.id,
      name: definition.name,
      ...(version.mission ? { description: version.mission } : {}),
    }];
  }).sort((left, right) => left.name.localeCompare(right.name));

  return PersonaSettingsOptionsSchema.parse({
    roles,
    languages: LANGUAGE_OPTIONS,
    lifecycleStates: ['idle', 'sleeping', 'disabled'],
    autonomyLevels: PERSONA_AUTONOMY_LEVELS,
    interruptionPolicies: PERSONA_INTERRUPTION_POLICIES,
  });
}
