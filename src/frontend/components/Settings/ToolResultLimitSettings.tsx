"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import {
  TOOL_RESULT_CUSTOM_MAX_KB,
  TOOL_RESULT_CUSTOM_MIN_KB,
  TOOL_RESULT_MAX_LINES_LIMIT,
  autoToolResultBytes,
  kilobytesToToolResultBytes,
  toolResultBytesToKilobytes,
  type ToolResultLimitPatch,
  type ToolResultLimitSettings as ToolResultLimitValues,
} from '@/shared/toolResultLimit';

const ENDPOINT = '/api/tool-result-limit';
/** The example model in the 'auto' explanation. */
const EXAMPLE_CONTEXT_WINDOW = 200_000;

type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'load-failed' | 'save-failed';

function parseLines(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const lines = Number(trimmed);
  return Number.isSafeInteger(lines) && lines <= TOOL_RESULT_MAX_LINES_LIMIT ? lines : null;
}

/**
 * Tool result size limit (issue #1226): on/off, automatic or custom size, and
 * a line limit. The switch and the mode save at once, like the other switches
 * on this page; the two numbers save with "Save limits".
 */
export default function ToolResultLimitSettings() {
  const { t, formatNumber } = useI18n();
  const [saved, setSaved] = useState<ToolResultLimitValues | null>(null);
  const [sizeKb, setSizeKb] = useState('');
  const [lines, setLines] = useState('');
  const [status, setStatus] = useState<Status>('loading');

  const showValues = useCallback((values: ToolResultLimitValues) => {
    setSaved(values);
    setSizeKb(String(toolResultBytesToKilobytes(values.toolResultMaxBytes)));
    setLines(String(values.toolResultMaxLines));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(ENDPOINT);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { settings?: ToolResultLimitValues };
        if (!data.settings) throw new Error('No settings in the answer');
        if (!cancelled) {
          showValues(data.settings);
          setStatus('idle');
        }
      } catch {
        if (!cancelled) setStatus('load-failed');
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [showValues]);

  const save = async (patch: ToolResultLimitPatch) => {
    setStatus('saving');
    try {
      const response = await fetch(ENDPOINT, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { settings?: ToolResultLimitValues };
      if (!data.settings) throw new Error('No settings in the answer');
      showValues(data.settings);
      setStatus('saved');
    } catch {
      setStatus('save-failed');
    }
  };

  if (status === 'loading') {
    return <CircularProgress size={18} aria-label={t('settings.experimental.toolResultLimitLoading')} />;
  }
  if (!saved) {
    return <Alert severity="error">{t('settings.experimental.toolResultLimitLoadFailed')}</Alert>;
  }

  const busy = status === 'saving';
  const enabled = saved.toolResultTruncationEnabled;
  const custom = saved.toolResultLimitMode === 'custom';
  const sizeBytes = kilobytesToToolResultBytes(sizeKb);
  const lineCount = parseLines(lines);
  const sizeError = custom && sizeBytes === null;
  const linesError = lineCount === null;
  const changed = (custom && sizeBytes !== null && sizeBytes !== saved.toolResultMaxBytes)
    || (lineCount !== null && lineCount !== saved.toolResultMaxLines);
  const kb = (value: number) => formatNumber(value);

  return (
    <FormControl fullWidth component="fieldset">
      <FormControlLabel
        control={(
          <Switch
            checked={enabled}
            disabled={busy}
            name="toolResultTruncationEnabled"
            onChange={(event) => { void save({ toolResultTruncationEnabled: event.target.checked }); }}
          />
        )}
        label={t('settings.experimental.toolResultLimit')}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {t('settings.experimental.toolResultLimitDescription')}
      </Typography>

      <Box sx={{ mt: 2, pl: 2, borderLeft: 2, borderColor: 'divider' }}>
        <Stack spacing={2}>
          <FormControl disabled={!enabled || busy}>
            <FormLabel id="tool-result-limit-mode-label">{t('settings.experimental.toolResultLimitMode')}</FormLabel>
            <RadioGroup
              aria-labelledby="tool-result-limit-mode-label"
              name="toolResultLimitMode"
              value={saved.toolResultLimitMode}
              onChange={(event) => {
                const mode = event.target.value === 'custom' ? 'custom' : 'auto';
                void save({ toolResultLimitMode: mode });
              }}
            >
              <FormControlLabel value="auto" control={<Radio />} label={t('settings.experimental.toolResultLimitAuto')} />
              <Typography variant="body2" color="text.secondary" sx={{ ml: 4, mt: -0.5, mb: 1 }}>
                {t('settings.experimental.toolResultLimitAutoDescription', {
                  autoKb: kb(toolResultBytesToKilobytes(autoToolResultBytes(EXAMPLE_CONTEXT_WINDOW))),
                  fallbackKb: kb(toolResultBytesToKilobytes(autoToolResultBytes())),
                })}
              </Typography>
              <FormControlLabel value="custom" control={<Radio />} label={t('settings.experimental.toolResultLimitCustom')} />
            </RadioGroup>
          </FormControl>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label={t('settings.experimental.toolResultLimitSizeLabel')}
              name="toolResultMaxKb"
              type="number"
              value={sizeKb}
              disabled={!enabled || !custom || busy}
              error={enabled && sizeError}
              helperText={t(sizeError
                ? 'settings.experimental.toolResultLimitSizeInvalid'
                : 'settings.experimental.toolResultLimitSizeHelp', {
                min: kb(TOOL_RESULT_CUSTOM_MIN_KB),
                max: kb(TOOL_RESULT_CUSTOM_MAX_KB),
              })}
              slotProps={{ htmlInput: { min: TOOL_RESULT_CUSTOM_MIN_KB, max: TOOL_RESULT_CUSTOM_MAX_KB, step: 1 } }}
              onChange={(event) => setSizeKb(event.target.value)}
              fullWidth
            />
            <TextField
              label={t('settings.experimental.toolResultLimitLinesLabel')}
              name="toolResultMaxLines"
              type="number"
              value={lines}
              disabled={!enabled || busy}
              error={enabled && linesError}
              helperText={t(linesError
                ? 'settings.experimental.toolResultLimitLinesInvalid'
                : 'settings.experimental.toolResultLimitLinesHelp', { max: kb(TOOL_RESULT_MAX_LINES_LIMIT) })}
              slotProps={{ htmlInput: { min: 0, max: TOOL_RESULT_MAX_LINES_LIMIT, step: 1 } }}
              onChange={(event) => setLines(event.target.value)}
              fullWidth
            />
          </Stack>
          <Box>
            <Button
              variant="outlined"
              disabled={!enabled || busy || !changed || sizeError || linesError}
              onClick={() => {
                void save({
                  ...(custom && sizeBytes !== null ? { toolResultMaxBytes: sizeBytes } : {}),
                  ...(lineCount !== null ? { toolResultMaxLines: lineCount } : {}),
                });
              }}
            >
              {t('settings.experimental.toolResultLimitSave')}
            </Button>
          </Box>
        </Stack>
      </Box>
      {status === 'saved' && <Alert severity="success" sx={{ mt: 2 }}>{t('settings.experimental.toolResultLimitSaved')}</Alert>}
      {status === 'save-failed' && <Alert severity="error" sx={{ mt: 2 }}>{t('settings.experimental.toolResultLimitSaveFailed')}</Alert>}
    </FormControl>
  );
}
