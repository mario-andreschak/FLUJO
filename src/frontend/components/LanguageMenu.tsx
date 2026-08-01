"use client";

import { CheckRounded, LanguageRounded } from '@mui/icons-material';
import {
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
} from '@mui/material';
import { useState } from 'react';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/frontend/i18n';

export default function LanguageMenu() {
  const { locale, setLocale, t } = useI18n();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const chooseLocale = (nextLocale: SupportedLocale) => {
    setLocale(nextLocale);
    setAnchorEl(null);
  };

  return (
    <>
      <Tooltip title={t('language.menu')}>
        <IconButton
          color="inherit"
          aria-label={t('language.menu')}
          aria-haspopup="menu"
          aria-expanded={Boolean(anchorEl)}
          onClick={(event) => setAnchorEl(event.currentTarget)}
          sx={{ border: 1, borderColor: 'divider' }}
        >
          <LanguageRounded fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        MenuListProps={{ 'aria-label': t('language.menu') }}
        slotProps={{ paper: { sx: { mt: 1, minWidth: 210, borderRadius: 2.5 } } }}
      >
        {SUPPORTED_LOCALES.map((option) => (
          <MenuItem
            key={option.code}
            selected={option.code === locale}
            lang={option.languageTag}
            onClick={() => chooseLocale(option.code)}
          >
            <ListItemIcon>
              {option.code === locale ? <CheckRounded color="primary" fontSize="small" /> : null}
            </ListItemIcon>
            <ListItemText
              primary={option.nativeName}
              secondary={option.code === locale ? t('language.current') : undefined}
            />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
