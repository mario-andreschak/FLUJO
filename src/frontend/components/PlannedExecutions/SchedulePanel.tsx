"use client";

import React, { useEffect, useId, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { plannedExecutionsService, type SchedulePreviewResult } from '@/frontend/services/plannedExecutions';
import { useI18n } from '@/frontend/contexts/I18nContext';

type PresetMode = 'seconds' | 'minutes' | 'hours' | 'daily' | 'weekdays' | 'custom';

/**
 * Non-technician cron editor: presets that generate a cron pattern, with the
 * raw pattern available under an advanced accordion and a live "next runs"
 * preview validated by the backend (croner). Generic over {cron, timezone} so
 * both schedule triggers and URL-watch triggers share it; the catch-up
 * checkbox renders only when the owner wires it (schedule triggers).
 */

const two = (n: number) => String(n).padStart(2, '0');

/** Recognize the patterns the presets generate, to re-open saved configs. */
function presetFromCron(cron: string): { mode: PresetMode; n: number; time: string } {
  let m = /^\*\/(\d+) \* \* \* \* \*$/.exec(cron);
  if (m) return { mode: 'seconds', n: Number(m[1]), time: '09:00' };
  m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (m) return { mode: 'minutes', n: Number(m[1]), time: '09:00' };
  m = /^0 \*\/(\d+) \* \* \*$/.exec(cron);
  if (m) return { mode: 'hours', n: Number(m[1]), time: '09:00' };
  m = /^(\d+) (\d+) \* \* \*$/.exec(cron);
  if (m) return { mode: 'daily', n: 1, time: `${two(Number(m[2]))}:${two(Number(m[1]))}` };
  m = /^(\d+) (\d+) \* \* 1-5$/.exec(cron);
  if (m) return { mode: 'weekdays', n: 1, time: `${two(Number(m[2]))}:${two(Number(m[1]))}` };
  return { mode: 'custom', n: 15, time: '09:00' };
}

function cronFromPreset(mode: PresetMode, n: number, time: string, custom: string): string {
  const [hh, mm] = time.split(':').map(Number);
  switch (mode) {
    case 'seconds':
      return `*/${Math.max(1, Math.min(59, Math.floor(n) || 1))} * * * * *`;
    case 'minutes':
      return `*/${Math.max(1, Math.min(59, Math.floor(n) || 1))} * * * *`;
    case 'hours':
      return `0 */${Math.max(1, Math.min(23, Math.floor(n) || 1))} * * *`;
    case 'daily':
      return `${mm || 0} ${hh || 0} * * *`;
    case 'weekdays':
      return `${mm || 0} ${hh || 0} * * 1-5`;
    default:
      return custom;
  }
}

interface SchedulePanelProps {
  cron: string;
  timezone?: string;
  onChange: (next: { cron: string; timezone?: string }) => void;
  /** Label of the "runs" dropdown — "Runs" for schedules, "Check" for watchers. */
  verb?: string;
  /** Wire these to render the catch-up checkbox (schedule triggers only). */
  catchUp?: boolean;
  onCatchUpChange?: (value: boolean) => void;
}

const SchedulePanel = ({
  cron: cronProp,
  timezone,
  onChange,
  verb,
  catchUp,
  onCatchUpChange,
}: SchedulePanelProps) => {
  const { t, formatDate } = useI18n();
  const presetLabelId = useId();
  const resolvedVerb = verb ?? t('automations.schedule.runsVerb');
  const initial = useMemo(() => presetFromCron(cronProp), []);
  const [mode, setMode] = useState<PresetMode>(initial.mode);
  const [n, setN] = useState<number>(initial.n);
  const [time, setTime] = useState<string>(initial.time);
  const [customCron, setCustomCron] = useState<string>(cronProp);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewState, setPreviewState] = useState<{
    cron: string;
    timezone?: string;
    attempt: number;
    result: SchedulePreviewResult;
  } | null>(null);

  const cron = cronFromPreset(mode, n, time, customCron);
  // A preview only describes the inputs that produced it, including during debounce.
  const preview = previewState?.cron === cron
    && previewState.timezone === timezone
    && previewState.attempt === previewAttempt
    ? previewState.result
    : null;

  // Push the generated pattern up whenever any input changes.
  useEffect(() => {
    if (cron !== cronProp) {
      onChange({ cron, timezone });
    }
  }, [cron]);

  // Debounced live preview of the next fire times.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      plannedExecutionsService
        .previewSchedule(cron, timezone)
        .then(result => {
          if (!cancelled) setPreviewState({ cron, timezone, attempt: previewAttempt, result });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [cron, timezone, previewAttempt]);

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mt: 1 }}>
        <FormControl sx={{ minWidth: 0, width: { xs: '100%', sm: 180 } }}>
          <InputLabel id={presetLabelId}>{resolvedVerb}</InputLabel>
          <Select
            labelId={presetLabelId}
            label={resolvedVerb}
            value={mode}
            onChange={(e) => setMode(e.target.value as PresetMode)}
          >
            <MenuItem value="seconds">{t('automations.schedule.everySeconds')}</MenuItem>
            <MenuItem value="minutes">{t('automations.schedule.everyMinutes')}</MenuItem>
            <MenuItem value="hours">{t('automations.schedule.everyHours')}</MenuItem>
            <MenuItem value="daily">{t('automations.schedule.daily')}</MenuItem>
            <MenuItem value="weekdays">{t('automations.schedule.weekdays')}</MenuItem>
            <MenuItem value="custom">{t('automations.schedule.custom')}</MenuItem>
          </Select>
        </FormControl>

        {(mode === 'seconds' || mode === 'minutes' || mode === 'hours') && (
          <TextField
            label={mode === 'seconds' ? t('automations.schedule.seconds') : mode === 'minutes' ? t('automations.schedule.minutes') : t('automations.schedule.hours')}
            type="number"
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            inputProps={{ min: 1, max: mode === 'hours' ? 23 : 59 }}
            sx={{ width: { xs: '100%', sm: 120 } }}
          />
        )}

        {(mode === 'daily' || mode === 'weekdays') && (
          <TextField
            label={t('automations.schedule.time')}
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            sx={{ width: { xs: '100%', sm: 150 } }}
            InputLabelProps={{ shrink: true }}
          />
        )}

        {mode === 'custom' && (
          <TextField
            label={t('automations.schedule.cron')}
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            sx={{ minWidth: 0, width: { xs: '100%', sm: 220 } }}
            placeholder="*/15 * * * *"
          />
        )}
      </Box>

      <Box role="status" aria-live="polite" sx={{ mt: 2, overflowWrap: 'anywhere' }}>
        {!preview && (
          <Typography variant="body2" color="text.secondary">{t('automations.schedule.checking')}</Typography>
        )}
        {preview?.valid && (
          <Typography variant="body2" color="text.secondary">
            {preview.nextRuns.length > 0
              ? t('automations.schedule.next', { times: preview.nextRuns.map(iso => formatDate(iso, { dateStyle: 'short', timeStyle: 'short' })).join('  ·  ') })
              : t('automations.schedule.noNextRuns')}
          </Typography>
        )}
      </Box>
      {preview?.unavailable && (
        <Alert
          severity="warning"
          sx={{ mt: 1, flexDirection: { xs: 'column', sm: 'row' }, '& .MuiAlert-message': { minWidth: 0 }, '& .MuiAlert-action': { ml: 0, pl: { xs: 0, sm: 2 }, alignSelf: { xs: 'stretch', sm: 'center' } } }}
          action={
            <Button color="inherit" onClick={() => setPreviewAttempt((attempt) => attempt + 1)} sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}>
              {t('common.tryAgain')}
            </Button>
          }
        >
          {t('automations.schedule.previewUnavailable')}
        </Alert>
      )}
      {preview && !preview.valid && !preview.unavailable && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {t('automations.schedule.invalid')}
          {preview.error && <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{preview.error}</Typography>}
        </Alert>
      )}

      {onCatchUpChange && (
        <FormControlLabel
          sx={{ mt: 1, display: 'flex' }}
          control={
            <Checkbox
              checked={catchUp === true}
              onChange={(e) => onCatchUpChange(e.target.checked)}
            />
          }
          label={t('automations.schedule.catchUp')}
        />
      )}

      <Accordion disableGutters elevation={0} sx={{ mt: 1, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0, minHeight: 48 }}>
          <Typography variant="body2" color="text.secondary">{t('automations.advanced')}</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label={t('automations.schedule.timezone')}
              value={timezone || ''}
              onChange={(e) => onChange({ cron, timezone: e.target.value || undefined })}
              placeholder={t('automations.schedule.timezonePlaceholder')}
              helperText={t('automations.schedule.timezoneHelp')}
              sx={{ minWidth: 0, width: { xs: '100%', sm: 260 } }}
            />
            <TextField
              label={t('automations.schedule.generatedCron')}
              value={cron}
              InputProps={{ readOnly: mode !== 'custom' }}
              onChange={(e) => {
                setMode('custom');
                setCustomCron(e.target.value);
              }}
              helperText={t('automations.schedule.editCustom')}
              sx={{ minWidth: 0, width: { xs: '100%', sm: 220 } }}
            />
          </Box>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default SchedulePanel;
