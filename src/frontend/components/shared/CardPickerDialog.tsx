"use client";

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Divider,
  useMediaQuery,
} from '@mui/material';
import DialogHeaderActions from './DialogHeaderActions';
import CardPickerGrid, { CardPickerGridProps } from './CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useTheme } from '@mui/material/styles';

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
  /** Optional exact trigger to restore focus to after the closing transition. */
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
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
  fullScreen,
  restoreFocusRef,
  autoFocusSearch: autoFocusSearchProp,
  autoFocusDelayMs: autoFocusDelayMsProp,
  ...gridProps
}) => {
  const { t } = useI18n();
  const theme = useTheme();
  const compactViewport = useMediaQuery(theme.breakpoints.down('sm'));
  const resolvedFullScreen = fullScreen ?? compactViewport;
  const titleId = React.useId();
  const descriptionId = React.useId();
  const openingTriggerRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    if (open && !wasOpenRef.current) {
      openingTriggerRef.current = restoreFocusRef?.current
        ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    }
    wasOpenRef.current = open;
  }, [open, restoreFocusRef]);

  const restoreFocus = () => {
    (restoreFocusRef?.current ?? openingTriggerRef.current)?.focus();
  };

  // #372: re-trigger auto-focus every time this dialog opens; the delay lets
  // MUI's Dialog focus trap settle first so the two don't fight over focus.
  const autoFocusSearch = autoFocusSearchProp ?? open;
  const autoFocusDelayMs = autoFocusDelayMsProp ?? 120;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={maxWidth}
      fullWidth
      fullScreen={resolvedFullScreen}
      aria-labelledby={!ariaLabel && title !== undefined && title !== null ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      PaperProps={ariaLabel ? { 'aria-label': ariaLabel } : undefined}
      TransitionProps={{ onExited: restoreFocus }}
    >
      {title !== undefined && title !== null && (
        <>
          <DialogHeaderActions title={<span id={titleId}>{title}</span>} onClose={onClose} />
          <Divider />
        </>
      )}
      <DialogContent sx={{ p: 3 }}>
        {description && (
          <Typography id={descriptionId} variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {description}
          </Typography>
        )}
        <CardPickerGrid
          {...gridProps}
          autoFocusSearch={autoFocusSearch}
          autoFocusDelayMs={autoFocusDelayMs}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </DialogActions>
    </Dialog>
  );
};

export default CardPickerDialog;
