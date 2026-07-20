"use client";

import React from 'react';
import {
  Box,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
  Alert
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { ExperimentalSettings } from '@/shared/types/storage/storage';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/Settings/ExperimentalFeaturesSettings');

export default function ExperimentalFeaturesSettings() {
  const { settings, updateSettings } = useStorage();

  // Missing/undefined is treated as disabled — the "experimental" default.
  const experimental: ExperimentalSettings = settings?.experimental ?? { enabled: false };

  const handleEnableChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Experimental features toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        enabled: event.target.checked,
      },
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.enabled}
              onChange={handleEnableChange}
              name="experimentalEnabled"
            />
          }
          label="Enable Experimental Features"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Experimental features may be incomplete or unstable and can change or be
          removed at any time. When enabled, they become visible in the app — for
          example the <strong>Waves</strong> entry in the top navigation.
        </Typography>
      </FormControl>

      <Alert severity="info">
        <Typography variant="body2">
          Turning this off again hides experimental features from the navigation. It
          does not delete any data.
        </Typography>
      </Alert>
    </Box>
  );
}
