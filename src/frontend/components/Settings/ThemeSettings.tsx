"use client";

import React from 'react';
import { Box, Typography, Switch, FormControlLabel, Paper, Divider } from '@mui/material';
import { useTheme } from '@/frontend/contexts/ThemeContext';
import { getCssVar } from '@/frontend/utils';
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

      <Divider sx={{ my: 3 }} />
      
      <Typography variant="subtitle1" gutterBottom>
        Theme CSS Variables
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The following CSS variables are available for custom styling:
      </Typography>
      
      <Paper sx={{ p: 2, mb: 3 }}>
        <Typography variant="body2" component="pre" sx={{ fontFamily: 'var(--font-geist-mono)' }}>
          {`/* Access in CSS */
:root {
  /* Light theme variables (default) */
  --background: #FFFFFF;
  --foreground: #2C3E50;
  --paper-background: #F5F6FA;
  --text-secondary: #7F8C8D;
}

:root.dark-theme {
  /* Dark theme variables */
  --background: #1a1a1a;
  --foreground: #f0f0f0;
  --paper-background: #2a2a2a;
  --text-secondary: #aaaaaa;
}

/* Access in inline styles */
color: var(--foreground);
background: var(--background);`}
        </Typography>
      </Paper>
      
      <Typography variant="subtitle1" gutterBottom>
        Usage in Components
      </Typography>
      
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Import the theme utilities to use theme-aware styling in your components:
      </Typography>
      
      <Paper sx={{ p: 2 }}>
        <Typography variant="body2" component="pre" sx={{ fontFamily: 'var(--font-geist-mono)' }}>
          {`// Using the useTheme hook
import { useTheme } from '@/frontend/contexts/ThemeContext';

function MyComponent() {
  const { isDarkMode } = useTheme();
  
  return (
    <div>
      {isDarkMode ? 'Dark Mode' : 'Light Mode'}
    </div>
  );
}

// Using CSS variables in inline styles
import { getCssVar } from '@/frontend/utils';

function StyledComponent() {
  return (
    <div style={{ 
      color: getCssVar('foreground'),
      background: getCssVar('background')
    }}>
      Themed content
    </div>
  );
}`}
        </Typography>
      </Paper>
    </Box>
  );
}
