import {
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_INTERRUPTION_POLICIES,
  PersonaSettingsOptionsSchema,
  type PersonaSettingsOptions,
} from '@/shared/types/enduringAgent';

import {
  listRoleDefinitions,
  listRoleVersions,
} from './store';

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
  const [definitions, versions] = await Promise.all([
    listRoleDefinitions(),
    listRoleVersions(),
  ]);
  const definitionsById = new Map(
    definitions
      .filter((definition) => definition.archivedAt === undefined)
      .map((definition) => [definition.id, definition]),
  );

  return PersonaSettingsOptionsSchema.parse({
    roles: versions
      .filter((version) => definitionsById.has(version.roleDefinitionId))
      .map((version) => {
        const definition = definitionsById.get(version.roleDefinitionId)!;
        return {
          roleDefinitionId: definition.id,
          roleVersionId: version.id,
          name: definition.name,
          version: version.version,
          current: definition.currentVersionId === version.id,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)
        || right.version - left.version),
    avatars: [],
    voices: [],
    languages: LANGUAGE_OPTIONS,
    lifecycleStates: ['idle', 'sleeping', 'disabled'],
    autonomyLevels: PERSONA_AUTONOMY_LEVELS,
    interruptionPolicies: PERSONA_INTERRUPTION_POLICIES,
    capabilities: {
      avatarPicker: false,
      roleChange: false,
      voicePicker: false,
      voicePreview: false,
      languagePicker: true,
    },
  });
}
