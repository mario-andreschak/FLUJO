"use client";

import React from 'react';
import { Box, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

export interface OptionCardProps {
  selected: boolean;
  icon: React.ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}

/**
 * A big selectable card for a mutually exclusive choice (radio-style). Shared by
 * the subflow input/output selectors and the process node's conversation-input
 * selector so the two node modals present the same choice affordance.
 */
const OptionCard = ({ selected, icon, title, description, onClick }: OptionCardProps) => (
  <Box
    role="radio"
    aria-checked={selected}
    tabIndex={0}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    }}
    sx={{
      flex: 1,
      minWidth: 180,
      position: 'relative',
      p: 2,
      borderRadius: 2,
      border: 2,
      borderColor: selected ? 'primary.main' : 'divider',
      bgcolor: selected ? 'action.selected' : 'background.paper',
      cursor: 'pointer',
      transition: 'border-color 120ms, background-color 120ms',
      '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' },
      outline: 'none',
      '&:focus-visible': { boxShadow: (theme: any) => `0 0 0 3px ${theme.palette.primary.light}` },
    }}
  >
    {selected && (
      <CheckCircleIcon
        color="primary"
        fontSize="small"
        sx={{ position: 'absolute', top: 8, right: 8 }}
      />
    )}
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, color: selected ? 'primary.main' : 'text.secondary' }}>
      {icon}
      <Typography variant="subtitle1" sx={{ fontWeight: 600, color: 'text.primary' }}>
        {title}
      </Typography>
    </Box>
    <Typography variant="body2" color="text.secondary">
      {description}
    </Typography>
  </Box>
);

export default OptionCard;
