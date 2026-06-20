"use client";

import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import SchoolIcon from '@mui/icons-material/School';
import { useTour } from '@/frontend/contexts/TourContext';

export default function OnboardingSettings() {
  const { startTour } = useTour();

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        The guided tour walks you through the full first-run path — adding a model, connecting an
        MCP tool server, building a flow, and running it in chat. It launches automatically the
        first time you open FLUJO; replay it any time below.
      </Typography>
      <Button variant="outlined" startIcon={<SchoolIcon />} onClick={startTour}>
        Replay guided tour
      </Button>
    </Box>
  );
}
