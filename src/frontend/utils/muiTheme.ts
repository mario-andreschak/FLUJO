"use client";

import { PaletteMode } from '@mui/material';
import { alpha, createTheme, Theme } from '@mui/material/styles';
import { themeColors } from './theme';
import { legacyThemeColors } from './paletteTokens';

export type VisualThemeStyle = 'legacy' | 'modern';

/**
 * The pre-refresh MUI theme, reconstructed from the last legacy implementation.
 * This intentionally stays modest: compact radii, blue interaction color and
 * the original elevation treatment.
 */
export function createLegacyAppTheme(mode: PaletteMode): Theme {
  const colors = mode === 'dark' ? legacyThemeColors.dark : legacyThemeColors.light;
  const isDark = mode === 'dark';

  return createTheme({
    palette: {
      mode,
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
      h1: { fontWeight: 700 },
      h2: { fontWeight: 700 },
      h3: { fontWeight: 600 },
      h4: { fontWeight: 600 },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            // Same link contract as the modern theme (see createAppTheme): the
            // shade that contrasts with this mode's surfaces, overridable per
            // container for accent-filled surfaces like the user chat bubble.
            '--flujo-link-color': isDark ? '#6aa6f7' : '#0056b3',
          },
          'a:not([class])': {
            color: `var(--flujo-link-color, ${isDark ? '#6aa6f7' : '#0056b3'})`,
            textDecorationColor: 'currentColor',
            textUnderlineOffset: '2px',
          },
        },
      },
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
 * FLUJO's visual foundation. The theme stays neutral at large scale and uses
 * violet/cyan light for deliberate interaction moments. Centralising these
 * decisions also upgrades older screens that still rely on stock MUI.
 */
export function createAppTheme(mode: PaletteMode): Theme {
  const colors = mode === 'dark' ? themeColors.dark : themeColors.light;
  const isDark = mode === 'dark';
  const primary = isDark ? '#8B7CFF' : '#6355E8';
  const primaryLight = isDark ? '#ACA2FF' : '#6C5CE2';
  const primaryDark = isDark ? '#6656E8' : '#493BCB';
  const secondary = isDark ? '#31D2ED' : '#129DB8';
  const glass = isDark ? 'rgba(13, 17, 31, 0.82)' : 'rgba(255, 255, 255, 0.84)';
  const softShadow = isDark
    ? '0 18px 55px rgba(0, 0, 0, 0.30)'
    : '0 18px 55px rgba(60, 54, 116, 0.11)';
  const liftedShadow = isDark
    ? '0 26px 80px rgba(0, 0, 0, 0.48)'
    : '0 26px 80px rgba(54, 48, 112, 0.18)';

  return createTheme({
    palette: {
      mode,
      primary: {
        main: primary,
        light: primaryLight,
        dark: primaryDark,
        contrastText: '#FFFFFF',
      },
      secondary: {
        main: secondary,
        light: isDark ? '#79E3F4' : '#3CBBD0',
        dark: isDark ? '#10A8C3' : '#0B758A',
      },
      error: {
        main: isDark ? '#FF8298' : '#C62847',
        light: colors.error.background,
        dark: colors.error.border,
      },
      warning: {
        main: isDark ? '#F6BC66' : '#C67A13',
      },
      info: {
        main: secondary,
      },
      success: {
        main: isDark ? '#57D59B' : '#15885A',
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
    shape: {
      borderRadius: 14,
    },
    typography: {
      fontFamily: 'var(--font-geist-sans), Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
      fontSize: 14,
      h1: {
        fontSize: 'clamp(2.6rem, 6vw, 5.5rem)',
        fontWeight: 780,
        lineHeight: 0.98,
        letterSpacing: '-0.055em',
      },
      h2: {
        fontSize: 'clamp(2.1rem, 4vw, 3.9rem)',
        fontWeight: 760,
        lineHeight: 1.04,
        letterSpacing: '-0.045em',
      },
      h3: {
        fontSize: 'clamp(1.75rem, 3vw, 2.65rem)',
        fontWeight: 730,
        lineHeight: 1.1,
        letterSpacing: '-0.035em',
      },
      h4: {
        fontSize: 'clamp(1.45rem, 2vw, 2rem)',
        fontWeight: 710,
        lineHeight: 1.16,
        letterSpacing: '-0.028em',
      },
      h5: {
        fontSize: '1.35rem',
        fontWeight: 700,
        lineHeight: 1.24,
        letterSpacing: '-0.022em',
      },
      h6: {
        fontSize: '1.05rem',
        fontWeight: 680,
        lineHeight: 1.35,
        letterSpacing: '-0.012em',
      },
      subtitle1: {
        fontWeight: 640,
      },
      button: {
        fontWeight: 680,
        letterSpacing: '-0.01em',
      },
      body1: {
        lineHeight: 1.62,
      },
      body2: {
        lineHeight: 1.55,
      },
      caption: {
        fontSize: '0.74rem',
        fontWeight: 560,
        letterSpacing: '0.012em',
      },
    },
    transitions: {
      duration: {
        shortest: 110,
        shorter: 150,
        short: 190,
        standard: 240,
        complex: 320,
        enteringScreen: 260,
        leavingScreen: 190,
      },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: colors.background,
            // Default markdown/plain-anchor link color. `primary.main` sits too
            // close to the light-mode surfaces and to the accent-filled chat
            // bubbles to be legible, so the shade that actually contrasts with
            // the current mode's surfaces is published as a variable. Any
            // container may re-point it (see markdownLinkVars).
            '--flujo-link-color': isDark ? primaryLight : primaryDark,
          },
          // Anchors we don't render through MUI (react-markdown output, raw HTML)
          // otherwise fall back to the UA's default blue/purple, which clashes
          // with both palettes. MUI components always carry a class, so the
          // :not([class]) guard keeps Buttons/Links untouched.
          'a:not([class])': {
            color: `var(--flujo-link-color, ${isDark ? primaryLight : primaryDark})`,
            textDecorationColor: 'currentColor',
            textUnderlineOffset: '2px',
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            color: colors.foreground,
            backgroundColor: glass,
            backgroundImage: 'none',
            borderBottom: `1px solid ${alpha(colors.border, 0.82)}`,
            boxShadow: 'none',
            backdropFilter: 'blur(24px) saturate(150%)',
          },
        },
      },
      MuiToolbar: {
        styleOverrides: {
          root: {
            minHeight: 'var(--app-bar-height)',
          },
        },
      },
      MuiButton: {
        defaultProps: {
          disableElevation: true,
        },
        styleOverrides: {
          root: {
            minHeight: 40,
            paddingInline: 16,
            borderRadius: 12,
            textTransform: 'none',
            transition: 'transform 180ms ease, box-shadow 180ms ease, background-color 180ms ease, border-color 180ms ease',
            '&:active': {
              transform: 'translateY(1px) scale(0.99)',
            },
            '&:focus-visible': {
              outline: `3px solid ${alpha(primary, 0.28)}`,
              outlineOffset: 2,
            },
          },
          sizeLarge: {
            minHeight: 48,
            paddingInline: 22,
            borderRadius: 14,
            fontSize: '0.95rem',
          },
          containedPrimary: {
            color: '#fff',
            backgroundColor: primary,
            backgroundImage: `linear-gradient(135deg, ${primaryLight} 0%, ${primary} 46%, ${primaryDark} 100%)`,
            boxShadow: `0 10px 26px ${alpha(primary, isDark ? 0.28 : 0.22)}`,
            '&:hover': {
              backgroundImage: `linear-gradient(135deg, ${primaryLight} 0%, ${primary} 38%, ${primaryDark} 100%)`,
              boxShadow: `0 15px 34px ${alpha(primary, isDark ? 0.38 : 0.3)}`,
              transform: 'translateY(-1px)',
            },
            '&.Mui-disabled': {
              backgroundImage: 'none',
            },
          },
          outlinedPrimary: {
            borderColor: alpha(primary, 0.42),
            backgroundColor: alpha(primary, isDark ? 0.08 : 0.045),
            '&:hover': {
              borderColor: primary,
              backgroundColor: alpha(primary, isDark ? 0.15 : 0.09),
              transform: 'translateY(-1px)',
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            borderRadius: 18,
            backgroundColor: colors.surface,
            backgroundImage: 'none',
          },
          outlined: {
            borderColor: colors.border,
          },
          elevation1: {
            border: `1px solid ${colors.border}`,
            boxShadow: softShadow,
          },
          elevation2: {
            border: `1px solid ${colors.border}`,
            boxShadow: liftedShadow,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            overflow: 'hidden',
            border: `1px solid ${colors.border}`,
            borderRadius: 18,
            backgroundColor: colors.surface,
            backgroundImage: isDark
              ? 'linear-gradient(150deg, rgba(255,255,255,0.028), transparent 42%)'
              : 'linear-gradient(150deg, rgba(102,87,245,0.025), transparent 42%)',
            boxShadow: softShadow,
          },
        },
      },
      MuiCardActionArea: {
        styleOverrides: {
          root: {
            borderRadius: 'inherit',
            '&:focus-visible': {
              outline: `3px solid ${alpha(primary, 0.3)}`,
              outlineOffset: -3,
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            minHeight: 42,
            borderRadius: 12,
            backgroundColor: alpha(colors.surfaceRaised, isDark ? 0.6 : 0.74),
            transition: 'box-shadow 180ms ease, background-color 180ms ease',
            '& .MuiOutlinedInput-notchedOutline': {
              borderColor: colors.border,
            },
            '&:hover .MuiOutlinedInput-notchedOutline': {
              borderColor: alpha(primary, 0.52),
            },
            '&.Mui-focused': {
              backgroundColor: colors.surfaceRaised,
              boxShadow: `0 0 0 4px ${alpha(primary, 0.12)}`,
            },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: 1,
              borderColor: primary,
            },
          },
        },
      },
      MuiInputBase: {
        styleOverrides: {
          input: {
            '&::placeholder': {
              color: colors.textSecondary,
              opacity: 0.78,
            },
          },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: {
            color: colors.textSecondary,
            fontWeight: 560,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            border: `1px solid ${colors.border}`,
            borderRadius: 24,
            backgroundColor: glass,
            boxShadow: liftedShadow,
            backdropFilter: 'blur(30px) saturate(145%)',
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            padding: '24px 24px 10px',
            fontWeight: 720,
            letterSpacing: '-0.025em',
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            borderColor: colors.border,
            backgroundColor: glass,
            backgroundImage: 'none',
            boxShadow: liftedShadow,
            backdropFilter: 'blur(28px) saturate(150%)',
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            marginTop: 8,
            border: `1px solid ${colors.border}`,
            borderRadius: 15,
            backgroundColor: colors.surfaceRaised,
            backgroundImage: 'none',
            boxShadow: liftedShadow,
            backdropFilter: 'blur(24px) saturate(140%)',
          },
          list: {
            padding: 7,
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: 40,
            borderRadius: 9,
            '&.Mui-selected': {
              backgroundColor: alpha(primary, 0.14),
              '&:hover': {
                backgroundColor: alpha(primary, 0.2),
              },
            },
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            border: `1px solid ${colors.border}`,
            backgroundColor: colors.surfaceRaised,
            backgroundImage: 'none',
            boxShadow: liftedShadow,
            backdropFilter: 'blur(24px) saturate(140%)',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            padding: '7px 10px',
            border: `1px solid ${colors.border}`,
            borderRadius: 9,
            color: colors.foreground,
            backgroundColor: colors.surfaceRaised,
            boxShadow: softShadow,
            fontSize: '0.72rem',
            fontWeight: 600,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            height: 30,
            borderRadius: 9,
            fontWeight: 650,
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 11,
            transition: 'transform 160ms ease, background-color 160ms ease, color 160ms ease',
            '&:hover': {
              backgroundColor: alpha(primary, 0.1),
              transform: 'translateY(-1px)',
            },
            '&:focus-visible': {
              outline: `3px solid ${alpha(primary, 0.28)}`,
              outlineOffset: 2,
            },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          root: {
            minHeight: 42,
          },
          indicator: {
            height: 3,
            borderRadius: '3px 3px 0 0',
            backgroundImage: `linear-gradient(90deg, ${primary}, ${secondary})`,
          },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minWidth: 0,
            minHeight: 42,
            padding: '8px 14px',
            color: colors.textSecondary,
            fontWeight: 640,
            textTransform: 'none',
            '&.Mui-selected': {
              color: colors.foreground,
            },
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            alignItems: 'center',
            border: '1px solid currentColor',
            borderRadius: 14,
            backgroundImage: 'none',
          },
          message: {
            paddingBlock: 7,
          },
        },
      },
      MuiAccordion: {
        styleOverrides: {
          root: {
            overflow: 'hidden',
            border: `1px solid ${colors.border}`,
            borderRadius: '16px !important',
            backgroundColor: colors.surface,
            boxShadow: 'none',
            '&::before': {
              display: 'none',
            },
            '& + &': {
              marginTop: 10,
            },
            '&.Mui-expanded': {
              marginBlock: 10,
              boxShadow: softShadow,
            },
          },
        },
      },
      MuiAccordionSummary: {
        styleOverrides: {
          root: {
            minHeight: 58,
            paddingInline: 18,
            '&.Mui-expanded': {
              minHeight: 58,
            },
          },
          content: {
            marginBlock: 12,
            '&.Mui-expanded': {
              marginBlock: 12,
            },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: 42,
            borderRadius: 11,
            '&.Mui-selected': {
              backgroundColor: alpha(primary, 0.14),
              '&:hover': {
                backgroundColor: alpha(primary, 0.19),
              },
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderColor: colors.border,
          },
          head: {
            color: colors.textSecondary,
            backgroundColor: alpha(colors.surfaceRaised, 0.64),
            fontSize: '0.72rem',
            fontWeight: 720,
            letterSpacing: '0.055em',
            textTransform: 'uppercase',
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: {
            borderColor: colors.border,
          },
        },
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            padding: 8,
          },
          switchBase: {
            '&.Mui-checked + .MuiSwitch-track': {
              backgroundColor: primary,
              opacity: 0.75,
            },
          },
          track: {
            borderRadius: 999,
          },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: {
            height: 7,
            borderRadius: 999,
            backgroundColor: alpha(primary, 0.12),
          },
          bar: {
            borderRadius: 999,
            backgroundImage: `linear-gradient(90deg, ${primary}, ${secondary})`,
          },
        },
      },
      MuiSkeleton: {
        styleOverrides: {
          root: {
            backgroundColor: alpha(colors.textSecondary, 0.12),
          },
        },
      },
    },
  });
}

export function getThemeOptions(mode: PaletteMode, visualStyle: VisualThemeStyle = 'modern'): Theme {
  return visualStyle === 'legacy' ? createLegacyAppTheme(mode) : createAppTheme(mode);
}
