'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Grid,
  IconButton,
  InputAdornment,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { packageService, type InstallSummary, type RegistryPackageSearchResult } from '@/frontend/services/packages';
import { registryService } from '@/frontend/services/registry';
import { createLogger } from '@/utils/logger';

const log = createLogger('frontend/components/Packages/InstallPackageCard');

type RegistryPackageSummary = RegistryPackageSearchResult['items'][number];

/** Match the registry's `@publisher/package` display handle to the account handle. */
export function isPackageOwnedBy(
  pkg: Pick<RegistryPackageSummary, 'id' | 'handle'>,
  publisherHandle: string | null,
): boolean {
  const owner = publisherHandle?.trim().replace(/^@/, '').toLocaleLowerCase();
  if (!owner) return false;

  const displayHandle = pkg.handle?.trim().replace(/^@/, '');
  if (displayHandle) {
    return displayHandle.split('/')[0].toLocaleLowerCase() === owner;
  }

  const id = pkg.id.trim().replace(/^@/, '');
  return id.includes('/') && id.split('/')[0].toLocaleLowerCase() === owner;
}

/**
 * "Browse registry" card (issue #198 follow-up). Searches the hosted FLUJO
 * package registry (registry.flujo.com.co, #196) via GET /api/packages/search,
 * then installs the selected package through the existing two-phase
 * POST /api/packages/install flow: a dry-run preview (consentGranted: false)
 * shows exactly what will be created and which secrets are needed, then the
 * user confirms and supplies secret values to install for real
 * (consentGranted: true).
 */
