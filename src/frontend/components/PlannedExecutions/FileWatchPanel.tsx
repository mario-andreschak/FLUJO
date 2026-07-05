"use client";

import React, { useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Checkbox,
  FormControlLabel,
  FormGroup,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderIcon from '@mui/icons-material/Folder';
import { FileWatchEvent, FileWatchTriggerConfig } from '@/shared/types/plannedExecution';
import FolderPickerDialog from '@/frontend/components/shared/FolderPickerDialog';

interface FileWatchPanelProps {
  config: FileWatchTriggerConfig;
  onChange: (config: FileWatchTriggerConfig) => void;
}

const EVENT_OPTIONS: Array<{ value: FileWatchEvent; label: string }> = [
  { value: 'add', label: 'A file appears' },
  { value: 'change', label: 'A file changes' },
  { value: 'unlink', label: 'A file is deleted' },
];

/** File-watch trigger editor: folder, optional pattern, event kinds. */
const FileWatchPanel = ({ config, onChange }: FileWatchPanelProps) => {
  const [pickerOpen, setPickerOpen] = useState(false);

  const toggleEvent = (event: FileWatchEvent, checked: boolean) => {
    const events = checked
      ? [...config.events, event]
      : config.events.filter(e => e !== event);
    onChange({ ...config, events });
  };

  return (
    <Box sx={{ mt: 1 }}>
      <TextField
        fullWidth
        label="Folder (or file) to watch"
        value={config.path}
        onChange={(e) => onChange({ ...config, path: e.target.value })}
        placeholder="e.g. C:\Users\me\Documents\inbox"
        margin="normal"
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title="Browse folders (on the FLUJO machine)">
                <IconButton edge="end" onClick={() => setPickerOpen(true)}>
                  <FolderIcon />
                </IconButton>
              </Tooltip>
            </InputAdornment>
          ),
        }}
      />
      <FolderPickerDialog
        open={pickerOpen}
        title="Choose what to watch"
        selectFiles
        initialPath={config.path || undefined}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => onChange({ ...config, path })}
      />
      <TextField
        fullWidth
        label="Only files matching (optional)"
        value={config.glob || ''}
        onChange={(e) => onChange({ ...config, glob: e.target.value || undefined })}
        placeholder="e.g. *.pdf or reports/**/*.csv"
        helperText="Simple patterns: * matches within a folder, ** across folders, ? one character."
        margin="normal"
      />

      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        Run when…
      </Typography>
      <FormGroup row>
        {EVENT_OPTIONS.map(option => (
          <FormControlLabel
            key={option.value}
            control={
              <Checkbox
                checked={config.events.includes(option.value)}
                onChange={(e) => toggleEvent(option.value, e.target.checked)}
              />
            }
            label={option.label}
          />
        ))}
      </FormGroup>

      <Alert severity="info" sx={{ mt: 1 }}>
        Bursts are batched: many files changing at once produce one run with
        all changes listed. If this flow writes into the watched folder, it
        will trigger itself in a loop — point its output somewhere else.
      </Alert>

      <Accordion disableGutters elevation={0} sx={{ mt: 1, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
          <Typography variant="body2" color="text.secondary">Advanced</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <TextField
            label="Quiet window (ms)"
            type="number"
            value={config.debounceMs ?? 2000}
            onChange={(e) =>
              onChange({ ...config, debounceMs: Math.max(0, Number(e.target.value) || 0) })
            }
            helperText="How long to wait after the last change before running."
            inputProps={{ min: 0, step: 500 }}
            sx={{ width: 220 }}
          />
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default FileWatchPanel;
