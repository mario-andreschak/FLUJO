import React from 'react';
import { Box, MenuItem, TextField } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import {
  TOOL_RESULT_CUSTOM_MAX_KB,
  TOOL_RESULT_CUSTOM_MIN_KB,
  kilobytesToToolResultBytes,
  normalizeStepToolResultLimit,
  toolResultBytesToKilobytes,
  type StepToolResultLimit,
} from '@/shared/toolResultLimit';

/** What the step's dropdown shows: its own limit, or the workspace setting. */
export type ToolResultLimitChoice = 'workspace' | StepToolResultLimit['mode'];

/** The size a newly chosen custom limit starts at. */
const DEFAULT_STEP_KB = 64;

const CHOICES: ReadonlyArray<{ value: ToolResultLimitChoice; label: TranslationKey }> = [
  { value: 'workspace', label: 'flows.process.toolResultLimit.workspace' },
  { value: 'auto', label: 'flows.process.toolResultLimit.auto' },
  { value: 'custom', label: 'flows.process.toolResultLimit.custom' },
  { value: 'off', label: 'flows.process.toolResultLimit.off' },
];

/** The dropdown and size field for a step's saved `toolResultLimit`. */
export function toolResultLimitFormValues(saved: unknown): { choice: ToolResultLimitChoice; sizeKb: string } {
  const limit = normalizeStepToolResultLimit(saved);
  if (!limit) return { choice: 'workspace', sizeKb: String(DEFAULT_STEP_KB) };
  return {
    choice: limit.mode,
    sizeKb: String(limit.mode === 'custom' ? toolResultBytesToKilobytes(limit.maxBytes) : DEFAULT_STEP_KB),
  };
}

/** The value to save on the step; undefined removes it, null means the size is not valid yet. */
export function toolResultLimitToSave(choice: ToolResultLimitChoice, sizeKb: string): StepToolResultLimit | undefined | null {
  if (choice === 'workspace') return undefined;
  if (choice !== 'custom') return { mode: choice };
  const maxBytes = kilobytesToToolResultBytes(sizeKb);
  return maxBytes === null ? null : { mode: 'custom', maxBytes };
}

interface ToolResultLimitControlProps {
  choice: ToolResultLimitChoice;
  setChoice: (value: ToolResultLimitChoice) => void;
  sizeKb: string;
  setSizeKb: (value: string) => void;
}

/** This step's own tool result size limit (#1226), saved with the agent. */
export default function ToolResultLimitControl({ choice, setChoice, sizeKb, setSizeKb }: ToolResultLimitControlProps) {
  const { t, formatNumber } = useI18n();
  const sizeError = choice === 'custom' && kilobytesToToolResultBytes(sizeKb) === null;
  const range = { min: formatNumber(TOOL_RESULT_CUSTOM_MIN_KB), max: formatNumber(TOOL_RESULT_CUSTOM_MAX_KB) };
  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mt: 2 }}>
      <TextField
        select
        size="small"
        fullWidth
        label={t('flows.process.toolResultLimit.label')}
        helperText={t(choice === 'off' ? 'flows.process.toolResultLimit.offHelp' : 'flows.process.toolResultLimit.help')}
        value={choice}
        onChange={(event) => setChoice(event.target.value as ToolResultLimitChoice)}
        slotProps={{ htmlInput: { 'data-testid': 'process-tool-result-limit' } }}
      >
        {CHOICES.map((option) => (
          <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
        ))}
      </TextField>
      {choice === 'custom' && (
        <TextField
          size="small"
          fullWidth
          type="number"
          label={t('flows.process.toolResultLimit.sizeLabel')}
          value={sizeKb}
          error={sizeError}
          helperText={t(sizeError ? 'flows.process.toolResultLimit.sizeInvalid' : 'flows.process.toolResultLimit.sizeHelp', range)}
          onChange={(event) => setSizeKb(event.target.value)}
          slotProps={{ htmlInput: { min: TOOL_RESULT_CUSTOM_MIN_KB, max: TOOL_RESULT_CUSTOM_MAX_KB, step: 1 } }}
        />
      )}
    </Box>
  );
}
