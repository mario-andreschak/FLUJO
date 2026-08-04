"use client";

import React from 'react';
import { AutoAwesomeRounded } from '@mui/icons-material';
import { Button, IconButton, Tooltip, useMediaQuery } from '@mui/material';
import { useTheme } from '@mui/material/styles';
import { useAskFlujo } from '@/frontend/contexts/AskFlujoContext';

export default function AskFlujoButton() {
  const { open, toggleDock } = useAskFlujo();
  const theme = useTheme();
  const compact = useMediaQuery(theme.breakpoints.down('sm'));

  if (compact) {
    return (
      <Tooltip title="Ask FLUJO">
        <IconButton
          color={open ? 'primary' : 'inherit'}
          onClick={toggleDock}
          aria-label="Ask FLUJO"
          aria-expanded={open}
          sx={{ border: 1, borderColor: open ? 'primary.main' : 'divider' }}
        >
          <AutoAwesomeRounded fontSize="small" />
        </IconButton>
      </Tooltip>
    );
  }

  return (
    <Button
      size="small"
      variant={open ? 'contained' : 'outlined'}
      startIcon={<AutoAwesomeRounded fontSize="small" />}
      onClick={toggleDock}
      aria-expanded={open}
      sx={{ height: 36, whiteSpace: 'nowrap', borderRadius: 2.5 }}
    >
      Ask FLUJO
    </Button>
  );
}

