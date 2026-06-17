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

const log = createLogger('frontend/components/Settings/UpdateSettings');

export default function UpdateSettings() {
  const { settings, updateSettings } = useStorage();

  const updateConfig = settings?.update || { checkOnStartup: false };

  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState<
    { severity: 'success' | 'error' | 'info' | 'warning'; message: string } | null
  >(null);

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
    setStatus(null);
    try {
      const res = await fetch('/api/update');
      const data = await res.json();
      if (!res.ok || data.success === false) {
        setStatus({ severity: 'error', message: data.error || 'Failed to check for updates.' });
      } else if (data.isGitRepo === false) {
        setStatus({ severity: 'info', message: data.message });
      } else if (data.updateAvailable) {
        setStatus({
          severity: 'warning',
          message: `An update is available (${data.behindBy} new commit${data.behindBy === 1 ? '' : 's'} on ${data.branch}).`
        });
      } else {
        setStatus({ severity: 'success', message: `FLUJO is up to date (v${data.currentVersion}).` });
      }
    } catch (error) {
      log.error('Update check failed', error);
      setStatus({ severity: 'error', message: 'Failed to check for updates.' });
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    setStatus({ severity: 'info', message: 'Updating FLUJO - this may take a few minutes...' });
    try {
      const res = await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply' })
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        setStatus({ severity: 'error', message: data.error || 'Update failed.' });
        setApplying(false);
        return;
      }
      setStatus({ severity: 'success', message: data.message });
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
      setStatus({ severity: 'error', message: 'Update failed.' });
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
          label="Check for updates on startup"
        />
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          When enabled, FLUJO checks GitHub for a newer version when the home page loads and shows
          a one-click update banner if one is available. Updates run <code>git pull</code> +
          rebuild in your install folder; your data is preserved.
        </Typography>
      </FormControl>

      <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
        <Button variant="outlined" onClick={handleCheck} disabled={checking || applying}>
          {checking ? <CircularProgress size={20} sx={{ mr: 1 }} /> : null}
          Check now
        </Button>
        <Button variant="contained" onClick={handleApply} disabled={applying}>
          {applying ? <CircularProgress size={20} sx={{ mr: 1 }} /> : null}
          Update now
        </Button>
      </Box>

      {status && (
        <Alert severity={status.severity} sx={{ mt: 1 }}>
          {status.message}
        </Alert>
      )}
    </Box>
  );
}
