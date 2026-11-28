'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import Trans from '@/frontend/components/shared/Trans';
import PackageUninstallDialog from './PackageUninstallDialog';
import { flowService } from '@/frontend/services/flow';
import { mcpService } from '@/frontend/services/mcp';
import type { Flow } from '@/frontend/types/flow/flow';
import type { McpServerChoice } from '@/frontend/components/mcp/MCPServerManager/McpServerDeleteDialog';
import {
  PACKAGE_IN_USE_CODE,
  type PackageInUseResponse,
  type PackageUninstallPlan,
  type PackageUsage,
} from '@/shared/types/package/uninstall';

const log = createLogger('frontend/components/Packages/InstalledPackagesList');

interface InstalledPackage {
  packageName: string;
  version: string;
  installedAt: string;
  entityCounts: { flows: number; models: number; servers: number; plannedExecutions: number };
}

interface EntityRef {
  kind: string;
  id: string;
  label?: string;
  reason?: string;
}

interface UninstallSummary {
  packageName: string;
  ok: boolean;
  hasErrors: boolean;
  removed: EntityRef[];
  skipped: EntityRef[];
  errors: EntityRef[];
}

/**
 * Installed-packages list (issue #211). Renders the install ledger and offers an
 * Uninstall action (with a confirm dialog) that reverses a package install,
 * deleting only entities the install created and preserving adopted ones.
 */