export default function InstallPackageCard({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryPackageSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [publisherHandle, setPublisherHandle] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RegistryPackageSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [selected, setSelected] = useState<RegistryPackageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<InstallSummary | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [modelMappings, setModelMappings] = useState<Record<string, string>>({});
  const [result, setResult] = useState<InstallSummary | null>(null);
  const [visibleSecrets, setVisibleSecrets] = useState<Record<string, boolean>>({});


  const runSearch = useCallback(async (q: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      const data = await packageService.searchRegistry({ q: q.trim() || undefined, pageSize: 24 });
      setResults(data.items ?? []);
      setSearched(true);
    } catch (err) {
      log.warn('Failed to search package registry', err);
      setSearchError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    void runSearch('');
    void registryService.getStatus()
      .then((status) => setPublisherHandle(status.signedIn ? status.publisherHandle : null))
      .catch((err) => log.debug('Registry account status unavailable', err));
  }, [runSearch]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const deletion = await registryService.deletePackage(deleteTarget.id);
      if (!deletion.ok) {
        setDeleteError(deletion.error || 'Failed to delete package.');
        return;
      }
      setResults((current) => current.filter((pkg) => pkg.id !== deleteTarget.id));
      setDeleteTarget(null);
      await runSearch(query);
    } catch (err) {
      log.warn('Package deletion failed', err);
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, query, runSearch]);

  const openPackage = useCallback(async (pkg: RegistryPackageSummary) => {
    setSelected(pkg);
    setPreview(null);
    setResult(null);
    setSecretValues({});
    setModelMappings({});
    setVisibleSecrets({});
    setError(null);
    setLoading(true);
    try {
      const summary = await packageService.installFromRegistry({
        packageId: pkg.id,
        version: pkg.latestVersion,
        consentGranted: false,
      });
      if (!summary.ok) {
        setError(summary.errors?.[0] || 'Failed to fetch package preview.');
        return;
      }
      setPreview(summary);
    } catch (err) {
      log.warn('Failed to fetch package preview', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!selected || !preview) return;
    setLoading(true);
    setError(null);
    try {
      const summary = await packageService.installFromRegistry({
        packageId: selected.id,
        version: selected.latestVersion,
        secrets: secretValues,
        modelMappings: Object.fromEntries(Object.entries(modelMappings).filter(([, id]) => id !== '')),
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
  }, [selected, preview, secretValues, modelMappings, onInstalled]);

  const closeDialog = useCallback(() => {
    setSelected(null);
    setPreview(null);
    setResult(null);
    setSecretValues({});
    setModelMappings({});
    setVisibleSecrets({});
    setError(null);
  }, []);

  const manifest = preview?.preview;

  return (
    <Box sx={{ maxWidth: { xs: '100%', md: 1100 }, mx: 'auto', mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <CloudDownloadOutlinedIcon color="action" />
        <Typography variant="h6">Browse registry</Typography>
      </Stack>

      <TextField
        size="small"
        fullWidth
        placeholder="Search published packages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void runSearch(query);
        }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
          endAdornment: searching ? (
            <InputAdornment position="end">
              <CircularProgress size={16} />
            </InputAdornment>
          ) : undefined,
        }}
        sx={{ mb: 2 }}
      />

      {searchError && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setSearchError(null)}>
          {searchError}
        </Alert>
      )}

      {searched && !searching && results.length === 0 && !searchError && (
        <Typography variant="body2" color="text.secondary">
          No packages match “{query}”.
        </Typography>
      )}

      <Grid container spacing={2}>
        {results.map((pkg) => (
          <Grid item xs={12} sm={6} md={4} key={pkg.id}>
            <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardActionArea onClick={() => void openPackage(pkg)} sx={{ flex: 1 }}>
                <CardContent>
                  <Stack direction="row" spacing={1} alignItems="baseline" justifyContent="space-between">
                    <Typography variant="subtitle1" noWrap>{pkg.name}</Typography>
                    <Chip size="small" variant="outlined" label={`v${pkg.latestVersion}`} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {pkg.handle}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, minHeight: '2.5em' }}>
                    {pkg.description || 'No description provided.'}
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                    {pkg.tags.map((t) => (
                      <Chip key={t} size="small" label={t} />
                    ))}
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
                    <DownloadIcon fontSize="inherit" color="disabled" />
                    <Typography variant="caption" color="text.secondary">{pkg.downloads}</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
              {isPackageOwnedBy(pkg, publisherHandle) && (
                <CardActions sx={{ justifyContent: 'flex-end', pt: 0 }}>
                  <IconButton
                    size="small"
                    color="error"
                    aria-label={`Delete ${pkg.name}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteTarget(pkg);
                    }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </CardActions>
              )}
            </Card>
          </Grid>
        ))}
      </Grid>

      <Dialog
        open={deleteTarget !== null}
        onClose={deleting ? undefined : () => setDeleteTarget(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete package?</DialogTitle>
        <DialogContent>
          {deleteError && <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert>}
          <Typography variant="body2">
            This permanently deletes <strong>{deleteTarget?.name}</strong> and all of its published
            versions from the registry. This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmDelete()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            Delete package
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={selected !== null} onClose={loading ? undefined : closeDialog} maxWidth="sm" fullWidth>
        <DialogTitle>{selected?.name}</DialogTitle>
        <DialogContent>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

          {loading && !preview && !result && (
            <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {manifest && preview?.package && (
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip size="small" variant="outlined" label={`v${preview.package.version}`} />
                {preview.package.publisher && (
                  <Chip size="small" variant="outlined" label={preview.package.publisher} />
                )}
              </Stack>

              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                {manifest.servers.length} MCP server(s) · {manifest.models.length} model(s) ·{' '}
                {manifest.flows.length} flow(s) · {manifest.plannedExecutions.length} planned execution(s)
              </Typography>

              {manifest.servers.some((s) => s.requiredEnvMissing.length > 0) && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  Some MCP servers require environment values that aren&apos;t covered by a secret
                  below — those servers will install disabled.
                </Alert>
              )}

              {manifest.missingGlobals.length > 0 && (
                <Alert severity="warning" sx={{ mt: 1 }}>
                  This package expects host global variable(s) that aren&apos;t set yet:{' '}
                  {manifest.missingGlobals.join(', ')}. Set them in Settings after install, or the
                  bound model(s)/server(s) won&apos;t have a working API key.
                </Alert>
              )}

              <Divider sx={{ my: 2 }} />

              {manifest.models.length > 0 && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                    Model substitutions
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                    Install each package model as new, or bind its flow nodes to a model already installed here.
                  </Typography>
                  <Stack spacing={1.5}>
                    {manifest.models.map((model) => (
                      <FormControl key={model.id} size="small" fullWidth>
                        <InputLabel id={`model-mapping-${model.id}`}>{model.displayName}</InputLabel>
                        <Select
                          labelId={`model-mapping-${model.id}`}
                          label={model.displayName}
                          value={modelMappings[model.id] ?? ''}
                          onChange={(e) => setModelMappings((prev) => ({ ...prev, [model.id]: e.target.value }))}
                        >
                          <MenuItem value="">Install as new</MenuItem>
                          {manifest.installedModels.map((installed) => (
                            <MenuItem key={installed.id} value={installed.id}>
                              {installed.displayName}
                            </MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                    ))}
                  </Stack>
                </Box>
              )}

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
                        type={visibleSecrets[s.key] ? 'text' : 'password'}
                        label={s.label || s.key}
                        helperText={
                          s.required
                            ? 'Required — leave blank to install the dependent entity disabled'
                            : 'Optional'
                        }
                        value={secretValues[s.key] ?? ''}
                        onChange={(e) => setSecretValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                        fullWidth
                        InputProps={{
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton
                                size="small"
                                tabIndex={-1}
                                aria-label={visibleSecrets[s.key] ? 'Hide secret' : 'Show secret'}
                                onClick={() =>
                                  setVisibleSecrets((prev) => ({ ...prev, [s.key]: !prev[s.key] }))
                                }
                              >
                                {visibleSecrets[s.key] ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                              </IconButton>
                            </InputAdornment>
                          ),
                        }}
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
                <Button onClick={closeDialog} disabled={loading}>
                  Cancel
                </Button>
              </Stack>
            </Box>
          )}

          {result && (
            <Box>
              <Alert severity={result.ok ? 'success' : 'error'} sx={{ mb: 1 }}>
                {result.ok
                  ? `Installed "${result.package?.name}": ${result.created.length} created, ${result.updated.length} updated, ${result.disabled.length} disabled.`
                  : `Install failed: ${result.errors[0] ?? 'unknown error'}`}
              </Alert>
              {result.missingGlobals.length > 0 && (
                <Alert severity="warning" sx={{ mb: 1 }}>
                  Set these global variable(s) in Settings for the installed entities to work:{' '}
                  {result.missingGlobals.join(', ')}.
                </Alert>
              )}
              <Button size="small" onClick={closeDialog}>
                Close
              </Button>
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
