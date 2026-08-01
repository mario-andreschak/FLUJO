'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function PrivacySettings() {
  const { settings, updateSettings } = useStorage();
  const { t, tp } = useI18n();
  const [dailyActivity, setDailyActivity] = useState<{
    date: string;
    count: number;
  } | null>(null);
  const [countUnavailable, setCountUnavailable] = useState(false);
  const telemetry = {
    enabled: settings.telemetry?.enabled !== false,
    notifyDaily: settings.telemetry?.notifyDaily !== false,
  };

  const updateTelemetry = (patch: Partial<typeof telemetry>) =>
    updateSettings({
      ...settings,
      telemetry: { ...telemetry, ...patch },
    });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/telemetry/daily-active', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`count request returned ${response.status}`);
        return response.json() as Promise<{ date: string; count: number }>;
      })
      .then(setDailyActivity)
      .catch(error => {
        if ((error as Error).name !== 'AbortError') setCountUnavailable(true);
      });
    return () => controller.abort();
  }, []);

  return (
    <Box sx={{ p: 2 }}>
      <Alert severity="info" sx={{ mb: 2 }}>
        {dailyActivity
          ? tp('settings.privacy.count', dailyActivity.count)
          : countUnavailable
            ? t('settings.privacy.countUnavailable')
            : t('settings.privacy.countLoading')}
      </Alert>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={telemetry.enabled}
              onChange={event =>
                updateTelemetry({ enabled: event.target.checked })
              }
              name="anonymousDailyActivity"
            />
          }
          label={t('settings.privacy.shareLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.privacy.shareDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={telemetry.enabled && telemetry.notifyDaily}
              disabled={!telemetry.enabled}
              onChange={event =>
                updateTelemetry({ notifyDaily: event.target.checked })
              }
              name="dailyTelemetryNotice"
            />
          }
          label={t('settings.privacy.notifyLabel')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.privacy.notifyDescription')}
        </Typography>
      </FormControl>

      <Alert severity="info">
        {t('settings.privacy.defaultInfo')}
      </Alert>
    </Box>
  );
}
