'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Snackbar,
  Typography,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/TelemetryNotice');

interface CheckResult {
  enabled: boolean;
  attempted: boolean;
  sent: boolean;
  shouldNotify: boolean;
}

export default function TelemetryNotice() {
  const { settings, settingsHydrated, updateSettings } = useStorage();
  const { t } = useI18n();
  const checked = useRef(false);
  const [result, setResult] = useState<CheckResult | null>(null);

  useEffect(() => {
    if (!settingsHydrated || checked.current) return;
    checked.current = true;

    fetch('/api/telemetry/daily-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
      .then(async response => {
        if (!response.ok) return null;
        return (await response.json()) as CheckResult;
      })
      .then(value => {
        if (value?.shouldNotify) setResult(value);
      })
      .catch(error => {
        // Telemetry is best-effort and never merits an application error.
        log.debug('Daily telemetry check failed', error);
      });
  }, [settingsHydrated]);

  const updateTelemetry = async (
    patch: Partial<{ enabled: boolean; notifyDaily: boolean }>,
  ) => {
    const current = {
      enabled: settings.telemetry?.enabled !== false,
      notifyDaily: settings.telemetry?.notifyDaily !== false,
    };
    await updateSettings({
      ...settings,
      telemetry: { ...current, ...patch },
    });
    setResult(null);
  };

  return (
    <Snackbar
      open={Boolean(result)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ maxWidth: 720 }}
    >
      <Alert severity="info" variant="filled" sx={{ width: '100%' }}>
        <Typography variant="body2">
          {t(result?.sent ? 'telemetry.notice.sent' : 'telemetry.notice.notSent')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
          <Button
            color="inherit"
            size="small"
            variant="outlined"
            onClick={() => updateTelemetry({ enabled: false })}
          >
            {t('telemetry.notice.turnOff')}
          </Button>
          <Button
            color="inherit"
            size="small"
            onClick={() => updateTelemetry({ notifyDaily: false })}
          >
            {t('telemetry.notice.dismissForever')}
          </Button>
        </Box>
      </Alert>
    </Snackbar>
  );
}
