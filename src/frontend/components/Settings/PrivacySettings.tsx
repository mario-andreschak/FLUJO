'use client';

import {
  Alert,
  Box,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
} from '@mui/material';
import { useStorage } from '@/frontend/contexts/StorageContext';

export default function PrivacySettings() {
  const { settings, updateSettings } = useStorage();
  const telemetry = {
    enabled: settings.telemetry?.enabled !== false,
    notifyDaily: settings.telemetry?.notifyDaily !== false,
  };

  const updateTelemetry = (patch: Partial<typeof telemetry>) =>
    updateSettings({
      ...settings,
      telemetry: { ...telemetry, ...patch },
    });

  return (
    <Box sx={{ p: 2 }}>
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
          label="Share anonymous daily activity"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Helps count daily active FLUJO installations. At most one pulse is
          attempted per UTC day. It contains the app version, platform, install
          method, UTC date, and a random ID that changes daily. It never includes
          flows, prompts, models, keys, filenames, or a permanent installation ID.
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
          label="Show the daily activity-sharing notification"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Turning this off hides the daily notification but does not disable
          anonymous activity sharing.
        </Typography>
      </FormControl>

      <Alert severity="info">
        Anonymous activity sharing is enabled by default and can be disabled
        here at any time. Collector failures never block FLUJO.
      </Alert>
    </Box>
  );
}
