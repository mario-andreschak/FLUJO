"use client";

import React from 'react';
import {
  Box,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
  Alert
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { ExperimentalSettings } from '@/shared/types/storage/storage';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/Settings/ExperimentalFeaturesSettings');

export default function ExperimentalFeaturesSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();

  // Missing/undefined is treated as disabled — the "experimental" default.
  const experimental: ExperimentalSettings = settings?.experimental ?? { enabled: false };

  const handleEnableChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Experimental features toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        enabled: event.target.checked,
      },
    });
  };

  const handleClaudeSessionResumeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Claude session resume toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        claudeSessionResume: event.target.checked,
      },
    });
  };

  const handleAutoUnloadOllamaChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Auto-unload Ollama models toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        autoUnloadOllamaModels: event.target.checked,
      },
    });
  };

  const handleMcpBetaProtocolChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`MCP beta protocol toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        mcpBetaProtocol: event.target.checked,
      },
    });
  };

  const handleFlowBasedGeneratorChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Flow-based generator toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        flowBasedGenerator: event.target.checked,
      },
    });
  };

  const handleProtectedPathsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Protected paths toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        protectedPathsEnabled: event.target.checked,
      },
    });
  };

  const handleMcpAppLaunchRestrictionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`MCP App click-to-launch restriction toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        requireMcpAppLaunchClick: event.target.checked,
      },
    });
  };

  const handleMcpRootsRestrictionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`MCP roots restriction toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        restrictMcpFilesystemToRoots: event.target.checked,
      },
    });
  };

  const handleSnapshotsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Filesystem snapshots toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        snapshotsEnabled: event.target.checked,
      },
    });
  };

  const handleShowModelsWithoutToolsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Show models without tool capabilities toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        showModelsWithoutToolCapabilities: event.target.checked,
      },
    });
  };

  const handleVisualCompactionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual context compaction toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionEnabled: event.target.checked,
      },
    });
  };

  const handleVisualToolResultsOnlyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual compaction tool-results-only toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionToolResultsOnly: event.target.checked,
      },
    });
  };

  const handleVisualEvaluationModeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Visual compaction evaluation mode toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        visualCompactionEvaluationMode: event.target.checked,
      },
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.requireMcpAppLaunchClick ?? false}
              onChange={handleMcpAppLaunchRestrictionChange}
              name="requireMcpAppLaunchClick"
            />
          }
          label={t('settings.experimental.requireMcpAppLaunchClick')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.requireMcpAppLaunchClickDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.restrictMcpFilesystemToRoots ?? false}
              onChange={handleMcpRootsRestrictionChange}
              name="restrictMcpFilesystemToRoots"
            />
          }
          label={t('settings.experimental.restrictMcpFilesystemToRoots')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.restrictMcpFilesystemToRootsDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.enabled}
              onChange={handleEnableChange}
              name="experimentalEnabled"
            />
          }
          label={t('settings.experimental.enable')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.enableDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.claudeSessionResume ?? false}
              onChange={handleClaudeSessionResumeChange}
              name="claudeSessionResume"
            />
          }
          label={t('settings.experimental.claudeResume')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.claudeResumeDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.visualCompactionEnabled ?? false}
              onChange={handleVisualCompactionChange}
              name="visualCompactionEnabled"
            />
          }
          label={t('settings.experimental.visualCompaction')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.visualCompactionDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2, ml: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.visualCompactionToolResultsOnly !== false}
              onChange={handleVisualToolResultsOnlyChange}
              name="visualCompactionToolResultsOnly"
              disabled={!experimental.visualCompactionEnabled}
            />
          }
          label={t('settings.experimental.toolResultsOnly')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.toolResultsOnlyDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2, ml: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.visualCompactionEvaluationMode ?? false}
              onChange={handleVisualEvaluationModeChange}
              name="visualCompactionEvaluationMode"
              disabled={!experimental.visualCompactionEnabled}
            />
          }
          label={t('settings.experimental.evaluation')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.evaluationDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.autoUnloadOllamaModels ?? false}
              onChange={handleAutoUnloadOllamaChange}
              name="autoUnloadOllamaModels"
            />
          }
          label={t('settings.experimental.ollama')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.ollamaDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.showModelsWithoutToolCapabilities ?? false}
              onChange={handleShowModelsWithoutToolsChange}
              name="showModelsWithoutToolCapabilities"
            />
          }
          label={t('settings.experimental.modelsWithoutTools')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.modelsWithoutToolsDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.mcpBetaProtocol ?? false}
              onChange={handleMcpBetaProtocolChange}
              name="mcpBetaProtocol"
            />
          }
          label={t('settings.experimental.mcpBeta')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.mcpBetaDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.flowBasedGenerator ?? false}
              onChange={handleFlowBasedGeneratorChange}
              name="flowBasedGenerator"
              disabled={!experimental.enabled}
            />
          }
          label={t('settings.experimental.flowGenerator')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.flowGeneratorDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.protectedPathsEnabled ?? false}
              onChange={handleProtectedPathsChange}
              name="protectedPathsEnabled"
            />
          }
          label={t('settings.experimental.protectedPaths')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.protectedPathsDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.snapshotsEnabled ?? true}
              onChange={handleSnapshotsChange}
              name="snapshotsEnabled"
            />
          }
          label={t('settings.experimental.snapshots')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.snapshotsDescription')}
        </Typography>
      </FormControl>

      <Alert severity="info">
        <Typography variant="body2">
          {t('settings.experimental.disableInfo')}
        </Typography>
      </Alert>
    </Box>
  );
}
