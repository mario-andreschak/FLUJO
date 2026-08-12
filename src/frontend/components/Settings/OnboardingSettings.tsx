"use client";

import React from 'react';
import { Box, Button, Divider, Stack, Typography } from '@mui/material';
import SchoolIcon from '@mui/icons-material/School';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import { useTour } from '@/frontend/contexts/TourContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

export default function OnboardingSettings() {
  const {
    startTour,
    startBigTutorial,
    resumeBigTutorial,
    restartBigTutorial,
    bigTutorialProgress,
    isBigTutorialActive,
  } = useTour();
  const { t } = useI18n();

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t('settings.onboarding.description')}
      </Typography>
      <Stack spacing={2} alignItems="flex-start">
        <Button variant="outlined" startIcon={<SchoolIcon />} onClick={startTour}>
          {t('settings.onboarding.replay')}
        </Button>

        <Divider flexItem />

        <Box>
          <Typography variant="subtitle2" fontWeight={800} gutterBottom>
            Big tutorial · Stage 1
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Improve your Chat agent by connecting an app that can search the internet. Your place is saved after every step.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="flex-start">
            <Button
              variant="contained"
              startIcon={<PublicRoundedIcon />}
              disabled={isBigTutorialActive}
              onClick={bigTutorialProgress.status === 'paused' ? resumeBigTutorial : startBigTutorial}
            >
              {isBigTutorialActive
                ? 'Tutorial is running'
                : bigTutorialProgress.status === 'paused'
                  ? 'Continue Stage 1'
                  : bigTutorialProgress.status === 'completed'
                    ? 'Replay Stage 1'
                    : 'Start Stage 1'}
            </Button>
            <Button
              variant="outlined"
              disabled={isBigTutorialActive}
              onClick={() => void restartBigTutorial()}
            >
              Restart from beginning
            </Button>
          </Stack>
        </Box>
      </Stack>
    </Box>
  );
}
