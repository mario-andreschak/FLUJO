"use client";

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Divider,
} from '@mui/material';
import DialogHeaderActions from './DialogHeaderActions';
import CardPickerGrid, { CardPickerGridProps } from './CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface CardPickerDialogProps extends CardPickerGridProps {
  open: boolean;
  onClose: () => void;
  /** Omit to render the picker without a visible heading. */
  title?: React.ReactNode;
  /** Accessible name used when the visible title is intentionally omitted. */
  ariaLabel?: string;
  /** Optional helper text shown above the grid. */
  description?: React.ReactNode;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Let compact hosts use the full phone viewport instead of a cramped modal. */
  fullScreen?: boolean;
}

/**
 * A modal wrapper around {@link CardPickerGrid}, used where a picker shouldn't
 * live inline (e.g. the Subflow "choose flow" and Process node "connect MCP
 * server" pickers). Reuses the same grid so it stays visually identical to the
 * inline pickers.
 */
const CardPickerDialog: React.FC<CardPickerDialogProps> = ({
  open,
  onClose,
  title,
  ariaLabel,
  description,
  maxWidth = 'md',
  fullScreen = false,
  ...gridProps
}) => {
  const { t } = useI18n();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={maxWidth}
      fullWidth
      fullScreen={fullScreen}
      PaperProps={ariaLabel ? { 'aria-label': ariaLabel } : undefined}
    >
      {title !== undefined && title !== null && (
        <>
          <DialogHeaderActions title={title} onClose={onClose} />
          <Divider />
        </>
      )}
      <DialogContent sx={{ p: 3 }}>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {description}
          </Typography>
        )}
        <CardPickerGrid {...gridProps} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default CardPickerDialog;
