import React from 'react';
import { Box, MenuItem, TextField } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import type { CodeModeSetting, ToolLoadingMode } from '@/shared/types/flow/toolLoading';

const TOOL_LOADING_OPTIONS: ReadonlyArray<{ value: ToolLoadingMode; label: TranslationKey }> = [
  { value: 'auto', label: 'flows.process.toolLoading.auto' },
  { value: 'on-demand', label: 'flows.process.toolLoading.onDemand' },
  { value: 'up-front', label: 'flows.process.toolLoading.upFront' },
];

const CODE_MODE_OPTIONS: ReadonlyArray<{ value: CodeModeSetting; label: TranslationKey }> = [
  { value: 'auto', label: 'flows.process.codeMode.auto' },
  { value: 'on', label: 'flows.process.codeMode.on' },
  { value: 'off', label: 'flows.process.codeMode.off' },
];

interface ToolLoadingControlsProps {
  toolLoading: ToolLoadingMode;
  setToolLoading: (value: ToolLoadingMode) => void;
  codeMode: CodeModeSetting;
  setCodeMode: (value: CodeModeSetting) => void;
}

/** How a step hands MCP tools to its model: deferred descriptions and code mode (#1448). */
export default function ToolLoadingControls({ toolLoading, setToolLoading, codeMode, setCodeMode }: ToolLoadingControlsProps) {
  const { t } = useI18n();
  return (
    <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mt: 2 }}>
      <TextField
        select
        size="small"
        fullWidth
        label={t('flows.process.toolLoading.label')}
        helperText={t('flows.process.toolLoading.help')}
        value={toolLoading}
        onChange={(event) => setToolLoading(event.target.value as ToolLoadingMode)}
        slotProps={{ htmlInput: { 'data-testid': 'process-tool-loading' } }}
      >
        {TOOL_LOADING_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
        ))}
      </TextField>
      <TextField
        select
        size="small"
        fullWidth
        label={t('flows.process.codeMode.label')}
        helperText={t('flows.process.codeMode.help')}
        value={codeMode}
        onChange={(event) => setCodeMode(event.target.value as CodeModeSetting)}
        slotProps={{ htmlInput: { 'data-testid': 'process-code-mode' } }}
      >
        {CODE_MODE_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>{t(option.label)}</MenuItem>
        ))}
      </TextField>
    </Box>
  );
}
