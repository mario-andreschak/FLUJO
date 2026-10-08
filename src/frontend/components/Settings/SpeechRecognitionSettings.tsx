"use client";

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  FormControl,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { Model } from '@/shared/types';
import type { SpeechSettings } from '@/shared/types/storage';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { modelService } from '@/frontend/services/model';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Settings/SpeechRecognitionSettings');

function supportsFileTranscription(model: Model): boolean {
  return model.provider !== 'azure' && (
    model.adapter === undefined ||
    model.adapter === 'openai' ||
    model.adapter === 'openai-responses'
  );
}

export default function SpeechRecognitionSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  const [models, setModels] = useState<Model[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  const speechSettings = useMemo<SpeechSettings>(
    () => settings?.speech || { enabled: true },
    [settings?.speech],
  );

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);

    void modelService.loadModels()
      .then((loaded) => {
        if (!cancelled) {
          setModels(loaded.filter(supportsFileTranscription));
        }
      })
      .catch((error) => {
        log.error('Could not load transcription models', { error });
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setModelsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (models.length === 0 || !settings) return;

    const selectedModelExists = models.some(
      (model) => model.id === speechSettings.transcriptionModelId,
    );
    if (selectedModelExists) return;

    void updateSettings({
      ...settings,
      speech: {
        ...speechSettings,
        transcriptionModelId: models[0].id,
      },
    });
  }, [
    models,
    settings,
    speechSettings,
    updateSettings,
  ]);

  const updateSpeechSettings = (
    patch: Partial<SpeechSettings>,
  ) => {
    if (!settings) return;
    void updateSettings({
      ...settings,
      speech: {
        ...speechSettings,
        ...patch,
      },
    });
  };

  const handleEnableChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateSpeechSettings({ enabled: event.target.checked });
  };

  const handleTranscriptionModelChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    updateSpeechSettings({
      transcriptionModelId: event.target.value || undefined,
    });
  };

  const handleLanguageChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    updateSpeechSettings({
      language: event.target.value.trim() || undefined,
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 3 }}>
        <FormControlLabel
          control={
            <Switch
              checked={speechSettings.enabled}
              onChange={handleEnableChange}
              name="enabled"
            />
          }
          label={t('settings.speech.enable')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.speech.enableDescription')}
        </Typography>
      </FormControl>

      <TextField
        select
        fullWidth
        label={t('settings.speech.transcriptionModel')}
        value={speechSettings.transcriptionModelId ?? ''}
        onChange={handleTranscriptionModelChange}
        disabled={modelsLoading || models.length === 0}
        helperText={t('settings.speech.transcriptionModelDescription')}
        sx={{ mb: 3 }}
      >
        {models.map((model) => (
          <MenuItem key={model.id} value={model.id}>
            {model.displayName || model.name}
          </MenuItem>
        ))}
      </TextField>

      {modelsLoading && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {t('settings.speech.loadingModels')}
          </Typography>
        </Box>
      )}

      {!modelsLoading && models.length === 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          {t('settings.speech.noTranscriptionModels')}
        </Alert>
      )}

      <TextField
        fullWidth
        label={t('settings.speech.language')}
        value={speechSettings.language ?? ''}
        onChange={handleLanguageChange}
        placeholder={t('settings.speech.autoLanguage')}
        helperText={t('settings.speech.languageDescription')}
        sx={{ mb: 3 }}
      />

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          {t('settings.speech.infoTitle')}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.technology')}</Typography>
          <Typography variant="body2">{t('settings.speech.providerBased')}</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.processing')}</Typography>
          <Typography variant="body2">{t('settings.speech.serverBased')}</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="body2">{t('settings.speech.privacy')}</Typography>
          <Typography variant="body2">{t('settings.speech.serverPrivacy')}</Typography>
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
