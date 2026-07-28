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
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { createLogger } from '@/utils/logger';

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
  const [packages, setPackages] = useState<InstalledPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<InstalledPackage | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<UninstallSummary | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/packages/installed');
      if (!res.ok) throw new Error(`Failed to load installed packages (${res.status})`);
      const data = (await res.json()) as { packages: InstalledPackage[] };
      setPackages(data.packages ?? []);
    } catch (err) {
      log.warn('Failed to load installed packages', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const uninstall = useCallback(async (pkg: InstalledPackage) => {
    setBusy(true);
    setLastResult(null);
    try {
      const res = await fetch('/api/packages/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ packageName: pkg.packageName }),
      });
      const summary = (await res.json()) as UninstallSummary;
      if (!res.ok) {
        throw new Error((summary as unknown as { error?: string }).error ?? `Uninstall failed (${res.status})`);
      }
      setLastResult(summary);
      await load();
    } catch (err) {
      log.warn('Uninstall failed', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setConfirmTarget(null);
    }
  }, [load]);

  const filteredPackages = useMemo(() => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return packages;
    return packages.filter((p) =>
      `${p.packageName} ${p.version}`.toLowerCase().includes(q),
    );
  }, [packages, searchTerm]);

  return (
    <Box sx={{ maxWidth: { xs: '100%', md: 1100 }, mx: 'auto', mt: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="h6">Installed packages</Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => void load()} disabled={loading}>
          Refresh
        </Button>
      </Stack>

      {packages.length > 0 && (
        <TextField
          size="small"
          fullWidth
          placeholder="Search installed packages…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ mb: 2 }}
        />
      )}

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {lastResult && (
        <Alert severity={lastResult.hasErrors ? 'warning' : 'success'} sx={{ mb: 2 }} onClose={() => setLastResult(null)}>
          Uninstalled &quot;{lastResult.packageName}&quot;: {lastResult.removed.length} removed,{' '}
          {lastResult.skipped.length} preserved/skipped
          {lastResult.hasErrors ? `, ${lastResult.errors.length} error(s)` : ''}.
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
          <CircularProgress size={24} />
        </Box>
      ) : packages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No packages installed yet.
        </Typography>
      ) : filteredPackages.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No packages match “{searchTerm}”.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {filteredPackages.map((pkg) => (
            <Paper key={pkg.packageName} variant="outlined" sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Box>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="subtitle1">{pkg.packageName}</Typography>
                  <Chip label={`v${pkg.version}`} size="small" variant="outlined" />
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  {pkg.entityCounts.flows} flows · {pkg.entityCounts.models} models ·{' '}
                  {pkg.entityCounts.servers} servers · {pkg.entityCounts.plannedExecutions} planned ·
                  installed {new Date(pkg.installedAt).toLocaleString()}
                </Typography>
              </Box>
              <Button
                color="error"
                size="small"
                startIcon={<DeleteOutlineIcon />}
                onClick={() => setConfirmTarget(pkg)}
                disabled={busy}
              >
                Uninstall
              </Button>
            </Paper>
          ))}
        </Stack>
      )}

      <Dialog open={confirmTarget !== null} onClose={() => (busy ? undefined : setConfirmTarget(null))}>
        <DialogTitle>Uninstall &quot;{confirmTarget?.packageName}&quot;?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes the flows, models, MCP servers and planned executions this package
            <strong> created</strong>. Pre-existing entities the package merely updated in place are
            preserved. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmTarget(null)} disabled={busy}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => confirmTarget && void uninstall(confirmTarget)}
            disabled={busy}
            startIcon={busy ? <CircularProgress size={16} /> : <DeleteOutlineIcon />}
          >
            Uninstall
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