export default function InstalledPackagesList() {
  const { t, tp, formatDate, formatNumber } = useI18n();
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<InstalledPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<UninstallSummary | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  // #1389: agents or apps of the package that are still used outside it ask what each place uses instead.
  const [inUse, setInUse] = useState<{
    pkg: InstalledPackage;
    usage: PackageUsage;
    error: string | null;
    notice: string | null;
  } | null>(null);
  const [replacements, setReplacements] = useState<{ flows: Flow[]; servers: McpServerChoice[] }>({ flows: [], servers: [] });

  const loadReplacements = useCallback(async () => {
    const [flows, servers] = await Promise.all([
      flowService.loadFlows({ refresh: true }).catch(() => [] as Flow[]),
      mcpService.loadServerConfigs(),
    ]);
    setReplacements({
      flows,
      servers: Array.isArray(servers)
        ? servers.map((server: { name: string; disabled?: boolean }) => ({ name: server.name, disabled: server.disabled === true }))
        : [],
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/packages/installed');
      if (!res.ok) throw new Error(t('packages.installed.loadFailed', { status: res.status }));
      const data = (await res.json()) as { packages: InstalledPackage[] };
      setPackages(data.packages ?? []);
    } catch (err) {
      log.warn('Failed to load installed packages', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const uninstall = useCallback(async (pkg: InstalledPackage, plan?: PackageUninstallPlan) => {
    setBusy(true);
    setLastResult(null);
    try {
      const res = await fetch('/api/packages/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageName: pkg.packageName, ...(plan ? { plan } : {}) }),
      });
      const body = (await res.json()) as UninstallSummary & Partial<PackageInUseResponse> & { error?: string; removed?: EntityRef[] };
      if (res.status === 409 && body.code === PACKAGE_IN_USE_CODE && body.usage) {
        await loadReplacements();
        const removedFirst = body.removed?.length ?? 0;
        setInUse({
          pkg,
          usage: body.usage,
          error: null,
          notice: body.changed
            ? removedFirst > 0
              ? `${t('flows.delete.changed')} ${tp('packages.uninstall.removedFirst', removedFirst, { count: removedFirst })}`
              : t('flows.delete.changed')
            : null,
        });
        if (removedFirst > 0) await load();
        return;
      }
      if (!res.ok) {
        const message = body.error ?? t('packages.installed.uninstallFailed', { status: res.status });
        if (plan) {
          setInUse((current) => (current ? { ...current, error: message } : current));
          return;
        }
        throw new Error(message);
      }
      setInUse(null);
      setLastResult(body);
      await load();
    } catch (err) {
      log.warn('Uninstall failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmTarget(null);
    }
  }, [load, loadReplacements, t, tp]);

  const filteredPackages = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter((p) =>
      `${p.packageName} ${p.version}`.toLowerCase().includes(q),
    );
  }, [packages, searchTerm]);

  return (
    <Box sx={{ maxWidth: { xs: '100%', md: 1100 }, mx: 'auto', mt: 3 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center",  mb: 1 }}>
        <Typography variant="h6">{t('packages.installed.title')}</Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => void load()} disabled={loading}>
          {t('packages.installed.refresh')}
        </Button>
      </Stack>

      {packages.length > 0 && (
        <TextField
          size="small"
          fullWidth
          placeholder={t('packages.installed.search')}
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          slotProps={{ input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          } }}
          sx={{ mb: 2 }}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {lastResult && (
        <Alert severity={lastResult.hasErrors ? 'warning' : 'success'} sx={{ mb: 2 }} onClose={() => setLastResult(null)}>
          {t('packages.installed.result', {
            name: lastResult.packageName,
            removed: tp('packages.installed.removed', lastResult.removed.length),
            skipped: tp('packages.installed.skipped', lastResult.skipped.length),
            errors: lastResult.hasErrors
              ? tp('packages.installed.errors', lastResult.errors.length)
              : '',
          })}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : packages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('packages.installed.empty')}
        </Typography>
      ) : filteredPackages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('packages.installed.noMatches', { search: searchTerm })}
        </Typography>
      ) : (
        <Stack spacing={1}>
          {filteredPackages.map((pkg) => (
            <Paper key={pkg.packageName} variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Typography variant="subtitle1">{pkg.packageName}</Typography>
                  <Chip label={`v${pkg.version}`} size="small" variant="outlined" />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {tp('packages.installed.flows', pkg.entityCounts.flows, { count: formatNumber(pkg.entityCounts.flows) })}
                  {' · '}
                  {tp('packages.installed.models', pkg.entityCounts.models, { count: formatNumber(pkg.entityCounts.models) })}
                  {' · '}
                  {tp('packages.installed.servers', pkg.entityCounts.servers, { count: formatNumber(pkg.entityCounts.servers) })}
                  {' · '}
                  {tp('packages.installed.planned', pkg.entityCounts.plannedExecutions, { count: formatNumber(pkg.entityCounts.plannedExecutions) })}
                  {' · '}
                  {t('packages.installed.installedAt', { date: formatDate(pkg.installedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}
                </Typography>
              </Box>
              <Button
                color="error"
                size="small"
                startIcon={<DeleteOutlineIcon />}
                onClick={() => setConfirmTarget(pkg)}
                disabled={busy}
              >
                {t('packages.installed.uninstall')}
              </Button>
            </Paper>
          ))}
        </Stack>
      )}

      <PackageUninstallDialog
        usage={inUse?.usage ?? null}
        flows={replacements.flows}
        servers={replacements.servers}
        busy={busy}
        error={inUse?.error ?? null}
        notice={inUse?.notice ?? null}
        onCancel={() => setInUse(null)}
        onConfirm={(plan) => { if (inUse) void uninstall(inUse.pkg, plan); }}
      />

      <Dialog open={confirmTarget !== null} onClose={() => (busy ? undefined : setConfirmTarget(null))}>
        <DialogTitle>{t('packages.installed.confirmTitle', { name: confirmTarget?.packageName ?? '' })}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            <Trans
              message="packages.installed.confirmHelp"
              values={{ created: <strong>{t('packages.installed.created')}</strong> }}
            />
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmTarget(null)} disabled={busy}>{t('packages.installed.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => confirmTarget && void uninstall(confirmTarget)}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : <DeleteOutlineIcon />}
          >
            {t('packages.installed.uninstall')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
