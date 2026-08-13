"use client";

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Collapse,
  Divider,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import type { SnapshotRetentionPolicy, SnapshotStatus } from '@/shared/types/snapshot';
import { useStorage } from '@/frontend/contexts/StorageContext';

const GIB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

function formatBytes(bytes: number) {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(2)} GiB` : `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Management surface for derived filesystem snapshot history. */
export default function SnapshotStorageSettings() {
  const { settings, updateSettings } = useStorage();
  const [status, setStatus] = useState<SnapshotStatus | null>(null);
  const [draft, setDraft] = useState<SnapshotRetentionPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showRepositories, setShowRepositories] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/snapshots');
      if (!response.ok) throw new Error('Unable to load snapshot storage');
      const next = await response.json() as SnapshotStatus;
      setStatus(next);
      setDraft(next.policy);
      setError(null);
    } catch {
      setError('Unable to load filesystem snapshot storage.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const savePolicy = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const response = await fetch('/api/snapshots', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { policy: SnapshotRetentionPolicy };
      setDraft(result.policy);
      setMessage('Retention policy saved. Existing history was not deleted.');
      await refresh();
    } catch {
      setError('Unable to save the retention policy.');
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async (action: 'clean-old' | 'delete-all') => {
    setBusy(true);
    try {
      const response = await fetch('/api/snapshots/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          ...(action === 'delete-all' ? { confirmation } : {}),
        }),
      });
      const result = await response.json() as { error?: string; reclaimedBytes?: number };
      if (!response.ok) throw new Error(result.error || 'Unable to clean history');
      setConfirmation('');
      setMessage(`${action === 'delete-all' ? 'Deleted all snapshot history' : 'Cleaned old snapshots'}; reclaimed ${formatBytes(result.reclaimedBytes || 0)}.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to clean snapshot history.');
    } finally {
      setBusy(false);
    }
  };

  const captureEnabled = settings.experimental?.snapshotsEnabled !== false;
  const setCaptureEnabled = (enabled: boolean) => {
    void updateSettings({
      ...settings,
      experimental: {
        enabled: settings.experimental?.enabled ?? false,
        ...settings.experimental,
        snapshotsEnabled: enabled,
      },
    });
  };

  return (
    <Box sx={{ p: 2 }}>
      <Typography variant="h6">Filesystem snapshots</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        Snapshot history supports Diff and Revert. It is derived data: cleanup never deletes project files or your project&apos;s .git directory.
      </Typography>
      <FormControlLabel
        control={<Switch checked={captureEnabled} onChange={(event) => setCaptureEnabled(event.target.checked)} />}
        label="Capture filesystem snapshots"
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Turning capture off stops new snapshots and does not free disk space.
      </Typography>
      {loading && <CircularProgress size={20} />}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {message && <Alert severity="success" sx={{ mb: 1 }}>{message}</Alert>}
      {status && draft && (
        <Stack spacing={2}>
          <Typography variant="body2">
            {formatBytes(status.usage.onDiskBytes)} on disk · {formatBytes(status.usage.logicalBytes)} Git objects · {status.usage.repositoryCount} repositories
          </Typography>
          <Divider />
          <Typography variant="subtitle2">Retention</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField
              label="Workspace limit (GiB)"
              type="number"
              value={draft.maxBytes / GIB}
              inputProps={{ min: 0, step: 0.1 }}
              onChange={(event) => setDraft({ ...draft, maxBytes: Math.round(Number(event.target.value) * GIB) })}
              fullWidth
            />
            <TextField
              label="Maximum age (days)"
              type="number"
              value={draft.maxAgeMs / DAY}
              inputProps={{ min: 0, step: 1 }}
              onChange={(event) => setDraft({ ...draft, maxAgeMs: Math.round(Number(event.target.value) * DAY) })}
              fullWidth
            />
            <TextField
              label="Captures per root"
              type="number"
              value={draft.maxCapturesPerRoot}
              inputProps={{ min: 0, step: 1 }}
              onChange={(event) => setDraft({ ...draft, maxCapturesPerRoot: Math.round(Number(event.target.value)) })}
              fullWidth
            />
          </Stack>
          <FormControlLabel
            control={<Switch checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />}
            label="Apply retention limits"
          />
          <FormControlLabel
            control={<Switch checked={draft.automaticCleanup} onChange={(event) => setDraft({ ...draft, automaticCleanup: event.target.checked })} />}
            label="Clean after capture when limits are exceeded"
          />
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Button variant="outlined" onClick={() => { void savePolicy(); }} disabled={busy}>Save retention</Button>
            <Button color="warning" variant="outlined" onClick={() => { void cleanup('clean-old'); }} disabled={busy || status.activity.cleanup}>
              Clean old snapshots
            </Button>
          </Stack>
          <Button size="small" onClick={() => setShowRepositories((shown) => !shown)}>
            {showRepositories ? 'Hide' : 'Show'} repository details
          </Button>
          <Collapse in={showRepositories}>
            <Stack spacing={1}>
              {status.usage.repositories.map((repository) => (
                <Box key={repository.id} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
                  <Typography variant="body2">{repository.label} · {repository.health}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {formatBytes(repository.onDiskBytes)} on disk · {repository.commitCount} captures
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Collapse>
          <Divider />
          <Typography variant="subtitle2">Delete all snapshot history</Typography>
          <Typography variant="body2" color="text.secondary">
            This removes stored Diff and Revert history, not project files or your project&apos;s .git directory. Type DELETE SNAPSHOTS to continue.
          </Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <TextField value={confirmation} onChange={(event) => setConfirmation(event.target.value)} label="Confirmation" />
            <Button color="error" variant="contained" disabled={busy || confirmation !== 'DELETE SNAPSHOTS'} onClick={() => { void cleanup('delete-all'); }}>
              Delete all history
            </Button>
          </Stack>
        </Stack>
      )}
    </Box>
  );
}
