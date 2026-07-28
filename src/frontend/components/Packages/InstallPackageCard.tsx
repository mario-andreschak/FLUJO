'use client';

import { useCallback, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import { packageService, type InstallSummary } from '@/frontend/services/packages';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Packages/InstallPackageCard');

/**
 * "Install from registry" card (issue #198 follow-up). The install orchestrator
 * and REST API shipped as backend-only; there is no package search/browse API
 * yet (that's the online registry, #196's follow-on), so this looks up a
 * package by its exact id (+ optional version) rather than offering a browse
 * list. Two-phase against POST /api/packages/install: a dry-run preview
 * (consentGranted: false) shows exactly what will be created and which secrets
 * are needed, then the user confirms and supplies secret values to install for
 * real (consentGranted: true).
 */
export default function InstallPackageCard({ onInstalled }: { onInstalled?: () => void }) {
  const [packageId, setPackageId] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<InstallSummary | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<InstallSummary | null>(null);

  const reset = useCallback(() => {
    setPreview(null);
    setSecretValues({});
    setResult(null);
    setError(null);
  }, []);

  const fetchPreview = useCallback(async () => {
    if (!packageId.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const summary = await packageService.installFromRegistry({
        packageId: packageId.trim(),
        version: version.trim() || undefined,
        consentGranted: false,
      });
      if (!summary.ok) {
        setError(summary.errors?.[0] || 'Failed to fetch package preview.');
        setPreview(null);
        return;
      }
      setPreview(summary);
      setSecretValues({});
    } catch (err) {
      log.warn('Failed to fetch package preview', err);
      setError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [packageId, version]);

  const install = useCallback(async () => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await packageService.installFromRegistry({
        packageId: packageId.trim(),
        version: version.trim() || undefined,
        secrets: secretValues,
        consentGranted: true,
      });
      setResult(summary);
      setPreview(null);
      if (summary.ok) onInstalled?.();
    } catch (err) {
      log.warn('Install failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [preview, packageId, version, secretValues, onInstalled]);

  const manifest = preview?.preview;

  return (
    <Paper variant="outlined" sx={{ p: 3, maxWidth: { xs: '100%', md: 1100 }, mx: 'auto', mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <CloudDownloadOutlinedIcon color="action" />
        <Typography variant="h6">Install from registry</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Enter the exact package id from the online registry. There is no browse/search yet — if you
        don&apos;t know the id, get it from whoever published the package.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {!preview && !result && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField
            size="small"
            label="Package id"
            placeholder="e.g. acme/support-triage"
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            fullWidth
          />
          <TextField
            size="small"
            label="Version"
            placeholder="latest"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            sx={{ width: { xs: '100%', sm: 160 } }}
          />
          <Button
            variant="contained"
            onClick={() => void fetchPreview()}
            disabled={loading || !packageId.trim()}
            startIcon={loading ? <CircularProgress size={16} /> : undefined}
          >
            Look up
          </Button>
        </Stack>
      )}

      {manifest && preview?.package && (
        <Box sx={{ mt: 2 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1">{preview.package.name}</Typography>
            <Chip size="small" variant="outlined" label={`v${preview.package.version}`} />
            {preview.package.publisher && (
              <Chip size="small" variant="outlined" label={preview.package.publisher} />
            )}
          </Stack>

          <Typography variant="caption" color="text.secondary">
            {manifest.servers.length} MCP server(s) · {manifest.models.length} model(s) ·{' '}
            {manifest.flows.length} flow(s) · {manifest.plannedExecutions.length} planned execution(s)
          </Typography>

          {manifest.servers.some((s) => s.requiredEnvMissing.length > 0) && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              Some MCP servers require environment values that aren&apos;t covered by a secret below —
              those servers will install disabled.
            </Alert>
          )}

          <Divider sx={{ my: 2 }} />

          {manifest.secrets.length > 0 ? (
            <>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                Secrets requested by this package
              </Typography>
              <Stack spacing={1.5} sx={{ mb: 2 }}>
                {manifest.secrets.map((s) => (
                  <TextField
                    key={s.key}
                    size="small"
                    type="password"
                    label={s.label || s.key}
                    helperText={
                      s.required
                        ? 'Required — leave blank to install the dependent entity disabled'
                        : 'Optional'
                    }
                    value={secretValues[s.key] ?? ''}
                    onChange={(e) => setSecretValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                    fullWidth
                  />
                ))}
              </Stack>
            </>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              This package doesn&apos;t request any secrets.
            </Typography>
          )}

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              color="primary"
              onClick={() => void install()}
              disabled={loading}
              startIcon={loading ? <CircularProgress size={16} /> : <CloudDownloadOutlinedIcon />}
            >
              Install package
            </Button>
            <Button onClick={reset} disabled={loading}>
              Cancel
            </Button>
          </Stack>
        </Box>
      )}

      {result && (
        <Box sx={{ mt: 2 }}>
          <Alert severity={result.ok ? 'success' : 'error'} sx={{ mb: 1 }}>
            {result.ok
              ? `Installed "${result.package?.name}": ${result.created.length} created, ${result.updated.length} updated, ${result.disabled.length} disabled.`
              : `Install failed: ${result.errors[0] ?? 'unknown error'}`}
          </Alert>
          <Button size="small" onClick={reset}>
            Install another package
          </Button>
        </Box>
      )}
    </Paper>
  );
}
