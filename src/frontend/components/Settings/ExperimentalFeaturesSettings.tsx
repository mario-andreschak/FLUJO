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
  Alert,
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import type { ExperimentalSettings } from '@/shared/types/storage/storage';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { useStorage } from '@/frontend/contexts/StorageContext';
import SnapshotStorageSettings from './SnapshotStorageSettings';
import ToolResultLimitSettings from './ToolResultLimitSettings';

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
  label,
  name,
  onChange,
}: ExperimentalToggleProps) {
  return (
    <FormControl fullWidth>
      <FormControlLabel
        control={(
          <Switch
            checked={checked}
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
              <Stack direction={{ xs: 'column', sm: 'row' }} sx={{ gap: 1, alignItems: { sm: 'center' } }}>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" sx={{ gap: 1, alignItems: "center" }}>
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
                <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
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

/** Advanced settings: MCP safety choices, tool-result limits and snapshot storage. */
export default function ExperimentalFeaturesSettings() {
  const { settings, updateSettings } = useStorage();
  const { t } = useI18n();
  const experimental: ExperimentalSettings = settings?.experimental ?? {};

  const setChoice = (name: 'requireMcpAppLaunchClick' | 'restrictMcpFilesystemToRoots') => (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    log.debug(`${name} toggled: ${event.target.checked}`);
    updateSettings({
      ...settings,
      experimental: {
        ...experimental,
        [name]: event.target.checked,
      },
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <Stack spacing={3}>
        <ExperimentalSettingsGroup
          id="context-management"
          title={t('settings.experimental.group.contextManagement')}
        >
          <ToolResultLimitSettings />
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="mcp-and-apps"
          title={t('settings.experimental.group.mcpAndApps')}
        >
          <ExperimentalToggle
            checked={experimental.restrictMcpFilesystemToRoots ?? false}
            description={t('settings.experimental.restrictMcpFilesystemToRootsDescription')}
            label={t('settings.experimental.restrictMcpFilesystemToRoots')}
            name="restrictMcpFilesystemToRoots"
            onChange={setChoice('restrictMcpFilesystemToRoots')}
          />
          <Box>
            <ExperimentalToggle
              checked={experimental.requireMcpAppLaunchClick ?? false}
              description={t('settings.experimental.requireMcpAppLaunchClickDescription')}
              label={t('settings.experimental.requireMcpAppLaunchClick')}
              name="requireMcpAppLaunchClick"
              onChange={setChoice('requireMcpAppLaunchClick')}
            />
            {experimental.requireMcpAppLaunchClick === true && <McpAppConsentManager />}
          </Box>
        </ExperimentalSettingsGroup>

        <ExperimentalSettingsGroup
          id="snapshots-and-recovery"
          title={t('settings.experimental.group.snapshotsAndRecovery')}
        >
          <SnapshotStorageSettings />
        </ExperimentalSettingsGroup>
      </Stack>
    </Box>
  );
}
