"use client";

import React from 'react';
import { Alert, Box, TextField, Typography } from '@mui/material';
import { UrlWatchTriggerConfig } from '@/shared/types/plannedExecution';
import SchedulePanel from './SchedulePanel';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface UrlWatchPanelProps {
  config: UrlWatchTriggerConfig;
  onChange: (config: UrlWatchTriggerConfig) => void;
}

/**
 * URL-watch trigger editor: fetch a URL on a schedule, run the flow when the
 * content changes (hash comparison on the backend).
 */
const UrlWatchPanel = ({ config, onChange }: UrlWatchPanelProps) => {
  const { t } = useI18n();
  return <Box sx={{ mt: 1 }}>
    <TextField
      fullWidth
      label={t('automations.url.label')}
      value={config.url}
      onChange={(e) => onChange({ ...config, url: e.target.value })}
      placeholder={t('automations.url.placeholder')}
      margin="normal"
      type="url"
    />

    <Typography variant="subtitle2" sx={{ mt: 1 }}>
      {t('automations.howOften')}
    </Typography>
    <SchedulePanel
      verb={t('automations.checkVerb')}
      cron={config.cron}
      timezone={config.timezone}
      onChange={({ cron, timezone }) => onChange({ ...config, cron, timezone })}
    />

    <Alert severity="info" sx={{ mt: 1 }}>
      {t('automations.url.info')}
    </Alert>
  </Box>;
};

export default UrlWatchPanel;
