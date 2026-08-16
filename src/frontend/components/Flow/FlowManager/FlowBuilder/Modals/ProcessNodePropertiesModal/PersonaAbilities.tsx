import React from 'react';
import {
  Box,
  FormControlLabel,
  FormGroup,
  Paper,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';

import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  PERSONA_NATIVE_ABILITY_IDS,
  type PersonaNativeAbilityId,
} from '@/shared/types/enduringAgent';

export { PERSONA_NATIVE_ABILITY_IDS };
export type { PersonaNativeAbilityId };

/** UI aliases retained for readability at the authoring boundary. */
export const PERSONA_ABILITY_IDS = PERSONA_NATIVE_ABILITY_IDS;
export type PersonaAbilityId = PersonaNativeAbilityId;

const PERSONA_ABILITY_SET = new Set<string>(PERSONA_ABILITY_IDS);

export function normalizePersonaAbilities(value: unknown): PersonaAbilityId[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set(
    value.filter((item): item is PersonaAbilityId => (
      typeof item === 'string' && PERSONA_ABILITY_SET.has(item)
    )),
  );
  return PERSONA_ABILITY_IDS.filter((id) => selected.has(id));
}

const MEMORY_ABILITIES = [
  { id: 'recall', label: 'flows.process.personaAbilities.recall' },
  { id: 'remember', label: 'flows.process.personaAbilities.remember' },
  { id: 'correct', label: 'flows.process.personaAbilities.correct' },
  { id: 'pin', label: 'flows.process.personaAbilities.pin' },
  { id: 'unpin', label: 'flows.process.personaAbilities.unpin' },
  { id: 'forget', label: 'flows.process.personaAbilities.forget' },
] as const;

const WORK_ABILITIES = [
  { id: 'work_item_create', label: 'flows.process.personaAbilities.createWork' },
  { id: 'work_item_update', label: 'flows.process.personaAbilities.updateWork' },
  { id: 'work_item_complete', label: 'flows.process.personaAbilities.completeWork' },
  { id: 'work_item_promote_todo', label: 'flows.process.personaAbilities.keepChecklistItem' },
  { id: 'suggest_improvement', label: 'flows.process.personaAbilities.suggestImprovement' },
] as const;

const HELPFUL_ABILITIES = PERSONA_ABILITY_IDS.filter((id) => id !== 'forget');

const PRESETS = [
  { id: 'off', label: 'flows.process.personaAbilities.presetOff', abilities: [] },
  { id: 'context', label: 'flows.process.personaAbilities.presetContext', abilities: ['recall'] },
  { id: 'helpful', label: 'flows.process.personaAbilities.presetHelpful', abilities: HELPFUL_ABILITIES },
  { id: 'full', label: 'flows.process.personaAbilities.presetFull', abilities: PERSONA_ABILITY_IDS },
] as const;

function equalAbilities(left: readonly PersonaAbilityId[], right: readonly PersonaAbilityId[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

export interface PersonaAbilitiesProps {
  value: readonly PersonaAbilityId[];
  onChange: (value: PersonaAbilityId[]) => void;
}

/**
 * Friendly authoring surface for the native abilities available during a
 * trusted Persona Activity. Runtime tool identifiers intentionally never
 * appear in the rendered copy.
 */
export default function PersonaAbilities({ value, onChange }: PersonaAbilitiesProps) {
  const { t } = useI18n();
  const selected = normalizePersonaAbilities(value);
  const selectedSet = new Set(selected);
  const activePreset = PRESETS.find((preset) => equalAbilities(selected, preset.abilities))?.id ?? null;

  const setAbility = (id: PersonaAbilityId, enabled: boolean) => {
    const next = new Set(selected);
    if (enabled) next.add(id); else next.delete(id);
    onChange(PERSONA_ABILITY_IDS.filter((ability) => next.has(ability)));
  };

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}>
      <Typography variant="subtitle1" component="h3" fontWeight={600}>
        {t('flows.process.personaAbilities.title')}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {t('flows.process.personaAbilities.description')}
      </Typography>

      <ToggleButtonGroup
        exclusive
        size="small"
        value={activePreset}
        onChange={(_event, presetId: string | null) => {
          const preset = PRESETS.find((item) => item.id === presetId);
          if (preset) onChange([...preset.abilities]);
        }}
        aria-label={t('flows.process.personaAbilities.presetsAria')}
        sx={{ mt: 1.5, display: 'flex', flexWrap: 'wrap', gap: 0.5, '& .MuiToggleButtonGroup-grouped': { borderRadius: 1, border: 1, borderColor: 'divider' } }}
      >
        {PRESETS.map((preset) => (
          <ToggleButton key={preset.id} value={preset.id} sx={{ flex: '1 1 130px', textTransform: 'none' }}>
            {t(preset.label)}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {activePreset === null && (
        <Typography variant="caption" color="primary" sx={{ display: 'block', mt: 0.75 }}>
          {t('flows.process.personaAbilities.custom')}
        </Typography>
      )}

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          mt: 2,
        }}
      >
        <Box>
          <Typography variant="subtitle2">{t('flows.process.personaAbilities.memoryTitle')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('flows.process.personaAbilities.memoryDescription')}
          </Typography>
          <FormGroup sx={{ mt: 0.75 }}>
            {MEMORY_ABILITIES.map((ability) => (
              <FormControlLabel
                key={ability.id}
                control={(
                  <Switch
                    size="small"
                    checked={selectedSet.has(ability.id)}
                    onChange={(event) => setAbility(ability.id, event.target.checked)}
                  />
                )}
                label={t(ability.label)}
              />
            ))}
          </FormGroup>
          {selectedSet.has('forget') && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5 }}>
              {t('flows.process.personaAbilities.forgetWarning')}
            </Typography>
          )}
        </Box>

        <Box>
          <Typography variant="subtitle2">{t('flows.process.personaAbilities.workTitle')}</Typography>
          <Typography variant="caption" color="text.secondary">
            {t('flows.process.personaAbilities.workDescription')}
          </Typography>
          <FormGroup sx={{ mt: 0.75 }}>
            {WORK_ABILITIES.map((ability) => (
              <FormControlLabel
                key={ability.id}
                control={(
                  <Switch
                    size="small"
                    checked={selectedSet.has(ability.id)}
                    onChange={(event) => setAbility(ability.id, event.target.checked)}
                  />
                )}
                label={t(ability.label)}
              />
            ))}
          </FormGroup>
        </Box>
      </Box>
    </Paper>
  );
}
