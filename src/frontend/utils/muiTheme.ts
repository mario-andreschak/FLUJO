"use client";

import { createTheme, Theme } from '@mui/material/styles';
import { themeColors } from './theme';
import { PaletteMode } from '@mui/material';

/**
 * Create a MUI theme based on the current mode (light/dark)
 * @param mode The current theme mode ('light' or 'dark')
 * @returns A configured MUI theme
 */
export function createAppTheme(mode: PaletteMode): Theme {
  const colors = mode === 'dark' ? themeColors.dark : themeColors.light;
  
  return createTheme({
    palette: {
      mode,
      primary: {
        main: '#007bff',
      },
      secondary: {
        main: '#6c757d',
      },
      error: {
        main: mode === 'dark' ? '#f87171' : '#dc2626',
        light: mode === 'dark' ? '#5a3333' : '#fecaca',
        dark: mode === 'dark' ? '#3a2222' : '#b91c1c',
      },
      warning: {
        main: '#f59e0b',
      },
      info: {
        main: '#3b82f6',
      },
      success: {
        main: mode === 'dark' ? '#4ade80' : '#16a34a',
      },
      background: {
        default: colors.background,
        paper: colors.paperBackground,
      },
      text: {
        primary: colors.foreground,
        secondary: colors.textSecondary,
      },
    },
    typography: {
      fontFamily: 'var(--font-geist-sans), Arial, sans-serif',
      h1: {
        fontWeight: 700,
      },
      h2: {
        fontWeight: 700,
      },
      h3: {
        fontWeight: 600,
      },
      h4: {
        fontWeight: 600,
      },
      h5: {
        fontWeight: 600,
      },
      h6: {
        fontWeight: 600,
      },
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            borderRadius: '0.375rem',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: '0.5rem',
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: '0.375rem',
            },
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: '0.5rem',
            boxShadow: mode === 'dark' 
              ? '0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 2px 4px -1px rgba(0, 0, 0, 0.1)'
              : '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
          },
        },
      },
    },
  });
}

/**
 * Hook to get the current MUI theme based on the app's theme context
 * This should be used in a ThemeProvider component
 */
export function getThemeOptions(mode: PaletteMode): Theme {
  return createAppTheme(mode);
}
