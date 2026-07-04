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
import { ScheduleTriggerConfig } from '@/shared/types/plannedExecution';
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';

type PresetMode = 'minutes' | 'hours' | 'daily' | 'weekdays' | 'custom';

/**
 * Non-technician schedule editor: presets that generate a cron pattern, with
 * the raw pattern available under an advanced accordion. Shows a live "next
 * runs" preview validated by the backend (croner).
 */

const two = (n: number) => String(n).padStart(2, '0');

/** Recognize the patterns the presets generate, to re-open saved configs. */
function presetFromCron(cron: string): { mode: PresetMode; n: number; time: string } {
  let m = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
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
  config: ScheduleTriggerConfig;
  onChange: (config: ScheduleTriggerConfig) => void;
}

const SchedulePanel = ({ config, onChange }: SchedulePanelProps) => {
  const initial = useMemo(() => presetFromCron(config.cron), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [mode, setMode] = useState<PresetMode>(initial.mode);
  const [n, setN] = useState<number>(initial.n);
  const [time, setTime] = useState<string>(initial.time);
  const [customCron, setCustomCron] = useState<string>(config.cron);
  const [preview, setPreview] = useState<{ valid: boolean; error?: string; nextRuns: string[] } | null>(null);

  const cron = cronFromPreset(mode, n, time, customCron);

  // Push the generated pattern up whenever any input changes.
  useEffect(() => {
    if (cron !== config.cron) {
      onChange({ ...config, cron });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cron]);

  // Debounced live preview of the next fire times.
  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      plannedExecutionsService
        .previewSchedule(cron, config.timezone)
        .then(result => {
          if (!cancelled) setPreview(result);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [cron, config.timezone]);

  return (
    <Box>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center', mt: 1 }}>
        <FormControl sx={{ minWidth: 180 }}>
          <InputLabel id="schedule-preset-label">Runs</InputLabel>
          <Select
            labelId="schedule-preset-label"
            label="Runs"
            value={mode}
            onChange={(e) => setMode(e.target.value as PresetMode)}
          >
            <MenuItem value="minutes">Every N minutes</MenuItem>
            <MenuItem value="hours">Every N hours</MenuItem>
            <MenuItem value="daily">Daily at a time</MenuItem>
            <MenuItem value="weekdays">Weekdays at a time</MenuItem>
            <MenuItem value="custom">Custom (cron)</MenuItem>
          </Select>
        </FormControl>

        {(mode === 'minutes' || mode === 'hours') && (
          <TextField
            label={mode === 'minutes' ? 'Minutes' : 'Hours'}
            type="number"
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            inputProps={{ min: 1, max: mode === 'minutes' ? 59 : 23 }}
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
          Next runs: {preview.nextRuns.map(iso => new Date(iso).toLocaleString()).join('  ·  ')}
        </Typography>
      )}

      <FormControlLabel
        sx={{ mt: 1, display: 'flex' }}
        control={
          <Checkbox
            checked={config.catchUp === true}
            onChange={(e) => onChange({ ...config, catchUp: e.target.checked })}
          />
        }
        label="If FLUJO was closed at a scheduled time, run once on startup"
      />

      <Accordion disableGutters elevation={0} sx={{ mt: 1, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
          <Typography variant="body2" color="text.secondary">Advanced</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              label="Timezone (optional)"
              value={config.timezone || ''}
              onChange={(e) => onChange({ ...config, timezone: e.target.value || undefined })}
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
