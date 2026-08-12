"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  FormControlLabel,
  Stack,
  Switch,
  Typography,
  Alert
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { ExperimentalSettings } from '@/shared/types/storage/storage';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';

const log = createLogger('frontend/components/Settings/ExperimentalFeaturesSettings');

type ConsentDecision = 'allow-once' | 'allow-always' | 'deny-always';

interface ConsentEntry {
  serverName: string;
  uri: string;
  decision: ConsentDecision;
  updatedAt: number;
}

function McpAppConsentManager() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ConsentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/mcp/app-consent?manage=true');
      if (!response.ok) throw new Error('Unable to load MCP App consent');
      const data = await response.json() as { entries?: ConsentEntry[] };
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch {
      setError(t('settings.experimental.mcpAppConsentLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void loadEntries(); }, [loadEntries]);

  const updateEntry = async (entry: ConsentEntry, decision?: 'allow-always' | 'deny-always') => {
    const key = `${entry.serverName}\u0000${entry.uri}`;
    setBusyKey(key);
    setError(null);
    try {
      const params = new URLSearchParams({ serverName: entry.serverName, uri: entry.uri });
      const response = decision
        ? await fetch('/api/mcp/app-consent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverName: entry.serverName, uri: entry.uri, decision }),
          })
        : await fetch(`/api/mcp/app-consent?${params}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Unable to update MCP App consent');
      if (decision) {
        setEntries((current) => current.map((candidate) => (
          candidate.serverName === entry.serverName && candidate.uri === entry.uri
            ? { ...candidate, decision, updatedAt: Date.now() }
            : candidate
        )));
      } else {
        setEntries((current) => current.filter((candidate) => (
          candidate.serverName !== entry.serverName || candidate.uri !== entry.uri
        )));
      }
    } catch {
      setError(t('settings.experimental.mcpAppConsentUpdateFailed'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Box sx={{ ml: 2, mb: 3, p: 2, border: 1, borderColor: 'divider', borderRadius: 1 }}>
      <Typography variant="subtitle2">{t('settings.experimental.mcpAppConsentTitle')}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        {t('settings.experimental.mcpAppConsentDescription')}
      </Typography>
      {loading && <CircularProgress size={18} aria-label={t('settings.experimental.mcpAppConsentLoading')} />}
      {!loading && entries.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t('settings.experimental.mcpAppConsentEmpty')}
        </Typography>
      )}
      <Stack spacing={1}>
        {entries.map((entry) => {
          const key = `${entry.serverName}\u0000${entry.uri}`;
          const busy = busyKey === key;
          const statusKey = entry.decision === 'deny-always'
            ? 'settings.experimental.mcpAppConsentBlocked'
            : entry.decision === 'allow-once'
              ? 'settings.experimental.mcpAppConsentAllowedOnce'
              : 'settings.experimental.mcpAppConsentAllowed';
          return (
            <Box key={key} sx={{ p: 1.25, border: 1, borderColor: 'divider', borderRadius: 1 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'center' }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" gap={1} alignItems="center">
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{entry.serverName}</Typography>
                    <Chip
                      size="small"
                      color={entry.decision === 'deny-always' ? 'default' : 'success'}
                      label={t(statusKey)}
                    />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
                    {entry.uri}
                  </Typography>
                </Box>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  <Button size="small" disabled={busy || entry.decision === 'allow-always'} onClick={() => { void updateEntry(entry, 'allow-always'); }}>
                    {t('settings.experimental.mcpAppConsentAllow')}
                  </Button>
                  <Button size="small" color="inherit" disabled={busy || entry.decision === 'deny-always'} onClick={() => { void updateEntry(entry, 'deny-always'); }}>
                    {t('settings.experimental.mcpAppConsentBlock')}
                  </Button>
                  <Button size="small" color="inherit" disabled={busy} onClick={() => { void updateEntry(entry); }}>
                    {t('settings.experimental.mcpAppConsentAskAgain')}
                  </Button>
                </Stack>
              </Stack>
            </Box>
          );
        })}
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
    </Box>
  );
}

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

  const handleCodexModelCatalogCacheChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Codex model catalog cache toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        codexModelCatalogCache: event.target.checked,
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

  const handleSubflowToolInvocationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Subflow tool invocation toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        subflowToolInvocation: event.target.checked,
      },
    });
  };

  const handleSubflowSessionsChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Subflow sessions toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        subflowSessions: event.target.checked,
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

      {experimental.requireMcpAppLaunchClick === true && <McpAppConsentManager />}

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
              checked={experimental.codexModelCatalogCache ?? false}
              onChange={handleCodexModelCatalogCacheChange}
              name="codexModelCatalogCache"
            />
          }
          label={t('settings.experimental.codexModelCatalogCache')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.codexModelCatalogCacheDescription')}
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
              checked={experimental.snapshotsEnabled ?? false}
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

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.subflowToolInvocation ?? false}
              onChange={handleSubflowToolInvocationChange}
              name="subflowToolInvocation"
            />
          }
          label={t('settings.experimental.subflowToolInvocation')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.subflowToolInvocationDescription')}
        </Typography>
      </FormControl>

      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={experimental.subflowSessions ?? false}
              onChange={handleSubflowSessionsChange}
              name="subflowSessions"
            />
          }
          label={t('settings.experimental.subflowSessions')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.experimental.subflowSessionsDescriptionV2')}
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
