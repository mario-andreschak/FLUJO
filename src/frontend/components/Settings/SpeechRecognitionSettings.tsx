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

const log = createLogger('frontend/components/Settings/SpeechRecognitionSettings');

export default function SpeechRecognitionSettings() {
  const { settings, updateSettings } = useStorage();
  
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
          Speech recognition is not supported in your browser. Please use Chrome, Edge, or Safari for the best experience.
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
          label="Enable speech recognition"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          When enabled, audio recordings will be transcribed using your browser's built-in offfline speech recognition capabilities.
        </Typography>
      </FormControl>
      
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Speech Recognition Information
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">Technology:</Typography>
          <Typography variant="body2">Web Speech API</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">Processing:</Typography>
          <Typography variant="body2">Browser-based</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">Language:</Typography>
          <Typography variant="body2">Automatically uses browser language</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">Privacy:</Typography>
          <Typography variant="body2">Depends on browser implementation</Typography>
        </Box>
      </Paper>
      
      <Alert severity="info" sx={{ mt: 3 }}>
        <Typography variant="body2">
          Speech recognition quality may vary based on your browser, microphone quality, and background noise. For best results, speak clearly and use a good quality microphone.
        </Typography>
      </Alert>
    </Box>
  );
}