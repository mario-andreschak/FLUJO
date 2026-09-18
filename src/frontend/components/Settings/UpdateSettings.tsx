"use client";

import React, { useState } from 'react';
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  Switch,
  Typography,
  Alert,
  CircularProgress
} from '@mui/material';
import { createLogger } from '@/utils/logger';
import { useStorage } from '@/frontend/contexts/StorageContext';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Settings/UpdateSettings');

export default function UpdateSettings() {
  const { settings, updateSettings } = useStorage();
  const { t, tp } = useI18n();

  const updateConfig = settings?.update || { checkOnStartup: false };

  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<
    { severity: 'success' | 'error' | 'info' | 'warning'; message: string } | null
  >(null);
  // How this install updates itself: 'git' (in-app pull), or 'container'/'npm'/'none'
  // (self-update unavailable — the user pulls a new image / reinstalls the package).
  // Null until the first check; the in-app "Update now" action only applies to 'git'.
  const [updateMode, setUpdateMode] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [source, setSource] = useState<{ ref: string; revision: string } | null>(null);
  const canSelfUpdate = updateMode === 'git' && updateAvailable;

  const handleToggle = (event: React.ChangeEvent<HTMLInputElement>) => {
    updateSettings({
      ...settings,
      update: {
        ...updateConfig,
        checkOnStartup: event.target.checked
      }
    });
  };

  const handleCheck = async () => {
    setChecking(true);
    setUpdateAvailable(false);
    setStatus(null);
    try {
      const res = await fetch('/api/update');
      const data = await res.json();
      if (typeof data.updateMode === 'string') {
        setUpdateMode(data.updateMode);
      }
      setSource(data.sourceRef && data.revision ? { ref: data.sourceRef, revision: data.revision.slice(0, 12) } : null);
      if (!res.ok || data.success === false) {
        setStatus({ severity: 'error', message: data.error || t('settings.update.checkFailed') });
      } else if (data.updateMode === 'pinned') {
        setStatus({ severity: 'info', message: t('settings.update.pinned') });
      } else if (data.updateMode === 'blocked' || data.canApply === false && data.isGitRepo) {
        setStatus({ severity: 'warning', message: data.message || t('settings.update.checkFailed') });
      } else if (data.isGitRepo === false) {
        const mode = data.updateMode as string | undefined;
        setStatus({
          severity: 'info',
          message: t(mode === 'container'
            ? 'settings.update.container'
            : mode === 'npm'
              ? 'settings.update.npm'
              : 'settings.update.notGit'),
        });
      } else if (data.updateAvailable) {
        setUpdateAvailable(true);
        setStatus({
          severity: 'warning',
          message: tp('settings.update.available', data.behindBy, { branch: data.branch }),
        });
      } else {
        setStatus({ severity: 'success', message: t('settings.update.current', { version: data.currentVersion }) });
      }
    } catch (error) {
      log.error('Update check failed', error);
      setStatus({ severity: 'error', message: t('settings.update.checkFailed') });
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async () => {
    if (!canSelfUpdate || checking || applying) return;
    setApplying(true);
    setUpdateAvailable(false);
    setStatus({ severity: 'info', message: t('settings.update.progress') });
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' })
      });
      const data = await res.json();
      if (typeof data.updateMode === 'string') setUpdateMode(data.updateMode);
      if (!res.ok || data.success === false) {
        setStatus({ severity: 'error', message: data.error || t('home.updateFailed') });
        setApplying(false);
        return;
      }
      setStatus({ severity: 'success', message: data.message || t('settings.update.complete') });
      if (data.restarting) {
        // The server stops, rebuilds, and comes back up (can take minutes).
        // Poll until it goes DOWN and then UP again, then reload.
        let sawDown = false;
        const poll = async () => {
          try {
            const ping = await fetch('/api/cwd', { cache: 'no-store' });
            if (ping.ok && sawDown) {
              window.location.reload();
              return;
            }
          } catch {
            sawDown = true; // server is down -> rebuilding
          }
          setTimeout(poll, 3000);
        };
        setTimeout(poll, 5000);
      } else {
        setApplying(false);
      }
    } catch (error) {
      log.error('Update failed', error);
      setStatus({ severity: 'error', message: t('home.updateFailed') });
      setApplying(false);
    }
  };

  return (
    <Box sx={{ p: 2 }}>
      <FormControl fullWidth sx={{ mb: 2 }}>
        <FormControlLabel
          control={
            <Switch
              checked={updateConfig.checkOnStartup}
              onChange={handleToggle}
              name="checkOnStartup"
            />
          }
          label={t('settings.update.checkStartup')}
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {t('settings.update.checkDescription')}
        </Typography>
        {updateMode === null && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('settings.update.checkBeforeApply')}</Typography>}
        {source && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{t('settings.update.source', source)}</Typography>}
        {updateMode && ['container', 'npm', 'none'].includes(updateMode) && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t(updateMode === 'container'
              ? 'settings.update.container'
              : updateMode === 'npm'
                ? 'settings.update.npm'
                : 'settings.update.notGit')}
          </Typography>
        )}
      </FormControl>

      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <Button variant="outlined" onClick={handleCheck} disabled={checking || applying}>
          {checking ? <CircularProgress size={20} sx={{ mr: 1 }} /> : null}
          {t('settings.update.checkNow')}
        </Button>
        <Button variant="contained" onClick={handleApply} disabled={checking || applying || !canSelfUpdate}>
          {applying ? <CircularProgress size={20} sx={{ mr: 1 }} /> : null}
          {t('home.updateNow')}
        </Button>
        {updateMode === 'pinned' && (
          <Button component="a" href="https://github.com/mario-andreschak/FLUJO/releases/latest" target="_blank" rel="noreferrer" variant="outlined">
            {t('settings.update.downloadInstaller')}
          </Button>
        )}
      </Box>

      {status && (
        <Alert severity={status.severity} sx={{ mt: 1 }}>
          {status.message}
        </Alert>
      )}
    </Box>
  );
}
