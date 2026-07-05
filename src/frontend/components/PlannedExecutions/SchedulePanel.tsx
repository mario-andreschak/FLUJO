"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
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
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';

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
  verb = 'Runs',
  catchUp,
  onCatchUpChange,
}: SchedulePanelProps) => {
  const initial = useMemo(() => presetFromCron(cronProp), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState<PresetMode>(initial.mode);
  const [n, setN] = useState<number>(initial.n);
  const [time, setTime] = useState<string>(initial.time);
  const [customCron, setCustomCron] = useState<string>(cronProp);
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; nextRuns: string[] } | null>(null);

  const cron = cronFromPreset(mode, n, time, customCron);

  // Push the generated pattern up whenever any input changes.
  useEffect(() => {
    if (cron !== cronProp) {
      onChange({ cron, timezone });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cron]);

  // Debounced live preview of the next fire times.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      plannedExecutionsService
        .previewSchedule(cron, timezone)
        .then(result => {
          if (!cancelled) setPreview(result);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [cron, timezone]);

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mt: 1 }}>
        <FormControl sx={{ minWidth: 180 }}>
          <InputLabel id="schedule-preset-label">{verb}</InputLabel>
          <Select
            labelId="schedule-preset-label"
            label={verb}
            value={mode}
            onChange={(e) => setMode(e.target.value as PresetMode)}
          >
            <MenuItem value="seconds">Every N seconds</MenuItem>
            <MenuItem value="minutes">Every N minutes</MenuItem>
            <MenuItem value="hours">Every N hours</MenuItem>
            <MenuItem value="daily">Daily at a time</MenuItem>
            <MenuItem value="weekdays">Weekdays at a time</MenuItem>
            <MenuItem value="custom">Custom (cron)</MenuItem>
          </Select>
        </FormControl>

        {(mode === 'seconds' || mode === 'minutes' || mode === 'hours') && (
          <TextField
            label={mode === 'seconds' ? 'Seconds' : mode === 'minutes' ? 'Minutes' : 'Hours'}
            type="number"
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            inputProps={{ min: 1, max: mode === 'hours' ? 23 : 59 }}
            sx={{ width: 120 }}
          />
        )}

        {(mode === 'daily' || mode === 'weekdays') && (
          <TextField
            label="Time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            sx={{ width: 150 }}
            InputLabelProps={{ shrink: true }}
          />
        )}

        {mode === 'custom' && (
          <TextField
            label="Cron pattern"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            sx={{ minWidth: 220 }}
            placeholder="*/15 * * * *"
          />
        )}
      </Box>

      {preview && !preview.valid && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {preview.error || 'This schedule is not valid.'}
        </Alert>
      )}
      {preview && preview.valid && preview.nextRuns.length > 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          Next: {preview.nextRuns.map(iso => new Date(iso).toLocaleString()).join('  ·  ')}
        </Typography>
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
          label="If FLUJO was closed at a scheduled time, run once on startup"
        />
      )}

      <Accordion disableGutters elevation={0} sx={{ mt: 1, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
          <Typography variant="body2" color="text.secondary">Advanced</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label="Timezone (optional)"
              value={timezone || ''}
              onChange={(e) => onChange({ cron, timezone: e.target.value || undefined })}
              placeholder="e.g. Europe/Berlin"
              helperText="IANA timezone name. Empty = this computer's timezone."
              sx={{ minWidth: 260 }}
            />
            <TextField
              label="Generated cron pattern"
              value={cron}
              InputProps={{ readOnly: mode !== 'custom' }}
              onChange={(e) => {
                setMode('custom');
                setCustomCron(e.target.value);
              }}
              helperText="Editing switches to Custom mode."
              sx={{ minWidth: 220 }}
            />
          </Box>
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default SchedulePanel;
