"use client";

import React from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  IconButton,
  Typography,
  Divider,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CardPickerGrid, { CardPickerGridProps } from './CardPickerGrid';

export interface CardPickerDialogProps extends CardPickerGridProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** Optional helper text shown above the grid. */
  description?: React.ReactNode;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
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
  description,
  maxWidth = 'md',
  ...gridProps
}) => {
  return (
    <Dialog open={open} onClose={onClose} maxWidth={maxWidth} fullWidth>
      <DialogTitle component="div">
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">{title}</Typography>
          <IconButton edge="end" color="inherit" onClick={onClose} aria-label="close">
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ p: 3 }}>
        {description && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {description}
          </Typography>
        )}
        <CardPickerGrid {...gridProps} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
};

export default CardPickerDialog;
