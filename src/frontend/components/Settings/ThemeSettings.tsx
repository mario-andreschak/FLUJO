"use client";

import React from 'react';
import { Box, Typography, Switch, FormControlLabel } from '@mui/material';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Settings/ThemeSettings');

export default function ThemeSettings() {
  const { isDarkMode, toggleTheme } = useTheme();

  log.debug(`Rendering ThemeSettings with isDarkMode: ${isDarkMode}`);

  return (
    <Box sx={{ maxWidth: 600 }}>
      <Typography variant="h6" gutterBottom>
        Theme Settings
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Customize the application appearance
      </Typography>

      <FormControlLabel
        control={
          <Switch
            checked={isDarkMode}
            onChange={toggleTheme}
            name="darkMode"
          />
        }
        label="Dark Mode"
      />
    </Box>
  );
}
