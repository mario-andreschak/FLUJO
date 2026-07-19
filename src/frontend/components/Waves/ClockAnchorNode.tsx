'use client';

import React from 'react';
import { Box, Typography } from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';

/**
 * The fixed "now" anchor pinned to the LEFT of a wave lane (#144). Time flows
 * right→left toward it: cards on the right fire further in the future, sliding
 * left as their run approaches.
 */
export default function ClockAnchorNode() {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 0.25,
        width: 84,
      }}
    >
      <Box
        sx={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
          boxShadow: 3,
        }}
      >
        <AccessTimeIcon />
      </Box>
      <Typography variant="caption" sx={{ fontWeight: 600 }}>
        now
      </Typography>
      <Typography variant="caption" sx={{ opacity: 0.6, fontSize: 10, textAlign: 'center' }}>
        time →
      </Typography>
    </Box>
  );
}
