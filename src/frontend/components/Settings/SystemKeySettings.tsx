'use client';

import { useState } from 'react';
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import type { TranslationKey } from '@/frontend/i18n';

export type SystemKeyStoreKind = 'windows' | 'macos' | 'linux';

/** The `systemKey` part of `POST /api/encryption/secure` `{ action: 'status' }` (#1443). */
export interface SystemKeyStatus {
  available: SystemKeyStoreKind | null;
  keptIn: SystemKeyStoreKind | null;
  recoveryKeySaved: boolean;
  problem: string | null;
}

const STORES: readonly SystemKeyStoreKind[] = ['windows', 'macos', 'linux'];

function storeKind(value: unknown): SystemKeyStoreKind | null {
  return STORES.includes(value as SystemKeyStoreKind) ? value as SystemKeyStoreKind : null;
}

export function parseSystemKeyStatus(value: unknown): SystemKeyStatus | null {
  if (!value || typeof value !== 'object') return null;
  const status = value as Record<string, unknown>;
  return {
    available: storeKind(status.available),
    keptIn: storeKind(status.keptIn),
    recoveryKeySaved: status.recoveryKeySaved === true,
    problem: typeof status.problem === 'string' && status.problem ? status.problem : null,
  };
}

export const STORE_NAME_KEYS: Readonly<Record<SystemKeyStoreKind, TranslationKey>> = {
  windows: 'settings.systemKey.store.windows',
  macos: 'settings.systemKey.store.macos',
  linux: 'settings.systemKey.store.linux',
};

function RecoveryKeyPanel({ store, saved }: { store: string; saved: boolean }) {
  const { t } = useI18n();
  const [workspace] = useState(getSelectedWorkspace);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ severity: 'error' | 'success'; key: TranslationKey } | null>(null);

  const send = async (action: 'reveal' | 'saved'): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(withWorkspaceUrl('/api/encryption/system-key', workspace), {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== 'object') throw new Error('refused');
      return body as Record<string, unknown>;
    } catch {
      setNotice({ severity: 'error', key: 'settings.systemKey.revealFailed' });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const reveal = async () => {
    if (recoveryKey) { setRecoveryKey(null); return; }
    const body = await send('reveal');
    if (typeof body?.recoveryKey === 'string') setRecoveryKey(body.recoveryKey);
  };

  const copy = async () => {
    if (!recoveryKey) return;
    await navigator.clipboard.writeText(recoveryKey);
    setNotice({ severity: 'success', key: 'settings.systemKey.copied' });
  };

  const download = () => {
    if (!recoveryKey) return;
    const text = `FLUJO recovery key\n\n${recoveryKey}\n\nKeep this private. It opens the saved keys of this FLUJO.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'flujo-recovery-key.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const markSaved = async () => {
    const body = await send('saved');
    if (body?.saved === true) { setIsSaved(true); setRecoveryKey(null); }
  };

  return (
    <Paper elevation={2} sx={{ p: 3, mb: 3 }}>
      <Typography variant="subtitle1" gutterBottom sx={{ fontWeight: 'bold' }}>{t('settings.systemKey.recoveryTitle')}</Typography>
      <Alert severity={isSaved ? 'info' : 'warning'} sx={{ mb: 2 }}>
        {t(isSaved ? 'settings.systemKey.recoverySaved' : 'settings.systemKey.recoveryNotSaved', { store })}
      </Alert>
      {recoveryKey && (
        <TextField
          fullWidth
          label={t('settings.systemKey.keyLabel')}
          value={recoveryKey}
          slotProps={{ input: { readOnly: true, sx: { fontFamily: 'monospace' } } }}
          sx={{ mb: 2 }}
        />
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <Button variant="outlined" disabled={busy} onClick={() => void reveal()}>
          {t(recoveryKey ? 'settings.systemKey.hide' : 'settings.systemKey.show')}
        </Button>
        {recoveryKey && <Button onClick={() => void copy()}>{t('settings.systemKey.copy')}</Button>}
        {recoveryKey && <Button onClick={download}>{t('settings.systemKey.download')}</Button>}
        {recoveryKey && !isSaved && (
          <Button variant="contained" disabled={busy} onClick={() => void markSaved()}>{t('settings.systemKey.markSaved')}</Button>
        )}
      </Stack>
      {notice && <Alert severity={notice.severity} sx={{ mt: 2 }} role={notice.severity === 'error' ? 'alert' : 'status'}>{t(notice.key)}</Alert>}
    </Paper>
  );
}

/**
 * Settings → Encryption: how the system key protects saved credentials (#1443),
 * the recovery key, and what to do when this computer offers no protected
 * store. Shows nothing for password or operator protection.
 */
export default function SystemKeySettings({ protection, locked, status }: {
  protection: string;
  locked: boolean;
  status: SystemKeyStatus | null;
}) {
  const { t } = useI18n();
  if (protection === 'os-store') {
    const store = t(STORE_NAME_KEYS[status?.keptIn ?? status?.available ?? 'windows']);
    return (
      <Box sx={{ mb: 3 }}>
        {locked ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {t('settings.systemKey.locked')} {status?.problem ?? ''}
          </Alert>
        ) : (
          <Alert severity="success" sx={{ mb: 2 }}>{t('settings.systemKey.help', { store })}</Alert>
        )}
        {!locked && <RecoveryKeyPanel store={store} saved={status?.recoveryKeySaved === true} />}
        <Typography variant="body2" color="text.secondary">{t('settings.systemKey.passwordInstead')}</Typography>
      </Box>
    );
  }
  if (protection !== 'legacy-default' && protection !== 'uninitialized') return null;
  if (!status?.available) return <Alert severity="warning" sx={{ mb: 3 }}>{t('settings.systemKey.unavailableHere')}</Alert>;
  if (protection === 'uninitialized') return null;
  return <Alert severity="info" sx={{ mb: 3 }}>{t('settings.systemKey.movePending', { store: t(STORE_NAME_KEYS[status.available]) })}</Alert>;
}
