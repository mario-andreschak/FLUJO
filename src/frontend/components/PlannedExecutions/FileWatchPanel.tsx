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
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';

interface FileWatchPanelProps {
  config: FileWatchTriggerConfig;
  onChange: (config: FileWatchTriggerConfig) => void;
}

const EVENT_OPTIONS: Array<{ value: FileWatchEvent; labelKey: TranslationKey }> = [
  { value: 'add', labelKey: 'automations.file.add' },
  { value: 'change', labelKey: 'automations.file.change' },
  { value: 'unlink', labelKey: 'automations.file.unlink' },
];

/** File-watch trigger editor: folder, optional pattern, event kinds. */
const FileWatchPanel = ({ config, onChange }: FileWatchPanelProps) => {
  const { t } = useI18n();
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
        label={t('automations.file.path')}
        value={config.path}
        onChange={(e) => onChange({ ...config, path: e.target.value })}
        placeholder={t('automations.file.pathPlaceholder')}
        margin="normal"
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <Tooltip title={t('automations.file.browse')}>
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
        title={t('automations.file.choose')}
        selectFiles
        initialPath={config.path || undefined}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => onChange({ ...config, path })}
      />
      <TextField
        fullWidth
        label={t('automations.file.glob')}
        value={config.glob || ''}
        onChange={(e) => onChange({ ...config, glob: e.target.value || undefined })}
        placeholder={t('automations.file.globPlaceholder')}
        helperText={t('automations.file.globHelp')}
        margin="normal"
      />

      <Typography variant="subtitle2" sx={{ mt: 1 }}>
        {t('automations.file.runWhen')}
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
            label={t(option.labelKey)}
          />
        ))}
      </FormGroup>

      <Alert severity="info" sx={{ mt: 1 }}>
        {t('automations.file.batchInfo')}
      </Alert>

      <Accordion disableGutters elevation={0} sx={{ mt: 1, '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 0 }}>
          <Typography variant="body2" color="text.secondary">{t('automations.advanced')}</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ px: 0 }}>
          <TextField
            label={t('automations.file.quietWindow')}
            type="number"
            value={config.debounceMs ?? 2000}
            onChange={(e) =>
              onChange({ ...config, debounceMs: Math.max(0, Number(e.target.value) || 0) })
            }
            helperText={t('automations.file.quietWindowHelp')}
            inputProps={{ min: 0, step: 500 }}
            sx={{ width: 220 }}
          />
        </AccordionDetails>
      </Accordion>
    </Box>
  );
};

export default FileWatchPanel;
