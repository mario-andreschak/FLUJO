"use client";

import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
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
import SnapshotStorageSettings from './SnapshotStorageSettings';

const log = createLogger('frontend/components/Settings/ExperimentalFeaturesSettings');

type ConsentDecision = 'allow-once' | 'allow-always' | 'deny-always';

interface ConsentEntry {
  serverName: string;
  uri: string;
  decision: ConsentDecision;
  updatedAt: number;
}

interface ExperimentalSettingsGroupProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

interface ExperimentalToggleProps {
  checked: boolean;
  description: string;
  disabled?: boolean;
  indented?: boolean;
  label: string;
  name: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

function ExperimentalSettingsGroup({ id, title, children }: ExperimentalSettingsGroupProps) {
  const titleId = `experimental-${id}-title`;
  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        p: { xs: 2, sm: 2.5 },
      }}
    >
      <Typography id={titleId} component="h2" variant="h6">
        {title}
      </Typography>
      <Divider sx={{ my: 2 }} />
      <Stack spacing={2.5}>{children}</Stack>
    </Box>
  );
}

function ExperimentalToggle({
  checked,
  description,
  disabled = false,
  indented = false,
  label,
  name,
  onChange,
}: ExperimentalToggleProps) {
  return (
    <FormControl
      fullWidth
      sx={indented ? { pl: 2, borderLeft: 2, borderColor: 'divider' } : undefined}
    >
      <FormControlLabel
        control={(
          <Switch
            checked={checked}
            disabled={disabled}
            name={name}
            onChange={onChange}
          />
        )}
        label={label}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {description}
      </Typography>
    </FormControl>
  );
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

  const handleSummarizingCompactionChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`AI summarizing compaction toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        compactionEnabled: event.target.checked,
      },
    });
  };

  const handleSubflowDetachedInvocationChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    log.debug(`Detached subflow invocation toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        subflowDetachedInvocation: event.target.checked,
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
      <Stack spacing={3}>
        <ExperimentalSettingsGroup
          id="feature-access"
          title={t('settings.experimental.group.featureAccess')}
        >
          <Box>
            <ExperimentalToggle
              checked={experimental.enabled}
              description={t('settings.experimental.enableDescription')}
              label={t('settings.experimental.enable')}
              name="experimentalEnabled"
              onChange={handleEnableChange}
            />
            <Alert severity="info" sx={{ mt: 2 }}>
              <Typography variant="body2">
                {t('settings.experimental.disableInfo')}
              </Typography>
            </Alert>
          </Box>
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="model-behavior"
          title={t('settings.experimental.group.modelBehavior')}
        >
          <ExperimentalToggle
            checked={experimental.showModelsWithoutToolCapabilities ?? false}
            description={t('settings.experimental.modelsWithoutToolsDescription')}
            label={t('settings.experimental.modelsWithoutTools')}
            name="showModelsWithoutToolCapabilities"
            onChange={handleShowModelsWithoutToolsChange}
          />
          <ExperimentalToggle
            checked={experimental.claudeSessionResume ?? false}
            description={t('settings.experimental.claudeResumeDescription')}
            label={t('settings.experimental.claudeResume')}
            name="claudeSessionResume"
            onChange={handleClaudeSessionResumeChange}
          />
          <ExperimentalToggle
            checked={experimental.codexModelCatalogCache ?? false}
            description={t('settings.experimental.codexModelCatalogCacheDescription')}
            label={t('settings.experimental.codexModelCatalogCache')}
            name="codexModelCatalogCache"
            onChange={handleCodexModelCatalogCacheChange}
          />
          <ExperimentalToggle
            checked={experimental.autoUnloadOllamaModels ?? false}
            description={t('settings.experimental.ollamaDescription')}
            label={t('settings.experimental.ollama')}
            name="autoUnloadOllamaModels"
            onChange={handleAutoUnloadOllamaChange}
          />
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="context-management"
          title={t('settings.experimental.group.contextManagement')}
        >
          <ExperimentalToggle
            checked={experimental.compactionEnabled ?? false}
            description={t('settings.experimental.summarizingCompactionDescription')}
            label={t('settings.experimental.summarizingCompaction')}
            name="compactionEnabled"
            onChange={handleSummarizingCompactionChange}
          />
          <ExperimentalToggle
            checked={experimental.visualCompactionEnabled ?? false}
            description={t('settings.experimental.visualCompactionDescription')}
            label={t('settings.experimental.visualCompaction')}
            name="visualCompactionEnabled"
            onChange={handleVisualCompactionChange}
          />
          <ExperimentalToggle
            checked={experimental.visualCompactionToolResultsOnly !== false}
            description={t('settings.experimental.toolResultsOnlyDescription')}
            disabled={!experimental.visualCompactionEnabled}
            indented
            label={t('settings.experimental.toolResultsOnly')}
            name="visualCompactionToolResultsOnly"
            onChange={handleVisualToolResultsOnlyChange}
          />
          <ExperimentalToggle
            checked={experimental.visualCompactionEvaluationMode ?? false}
            description={t('settings.experimental.evaluationDescription')}
            disabled={!experimental.visualCompactionEnabled}
            indented
            label={t('settings.experimental.evaluation')}
            name="visualCompactionEvaluationMode"
            onChange={handleVisualEvaluationModeChange}
          />
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="flow-execution"
          title={t('settings.experimental.group.flowExecution')}
        >
          <ExperimentalToggle
            checked={experimental.flowBasedGenerator ?? false}
            description={t('settings.experimental.flowGeneratorDescription')}
            disabled={!experimental.enabled}
            label={t('settings.experimental.flowGenerator')}
            name="flowBasedGenerator"
            onChange={handleFlowBasedGeneratorChange}
          />
          <ExperimentalToggle
            checked={experimental.subflowToolInvocation ?? false}
            description={t('settings.experimental.subflowToolInvocationDescription')}
            label={t('settings.experimental.subflowToolInvocation')}
            name="subflowToolInvocation"
            onChange={handleSubflowToolInvocationChange}
          />
          <ExperimentalToggle
            checked={experimental.subflowDetachedInvocation ?? false}
            description={t('settings.experimental.subflowDetachedInvocationDescription')}
            label={t('settings.experimental.subflowDetachedInvocation')}
            name="subflowDetachedInvocation"
            onChange={handleSubflowDetachedInvocationChange}
          />
          <ExperimentalToggle
            checked={experimental.subflowSessions ?? false}
            description={t('settings.experimental.subflowSessionsDescriptionV2')}
            label={t('settings.experimental.subflowSessions')}
            name="subflowSessions"
            onChange={handleSubflowSessionsChange}
          />
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="mcp-and-apps"
          title={t('settings.experimental.group.mcpAndApps')}
        >
          <ExperimentalToggle
            checked={experimental.mcpBetaProtocol ?? false}
            description={t('settings.experimental.mcpBetaDescription')}
            label={t('settings.experimental.mcpBeta')}
            name="mcpBetaProtocol"
            onChange={handleMcpBetaProtocolChange}
          />
          <ExperimentalToggle
            checked={experimental.restrictMcpFilesystemToRoots ?? false}
            description={t('settings.experimental.restrictMcpFilesystemToRootsDescription')}
            label={t('settings.experimental.restrictMcpFilesystemToRoots')}
            name="restrictMcpFilesystemToRoots"
            onChange={handleMcpRootsRestrictionChange}
          />
          <Box>
            <ExperimentalToggle
              checked={experimental.requireMcpAppLaunchClick ?? false}
              description={t('settings.experimental.requireMcpAppLaunchClickDescription')}
              label={t('settings.experimental.requireMcpAppLaunchClick')}
              name="requireMcpAppLaunchClick"
              onChange={handleMcpAppLaunchRestrictionChange}
            />
            {experimental.requireMcpAppLaunchClick === true && <McpAppConsentManager />}
          </Box>
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="snapshots-and-recovery"
          title={t('settings.experimental.group.snapshotsAndRecovery')}
        >
          <ExperimentalToggle
            checked={experimental.snapshotsEnabled ?? false}
            description={t('settings.experimental.snapshotsDescription')}
            label={t('settings.experimental.snapshots')}
            name="snapshotsEnabled"
            onChange={handleSnapshotsChange}
          />
          <SnapshotStorageSettings showCaptureToggle={false} />
        </ExperimentalSettingsGroup>
      </Stack>
    </Box>
  );
}
