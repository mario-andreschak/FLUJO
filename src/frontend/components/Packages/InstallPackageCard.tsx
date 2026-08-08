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
  Grid,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PackageInstallWizard from '@/frontend/components/Packages/PackageInstallWizard';
import { packageService, type RegistryPackageSearchResult } from '@/frontend/services/packages';
import { registryService } from '@/frontend/services/registry';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';

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
 * package registry (registry.flujo.com.co, #196) via GET /api/packages/search
 * and hands the selected package to the install wizard
 * (`PackageInstallWizard`, issue #407), which owns the whole
 * preview -> inspect -> rename -> secrets -> install journey. This card is
 * therefore only responsible for discovery, ownership and deletion.
 */
export default function InstallPackageCard({ onInstalled }: { onInstalled?: () => void }) {
  const { t, formatNumber } = useI18n();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RegistryPackageSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [publisherHandle, setPublisherHandle] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RegistryPackageSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  /** The package the install wizard is currently open for. */
  const [selected, setSelected] = useState<RegistryPackageSummary | null>(null);

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
        setDeleteError(deletion.error || t('packages.browse.deleteFailed'));
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
  }, [deleteTarget, query, runSearch, t]);

  return (
    <Box sx={{ maxWidth: { xs: '100%', md: 1100 }, mx: 'auto', mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <CloudDownloadOutlinedIcon color="action" />
        <Typography variant="h6">{t('packages.browse.title')}</Typography>
      </Stack>

      <TextField
        size="small"
        fullWidth
        placeholder={t('packages.browse.search')}
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
          {t('packages.browse.noMatches', { search: query })}
        </Typography>
      )}

      <Grid container spacing={2}>
        {results.map((pkg) => (
          <Grid item xs={12} sm={6} md={4} key={pkg.id}>
            <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardActionArea onClick={() => setSelected(pkg)} sx={{ flex: 1 }}>
                <CardContent>
                  <Stack direction="row" spacing={1} alignItems="baseline" justifyContent="space-between">
                    <Typography variant="subtitle1" noWrap>{pkg.name}</Typography>
                    <Chip size="small" variant="outlined" label={`v${pkg.latestVersion}`} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {pkg.handle}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, minHeight: '2.5em' }}>
                    {pkg.description || t('packages.browse.noDescription')}
                  </Typography>
                  <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
                    {pkg.tags.map((tag) => (
                      <Chip key={tag} size="small" label={tag} />
                    ))}
                  </Stack>
                  <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 1 }}>
                    <DownloadIcon fontSize="inherit" color="disabled" />
                    <Typography variant="caption" color="text.secondary">{formatNumber(pkg.downloads)}</Typography>
                  </Stack>
                </CardContent>
              </CardActionArea>
              {isPackageOwnedBy(pkg, publisherHandle) && (
                <CardActions sx={{ justifyContent: 'flex-end', pt: 0 }}>
                  <IconButton
                    size="small"
                    color="error"
                    aria-label={t('packages.browse.deleteAria', { name: pkg.name })}
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
        <DialogTitle>{t('packages.browse.deleteTitle')}</DialogTitle>
        <DialogContent>
          {deleteError && <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert>}
          <Typography variant="body2">
            <Trans
              message="packages.browse.deleteHelp"
              values={{ name: <strong>{deleteTarget?.name}</strong> }}
            />
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>{t('packages.browse.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => void confirmDelete()}
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlineIcon />}
          >
            {t('packages.browse.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {selected && (
        <PackageInstallWizard
          open
          packageId={selected.id}
          packageName={selected.name}
          version={selected.latestVersion}
          onClose={() => setSelected(null)}
          onInstalled={() => onInstalled?.()}
        />
      )}
    </Box>
  );
}
