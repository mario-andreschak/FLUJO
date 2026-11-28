"use client";

import React from 'react';
import { Box, MenuItem, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { UseChoice } from '@/shared/types/deletePlan';

/**
 * One place that still uses something the person deletes (#1389), with a
 * "Switch to" choice: another item of the same kind, or letting it go. Shared
 * by the agent, Connected App and package delete dialogs so they read alike.
 */

export const REMOVE_CHOICE = 'remove';

export interface UseChoiceOption {
  value: string;
  label: string;
}

/** A choice value for an item; the prefix keeps an item named "remove" apart from letting go. */
export const itemChoiceValue = (prefix: string, id: string) => `${prefix}:${id}`;

export function choiceFromValue(value: string, prefix: string): UseChoice | null {
  if (value === REMOVE_CHOICE) return { remove: true };
  const start = `${prefix}:`;
  return value.startsWith(start) ? { replaceWith: value.slice(start.length) } : null;
}

export interface UseChoiceRowProps {
  owner: string;
  description: string;
  note?: string;
  value: string;
  options: UseChoiceOption[];
  /** Omitted when the place cannot let go and must switch. */
  removeLabel?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

export default function UseChoiceRow({ owner, description, note, value, options, removeLabel, disabled, onChange }: UseChoiceRowProps) {
  const { t } = useI18n();
  return (
    <Box
      role="group"
      aria-label={`${owner}: ${description}`}
      sx={{ display: 'grid', gap: 1, gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'minmax(0, 1fr) minmax(0, 1fr)' }, alignItems: 'center' }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700 }} noWrap title={owner}>{owner}</Typography>
        <Typography variant="body2" color="text.secondary">{description}</Typography>
        {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
      </Box>
      <TextField
        select
        fullWidth
        size="small"
        label={t('flows.delete.switchTo')}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
        ))}
        {removeLabel && (
          <MenuItem value={REMOVE_CHOICE} sx={{ borderTop: 1, borderColor: 'divider' }}>{removeLabel}</MenuItem>
        )}
      </TextField>
    </Box>
  );
}
