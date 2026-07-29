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
  Step,
  StepLabel,
  Stepper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddCircleOutlineRoundedIcon from '@mui/icons-material/AddCircleOutlineRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import SearchIcon from '@mui/icons-material/Search';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
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
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [showInstalledModels, setShowInstalledModels] = useState(false);
  const [installStep, setInstallStep] = useState(0);
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
    setActiveModelId(null);
    setShowInstalledModels(false);
    setInstallStep(0);
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
      const firstPackageModel = summary.preview?.models[0];
      setActiveModelId(firstPackageModel?.id ?? null);
      setInstallStep(firstPackageModel ? 0 : 1);
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
    setActiveModelId(null);
    setShowInstalledModels(false);
    setInstallStep(0);
    setVisibleSecrets({});
    setError(null);
  }, []);

  const manifest = preview?.preview;
  const activeModel = manifest?.models.find((model) => model.id === activeModelId) ?? manifest?.models[0];
  const resolvedModelCount = manifest?.models.filter((model) =>
    Object.prototype.hasOwnProperty.call(modelMappings, model.id),
  ).length ?? 0;
  const allModelsResolved = manifest?.models.every((model) =>
    Object.prototype.hasOwnProperty.call(modelMappings, model.id),
  ) ?? true;

  const choosePackageModel = useCallback((modelId: string) => {
    setActiveModelId(modelId);
    setShowInstalledModels(Boolean(modelMappings[modelId]));
  }, [modelMappings]);

  const resolveAsNewModel = useCallback((modelId: string) => {
    setModelMappings((current) => ({ ...current, [modelId]: '' }));
    setShowInstalledModels(false);
  }, []);

  const resolveWithInstalledModel = useCallback((modelId: string, installedModelId: string) => {
    setModelMappings((current) => ({ ...current, [modelId]: installedModelId }));
  }, []);

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

      <Dialog
        open={selected !== null}
        onClose={loading ? undefined : closeDialog}
        maxWidth={false}
        fullWidth
        PaperProps={{
          sx: {
            width: 'min(1400px, calc(100vw - 32px))',
            maxWidth: 'none',
            minHeight: { xs: 'calc(100vh - 32px)', md: 760 },
            maxHeight: 'calc(100vh - 32px)',
            borderRadius: { xs: 2, md: 3 },
          },
        }}
      >
        <DialogTitle sx={{ px: { xs: 2, md: 4 }, pt: { xs: 2, md: 3 }, pb: 1 }}>
          <Typography component="span" variant="h5" fontWeight={700}>
            Install {selected?.name}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Match the package to your FLUJO, then review and install it.
          </Typography>
        </DialogTitle>
        <DialogContent sx={{ px: { xs: 2, md: 4 }, pb: 3 }}>
          {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

          {loading && !preview && !result && (
            <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 420 }}>
              <CircularProgress size={24} />
            </Box>
          )}

          {manifest && preview?.package && (
            <Box>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={1}
                alignItems={{ sm: 'center' }}
                justifyContent="space-between"
                sx={{ mb: 2.5 }}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" variant="outlined" label={`v${preview.package.version}`} />
                  {preview.package.publisher && (
                    <Chip size="small" variant="outlined" label={preview.package.publisher} />
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {manifest.servers.length} server(s) · {manifest.models.length} model(s) ·{' '}
                    {manifest.flows.length} flow(s) · {manifest.plannedExecutions.length} planned execution(s)
                  </Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Step {installStep + 1} of 2
                </Typography>
              </Stack>

              <Stepper activeStep={installStep} sx={{ maxWidth: 720, mx: 'auto', mb: 3 }}>
                <Step>
                  <StepLabel>Match models</StepLabel>
                </Step>
                <Step>
                  <StepLabel>Review &amp; install</StepLabel>
                </Step>
              </Stepper>

              {installStep === 0 && manifest.models.length > 0 && activeModel && (
                <Box>
                  <Box sx={{ textAlign: 'center', maxWidth: 820, mx: 'auto', mb: 3 }}>
                    <Typography variant="h4" fontWeight={750} sx={{ mb: 1 }}>
                      The package was created with models that are not installed in your FLUJO.
                    </Typography>
                    <Typography variant="h6" color="text.secondary" fontWeight={400}>
                      Let&apos;s replace or recreate them!
                    </Typography>
                  </Box>

                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: {
                        xs: 'minmax(0, 1fr)',
                        md: 'minmax(260px, 0.85fr) 88px minmax(420px, 1.35fr)',
                      },
                      gap: { xs: 2, md: 2.5 },
                      alignItems: 'stretch',
                    }}
                  >
                    <Box>
                      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.25 }}>
                        <Typography variant="overline" color="text.secondary" fontWeight={700}>
                          Models in this package
                        </Typography>
                        <Chip
                          size="small"
                          color={allModelsResolved ? 'success' : 'default'}
                          label={`${resolvedModelCount}/${manifest.models.length} ready`}
                        />
                      </Stack>
                      <Stack spacing={1.25}>
                        {manifest.models.map((model) => {
                          const isSelected = model.id === activeModel.id;
                          const isResolved = Object.prototype.hasOwnProperty.call(modelMappings, model.id);
                          const installedChoice = manifest.installedModels.find(
                            (installed) => installed.id === modelMappings[model.id],
                          );
                          return (
                            <Card
                              key={model.id}
                              variant="outlined"
                              sx={{
                                borderWidth: isSelected ? 2 : 1,
                                borderColor: isSelected ? 'primary.main' : 'divider',
                                bgcolor: isSelected ? 'action.selected' : 'background.paper',
                                transition: 'border-color 120ms ease, background-color 120ms ease',
                              }}
                            >
                              <CardActionArea
                                onClick={() => choosePackageModel(model.id)}
                                aria-label={`Configure ${model.displayName}`}
                                sx={{ minHeight: 104, p: 2 }}
                              >
                                <Stack direction="row" spacing={1.5} alignItems="center">
                                  <Box
                                    sx={{
                                      width: 44,
                                      height: 44,
                                      borderRadius: 2,
                                      display: 'grid',
                                      placeItems: 'center',
                                      bgcolor: isSelected ? 'primary.main' : 'action.hover',
                                      color: isSelected ? 'primary.contrastText' : 'text.secondary',
                                      flex: '0 0 auto',
                                    }}
                                  >
                                    <SmartToyOutlinedIcon />
                                  </Box>
                                  <Box sx={{ minWidth: 0, flex: 1 }}>
                                    <Typography variant="subtitle1" fontWeight={700} noWrap>
                                      {model.displayName}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" display="block">
                                      Package model
                                    </Typography>
                                    {isResolved && (
                                      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.5 }}>
                                        <CheckCircleRoundedIcon color="success" sx={{ fontSize: 16 }} />
                                        <Typography variant="caption" color="success.main" noWrap>
                                          {installedChoice
                                            ? `Using ${installedChoice.displayName}`
                                            : 'Will be created'}
                                        </Typography>
                                      </Stack>
                                    )}
                                  </Box>
                                </Stack>
                              </CardActionArea>
                            </Card>
                          );
                        })}
                      </Stack>
                    </Box>

                    <Box
                      aria-hidden
                      sx={{
                        display: 'grid',
                        placeItems: 'center',
                        minHeight: { xs: 64, md: 360 },
                      }}
                    >
                      <Box
                        sx={{
                          width: 64,
                          height: 64,
                          borderRadius: '50%',
                          display: 'grid',
                          placeItems: 'center',
                          bgcolor: 'primary.main',
                          color: 'primary.contrastText',
                          boxShadow: 3,
                          transform: { xs: 'rotate(90deg)', md: 'none' },
                        }}
                      >
                        <ArrowForwardRoundedIcon sx={{ fontSize: 38 }} />
                      </Box>
                    </Box>

                    <Card
                      variant="outlined"
                      sx={{
                        p: { xs: 2, md: 3 },
                        minHeight: { md: 420 },
                        bgcolor: 'background.default',
                      }}
                    >
                      <Typography variant="overline" color="text.secondary" fontWeight={700}>
                        Replace {activeModel.displayName}
                      </Typography>
                      <Typography variant="h5" fontWeight={700} sx={{ mt: 0.25, mb: 2.5 }}>
                        What would you like to do?
                      </Typography>

                      <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                          <Button
                            fullWidth
                            aria-label="Create new one"
                            variant={
                              Object.prototype.hasOwnProperty.call(modelMappings, activeModel.id)
                                && modelMappings[activeModel.id] === ''
                                ? 'contained'
                                : 'outlined'
                            }
                            onClick={() => resolveAsNewModel(activeModel.id)}
                            sx={{
                              minHeight: 154,
                              p: 2.5,
                              textTransform: 'none',
                              alignItems: 'stretch',
                              justifyContent: 'flex-start',
                              textAlign: 'left',
                            }}
                          >
                            <Stack spacing={1} alignItems="flex-start">
                              <AddCircleOutlineRoundedIcon sx={{ fontSize: 36 }} />
                              <Typography variant="h6" fontWeight={700}>Create new one</Typography>
                              <Typography
                                variant="body2"
                                color={
                                  Object.prototype.hasOwnProperty.call(modelMappings, activeModel.id)
                                    && modelMappings[activeModel.id] === ''
                                    ? 'inherit'
                                    : 'text.secondary'
                                }
                              >
                                Recreate this model in your FLUJO with the package&apos;s configuration.
                              </Typography>
                            </Stack>
                          </Button>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                          <Button
                            fullWidth
                            aria-label="Use one of yours"
                            variant={modelMappings[activeModel.id] ? 'contained' : 'outlined'}
                            onClick={() => setShowInstalledModels(true)}
                            sx={{
                              minHeight: 154,
                              p: 2.5,
                              textTransform: 'none',
                              alignItems: 'stretch',
                              justifyContent: 'flex-start',
                              textAlign: 'left',
                            }}
                          >
                            <Stack spacing={1} alignItems="flex-start">
                              <SmartToyOutlinedIcon sx={{ fontSize: 36 }} />
                              <Typography variant="h6" fontWeight={700}>Use one of yours</Typography>
                              <Typography
                                variant="body2"
                                color={modelMappings[activeModel.id] ? 'inherit' : 'text.secondary'}
                              >
                                Connect the package to a model you already have installed.
                              </Typography>
                            </Stack>
                          </Button>
                        </Grid>
                      </Grid>

                      {showInstalledModels && (
                        <Box sx={{ mt: 2.5 }}>
                          <Divider sx={{ mb: 2 }} />
                          <Typography variant="subtitle1" fontWeight={700} sx={{ mb: 1 }}>
                            Choose one of your installed models
                          </Typography>
                          {manifest.installedModels.length > 0 ? (
                            <Grid container spacing={1.25}>
                              {manifest.installedModels.map((installed) => {
                                const isMapped = modelMappings[activeModel.id] === installed.id;
                                return (
                                  <Grid item xs={12} sm={6} key={installed.id}>
                                    <Card
                                      variant="outlined"
                                      sx={{
                                        height: '100%',
                                        borderWidth: isMapped ? 2 : 1,
                                        borderColor: isMapped ? 'primary.main' : 'divider',
                                        bgcolor: isMapped ? 'action.selected' : 'background.paper',
                                      }}
                                    >
                                      <CardActionArea
                                        onClick={() => resolveWithInstalledModel(activeModel.id, installed.id)}
                                        aria-label={`Use ${installed.displayName}`}
                                        sx={{ minHeight: 76, p: 1.5 }}
                                      >
                                        <Stack direction="row" spacing={1.25} alignItems="center">
                                          <SmartToyOutlinedIcon color={isMapped ? 'primary' : 'action'} />
                                          <Box sx={{ minWidth: 0 }}>
                                            <Typography variant="subtitle2" fontWeight={700} noWrap>
                                              {installed.displayName}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary" noWrap display="block">
                                              {installed.name}
                                            </Typography>
                                          </Box>
                                          {isMapped && (
                                            <CheckCircleRoundedIcon
                                              color="primary"
                                              sx={{ ml: 'auto !important', flex: '0 0 auto' }}
                                            />
                                          )}
                                        </Stack>
                                      </CardActionArea>
                                    </Card>
                                  </Grid>
                                );
                              })}
                            </Grid>
                          ) : (
                            <Alert severity="info">
                              You do not have any installed models yet. Create this package model as new instead.
                            </Alert>
                          )}
                        </Box>
                      )}
                    </Card>
                  </Box>

                  <Divider sx={{ my: 3 }} />
                  <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="center">
                    <Button onClick={closeDialog}>Cancel</Button>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      {!allModelsResolved && (
                        <Typography variant="body2" color="text.secondary">
                          Choose an option for every model to continue.
                        </Typography>
                      )}
                      <Button
                        variant="contained"
                        size="large"
                        disabled={!allModelsResolved}
                        endIcon={<ArrowForwardRoundedIcon />}
                        onClick={() => setInstallStep(1)}
                      >
                        Continue to review
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
              )}

              {installStep === 1 && (
                <Box sx={{ maxWidth: 980, mx: 'auto' }}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                    alignItems={{ sm: 'center' }}
                    justifyContent="space-between"
                    sx={{ mb: 2 }}
                  >
                    <Box>
                      <Typography variant="h4" fontWeight={750}>
                        Review and install
                      </Typography>
                      <Typography variant="body1" color="text.secondary">
                        Check your model choices and add any package secrets.
                      </Typography>
                    </Box>
                    {manifest.models.length > 0 && (
                      <Button
                        onClick={() => {
                          setInstallStep(0);
                          setActiveModelId(
                            manifest.models.find((model) =>
                              !Object.prototype.hasOwnProperty.call(modelMappings, model.id),
                            )?.id ?? manifest.models[0].id,
                          );
                          setShowInstalledModels(false);
                        }}
                      >
                        Change model choices
                      </Button>
                    )}
                  </Stack>

                  {manifest.models.length > 0 && (
                    <Box sx={{ mb: 2.5 }}>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Model plan
                      </Typography>
                      <Grid container spacing={1.5}>
                        {manifest.models.map((model) => {
                          const installedChoice = manifest.installedModels.find(
                            (installed) => installed.id === modelMappings[model.id],
                          );
                          return (
                            <Grid item xs={12} sm={6} key={model.id}>
                              <Card variant="outlined" sx={{ p: 1.75, height: '100%' }}>
                                <Stack direction="row" spacing={1.25} alignItems="center">
                                  <Box sx={{ minWidth: 0, flex: 1 }}>
                                    <Typography variant="caption" color="text.secondary">Package model</Typography>
                                    <Typography variant="subtitle2" noWrap>{model.displayName}</Typography>
                                  </Box>
                                  <ArrowForwardRoundedIcon color="action" />
                                  <Box sx={{ minWidth: 0, flex: 1 }}>
                                    <Typography variant="caption" color="text.secondary">
                                      {installedChoice ? 'Your model' : 'New model'}
                                    </Typography>
                                    <Typography variant="subtitle2" noWrap>
                                      {installedChoice?.displayName ?? model.displayName}
                                    </Typography>
                                  </Box>
                                </Stack>
                              </Card>
                            </Grid>
                          );
                        })}
                      </Grid>
                    </Box>
                  )}

                  {manifest.servers.some((s) => s.requiredEnvMissing.length > 0) && (
                    <Alert severity="warning" sx={{ mb: 1.5 }}>
                      Some MCP servers require environment values that aren&apos;t covered by a secret
                      below — those servers will install disabled.
                    </Alert>
                  )}

                  {manifest.missingGlobals.length > 0 && (
                    <Alert severity="warning" sx={{ mb: 1.5 }}>
                      This package expects host global variable(s) that aren&apos;t set yet:{' '}
                      {manifest.missingGlobals.join(', ')}. Set them in Settings after install, or the
                      bound model(s)/server(s) won&apos;t have a working API key.
                    </Alert>
                  )}

                  <Divider sx={{ my: 2.5 }} />

                  {manifest.secrets.length > 0 ? (
                    <>
                      <Typography variant="subtitle2" sx={{ mb: 1 }}>
                        Secrets requested by this package
                      </Typography>
                      <Stack spacing={1.5} sx={{ mb: 2.5 }}>
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
                                    {visibleSecrets[s.key]
                                      ? <VisibilityOff fontSize="small" />
                                      : <Visibility fontSize="small" />}
                                  </IconButton>
                                </InputAdornment>
                              ),
                            }}
                          />
                        ))}
                      </Stack>
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
                      This package doesn&apos;t request any secrets.
                    </Typography>
                  )}

                  <Stack direction="row" spacing={1} justifyContent="space-between">
                    <Button
                      onClick={manifest.models.length > 0 ? () => setInstallStep(0) : closeDialog}
                      disabled={loading}
                    >
                      {manifest.models.length > 0 ? 'Back' : 'Cancel'}
                    </Button>
                    <Button
                      variant="contained"
                      color="primary"
                      size="large"
                      onClick={() => void install()}
                      disabled={loading}
                      startIcon={loading ? <CircularProgress size={16} /> : <CloudDownloadOutlinedIcon />}
                    >
                      Install package
                    </Button>
                  </Stack>
                </Box>
              )}
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
