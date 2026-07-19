"use client";

import { createTheme, Theme } from '@mui/material/styles';
import { themeColors } from './theme';
import { PaletteMode } from '@mui/material';

/**
 * Create a MUI theme based on the current mode (light/dark)
 * @param mode The current theme mode ('light' or 'dark')
 * @returns A configured MUI theme
 *
 * Dark mode (issue #150) maps the layered surface ramp onto MUI:
 *   background.default = base, background.paper = surface (elevation-1).
 * Menus/popovers/hover use `surfaceRaised` (elevation-2) so overlays visibly
 * float above panels. Blue is used only as an interactive accent.
 */
export function createAppTheme(mode: PaletteMode): Theme {
  const colors = mode === 'dark' ? themeColors.dark : themeColors.light;
  const isDark = mode === 'dark';

  return createTheme({
    palette: {
      mode,
      // Dark mode uses a softer, AA-compliant blue accent (not the harsh
      // black+blue of #007bff) confined to interactive controls (issue #150).
      primary: {
        main: isDark ? '#4f93f5' : '#007bff',
        light: isDark ? '#6aa6f7' : '#3395ff',
        dark: isDark ? '#3a7ad4' : '#0056b3',
      },
      secondary: {
        main: isDark ? '#a3adba' : '#6c757d',
      },
      error: {
        main: isDark ? '#ff6b6b' : '#dc2626',
        light: isDark ? '#5a2a2e' : '#fecaca',
        dark: isDark ? '#2a1618' : '#b91c1c',
      },
      warning: {
        main: isDark ? '#e0a23c' : '#f59e0b',
      },
      info: {
        main: isDark ? '#56b6d6' : '#3b82f6',
      },
      success: {
        main: isDark ? '#3fae72' : '#16a34a',
      },
      divider: colors.border,
      background: {
        default: colors.background,
        paper: colors.surface,
      },
      text: {
        primary: colors.foreground,
        secondary: colors.textSecondary,
        disabled: colors.textDisabled,
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
            backgroundImage: 'none',
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
            border: isDark ? `1px solid ${colors.border}` : undefined,
            boxShadow: isDark
              ? '0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -1px rgba(0, 0, 0, 0.3)'
              : '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
          },
        },
      },
      // Overlays float above panels using the raised (elevation-2) surface.
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: colors.surfaceRaised,
            backgroundImage: 'none',
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            backgroundColor: colors.surfaceRaised,
            backgroundImage: 'none',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: isDark
            ? { backgroundColor: colors.surfaceRaised, border: `1px solid ${colors.border}`, color: colors.foreground }
            : undefined,
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
