"use client";

import React from 'react';
import {
  Box,
  ButtonBase,
  Chip,
  FormControl,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
  useTheme as useMuiTheme,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import DarkModeRoundedIcon from '@mui/icons-material/DarkModeRounded';
import LightModeRoundedIcon from '@mui/icons-material/LightModeRounded';
import { ThemeMode, useTheme } from '@/frontend/contexts/ThemeContext';
import { VisualThemeStyle } from '@/frontend/utils/muiTheme';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n';

const log = createLogger('frontend/components/Settings/ThemeSettings');

interface ThemeChoice {
  mode: ThemeMode;
  style: VisualThemeStyle;
  labelKey: TranslationKey;
  descriptionKey: TranslationKey;
  base: string;
  surface: string;
  text: string;
  accent: string;
}

const choices: ThemeChoice[] = [
  {
    mode: 'light',
    style: 'modern',
    labelKey: 'settings.theme.modernLight',
    descriptionKey: 'settings.theme.modernLightDescription',
    base: '#F5F7FF',
    surface: '#FFFFFF',
    text: '#171A2B',
    accent: '#6355E8',
  },
  {
    mode: 'dark',
    style: 'modern',
    labelKey: 'settings.theme.modernDark',
    descriptionKey: 'settings.theme.modernDarkDescription',
    base: '#070912',
    surface: '#12182C',
    text: '#F4F6FF',
    accent: '#8B7CFF',
  },
  {
    mode: 'light',
    style: 'legacy',
    labelKey: 'settings.theme.legacyLight',
    descriptionKey: 'settings.theme.legacyLightDescription',
    base: '#FFFFFF',
    surface: '#F5F6FA',
    text: '#2C3E50',
    accent: '#007BFF',
  },
  {
    mode: 'dark',
    style: 'legacy',
    labelKey: 'settings.theme.legacyDark',
    descriptionKey: 'settings.theme.legacyDarkDescription',
    base: '#0F1319',
    surface: '#1A212B',
    text: '#EEF1F5',
    accent: '#4F93F5',
  },
];

export default function ThemeSettings() {
  const {
    isDarkMode,
    livingWorldEnabled,
    visualStyle,
    setLivingWorldEnabled,
    setThemePreset,
  } = useTheme();
  const theme = useMuiTheme();
  const { t } = useI18n();

  log.debug(`Rendering ThemeSettings with preset: ${visualStyle}/${isDarkMode ? 'dark' : 'light'}`);

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        {t('settings.theme.help')}
      </Typography>

      <Box
        role="radiogroup"
        aria-label={t('settings.theme.aria')}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 2,
          mb: 2.5,
        }}
      >
        {choices.map((option) => {
          const selected = visualStyle === option.style && isDarkMode === (option.mode === 'dark');
          const Icon = option.mode === 'dark' ? DarkModeRoundedIcon : LightModeRoundedIcon;

          return (
            <ButtonBase
              key={`${option.style}-${option.mode}`}
              role="radio"
              aria-checked={selected}
              aria-label={t(option.labelKey)}
              onClick={() => {
                if (!selected) setThemePreset({ mode: option.mode, style: option.style });
              }}
              sx={{
                display: 'block',
                overflow: 'hidden',
                border: '1px solid',
                borderColor: selected ? 'primary.main' : 'divider',
                borderRadius: visualStyle === 'legacy' ? 2 : 3.5,
                textAlign: 'left',
                boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.13)}` : 'none',
                transition: 'transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease',
                '&:hover': {
                  borderColor: 'primary.main',
                  transform: option.style === 'modern' ? 'translateY(-2px)' : 'none',
                },
                '&:focus-visible': {
                  outline: `3px solid ${alpha(theme.palette.primary.main, 0.3)}`,
                  outlineOffset: 2,
                },
              }}
            >
              <Box
                sx={{
                  height: 126,
                  p: 2,
                  color: option.text,
                  bgcolor: option.base,
                  backgroundImage: option.style === 'modern'
                    ? `radial-gradient(circle at 20% 0%, ${alpha(option.accent, 0.22)}, transparent 48%)`
                    : 'none',
                }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Box sx={{ width: 50, height: 8, borderRadius: 999, bgcolor: option.text, opacity: 0.18 }} />
                  <Box sx={{ width: 8, height: 8, ml: 'auto !important', borderRadius: '50%', bgcolor: option.accent }} />
                </Stack>
                <Box
                  sx={{
                    mt: 2,
                    height: 68,
                    p: 1.2,
                    border: `1px solid ${alpha(option.text, 0.1)}`,
                    borderRadius: option.style === 'modern' ? 2 : 1,
                    bgcolor: option.surface,
                    boxShadow: option.style === 'modern'
                      ? option.mode === 'dark'
                        ? '0 12px 30px rgba(0,0,0,.28)'
                        : '0 12px 30px rgba(55,50,105,.1)'
                      : option.mode === 'dark'
                        ? '0 4px 6px rgba(0,0,0,.4)'
                        : '0 4px 6px rgba(0,0,0,.1)',
                  }}
                >
                  <Box sx={{ width: '62%', height: 7, mb: 1, borderRadius: 999, bgcolor: option.text, opacity: 0.72 }} />
                  <Box sx={{ width: '84%', height: 5, mb: 0.7, borderRadius: 999, bgcolor: option.text, opacity: 0.18 }} />
                  <Box sx={{ width: '46%', height: 5, borderRadius: 999, bgcolor: option.accent, opacity: 0.65 }} />
                </Box>
              </Box>

              <Stack direction="row" spacing={1.2} alignItems="flex-start" sx={{ p: 1.7 }}>
                <Icon sx={{ mt: 0.15, color: selected ? 'primary.main' : 'text.secondary' }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={0.8} alignItems="center" useFlexGap flexWrap="wrap">
                    <Typography variant="subtitle2" sx={{ fontWeight: visualStyle === 'modern' ? 720 : 600 }}>
                      {t(option.labelKey)}
                    </Typography>
                    {option.style === 'modern' && (
                      <Chip label={t('settings.theme.modern')} size="small" variant="outlined" sx={{ height: 21, fontSize: '0.65rem' }} />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{t(option.descriptionKey)}</Typography>
                </Box>
                {selected && <CheckRoundedIcon color="primary" fontSize="small" aria-hidden="true" />}
              </Stack>
            </ButtonBase>
          );
        })}
      </Box>

      <FormControl
        fullWidth
        sx={{
          p: 2,
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: visualStyle === 'legacy' ? 2 : 3,
          bgcolor: alpha(theme.palette.background.paper, 0.58),
        }}
      >
        <FormControlLabel
          control={(
            <Switch
              checked={livingWorldEnabled}
              onChange={(event) => setLivingWorldEnabled(event.target.checked)}
              name="livingWorldEnabled"
            />
          )}
          label={t('settings.theme.animatedLandscape')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('settings.theme.animatedLandscapeDescription')}
        </Typography>
      </FormControl>
    </Box>
  );
}
