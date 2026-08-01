"use client";

import React from 'react';
import { 
  Box, 
  FormControl, 
  FormControlLabel, 
  Switch,
  Typography,
  Paper,
  Alert
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { SpeechSettings } from '@/shared/types/storage/storage';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { checkWebSpeechSupport } from '@/frontend/services/transcription/webSpeech';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Settings/SpeechRecognitionSettings');

export default function SpeechRecognitionSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  
  // Check if Web Speech API is supported in this browser
  const speechSupport = checkWebSpeechSupport();
  
  // Default settings if not yet in storage
  const speechSettings = settings?.speech || {
    enabled: true
  };
  
  const handleEnableChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateSettings({
      ...settings,
      speech: {
        ...speechSettings,
        enabled: event.target.checked
      }
    });
  };
  
  return (
    <Box sx={{ p: 2 }}>
      {!speechSupport.supported && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {t('settings.speech.unsupported')}
        </Alert>
      )}
      
      <FormControl fullWidth sx={{ mb: 3 }}>
        <FormControlLabel
          control={
            <Switch
              checked={speechSettings.enabled}
              onChange={handleEnableChange}
              name="enabled"
              disabled={!speechSupport.supported}
            />
          }
          label={t('settings.speech.enable')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.speech.enableDescription')}
        </Typography>
      </FormControl>
      
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          {t('settings.speech.infoTitle')}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.technology')}</Typography>
          <Typography variant="body2">Web Speech API</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.processing')}</Typography>
          <Typography variant="body2">{t('settings.speech.browserBased')}</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.language')}</Typography>
          <Typography variant="body2">{t('settings.speech.autoLanguage')}</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.privacy')}</Typography>
          <Typography variant="body2">{t('settings.speech.browserPrivacy')}</Typography>
        </Box>
      </Paper>
      
      <Alert severity="info" sx={{ mt: 3 }}>
        <Typography variant="body2">
          {t('settings.speech.quality')}
        </Typography>
      </Alert>
    </Box>
  );
}
