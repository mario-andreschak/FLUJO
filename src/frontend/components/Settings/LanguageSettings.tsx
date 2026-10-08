"use client";

import { CheckRounded, TranslateRounded } from '@mui/icons-material';
import { alpha } from '@mui/material/styles';
import { Box, ButtonBase, Chip, Stack, Typography, useTheme } from '@mui/material';
import { useMemo } from 'react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { SUPPORTED_LOCALES } from '@/frontend/i18n';

export default function LanguageSettings() {
  const { locale, localeInfo, setLocale, t } = useI18n();
  const theme = useTheme();
  const languageNames = useMemo(
    () => new Intl.DisplayNames([localeInfo.languageTag], { type: 'language' }),
    [localeInfo.languageTag],
  );

  return (
    <Box sx={{ maxWidth: 860 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        {t('language.help')}
      </Typography>

      <Box
        role="radiogroup"
        aria-label={t('language.title')}
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
          gap: 1.5,
        }}
      >
        {SUPPORTED_LOCALES.map((option) => {
          const selected = option.code === locale;
          const localizedName = languageNames.of(option.languageTag) ?? option.englishName;
          return (
            <ButtonBase
              key={option.code}
              role="radio"
              aria-checked={selected}
              lang={option.languageTag}
              onClick={() => setLocale(option.code)}
              sx={{
                display: 'flex',
                justifyContent: 'flex-start',
                minHeight: 82,
                p: 2,
                border: '1px solid',
                borderColor: selected ? 'primary.main' : 'divider',
                borderRadius: 3,
                textAlign: 'left',
                bgcolor: selected ? alpha(theme.palette.primary.main, 0.08) : 'transparent',
                boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}` : 'none',
                transition: 'border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease',
                '&:hover': {
                  borderColor: 'primary.main',
                  bgcolor: alpha(theme.palette.primary.main, selected ? 0.1 : 0.04),
                },
                '&:focus-visible': {
                  outline: `3px solid ${alpha(theme.palette.primary.main, 0.28)}`,
                  outlineOffset: 2,
                },
              }}
            >
              <TranslateRounded sx={{ mr: 1.5, color: selected ? 'primary.main' : 'text.secondary' }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
                  <Typography variant="subtitle1" fontWeight={700}>{option.nativeName}</Typography>
                  {selected && (
                    <Chip
                      size="small"
                      color="primary"
                      label={t('language.current')}
                      sx={{ height: 22, fontSize: '0.68rem' }}
                    />
                  )}
                </Stack>
                {option.nativeName.toLocaleLowerCase() !== localizedName.toLocaleLowerCase() && (
                  <Typography variant="caption" color="text.secondary">{localizedName}</Typography>
                )}
              </Box>
              {selected && <CheckRounded color="primary" aria-hidden="true" />}
            </ButtonBase>
          );
        })}
      </Box>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        {t('language.current')}: {localeInfo.nativeName}
      </Typography>
    </Box>
  );
}
