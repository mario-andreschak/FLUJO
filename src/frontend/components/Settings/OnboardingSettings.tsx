"use client";

import React from 'react';
import { Box, Button, Typography } from '@mui/material';
import SchoolIcon from '@mui/icons-material/School';
import { useTour } from '@/frontend/contexts/TourContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function OnboardingSettings() {
  const { startTour } = useTour();
  const { t } = useI18n();

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('settings.onboarding.description')}
      </Typography>
      <Button variant="outlined" startIcon={<SchoolIcon />} onClick={startTour}>
        {t('settings.onboarding.replay')}
      </Button>
    </Box>
  );
}
