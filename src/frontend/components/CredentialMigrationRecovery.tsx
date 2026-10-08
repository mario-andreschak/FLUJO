"use client";

import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

export default function CredentialMigrationRecovery({ workspace, onSettled }: {
  workspace: string; onSettled: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [passphrase, setPassphrase] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    ++generation.current;
    setPassphrase(''); setConfirmed(false); setFailed(false); setBusy(false);
    return () => { ++generation.current; controller.current?.abort(); controller.current = null; };
  }, [workspace]);
  const recover = async (action: 'resume' | 'rollback') => {
    if (controller.current || !confirmed || passphrase.length < 16) return;
    const request = new AbortController();
    controller.current = request;
    const captured = generation.current;
    setBusy(true); setFailed(false);
    try {
      const response = await fetch(withWorkspaceUrl('/api/credential-migration', workspace), {
        method: 'POST', cache: 'no-store', signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, recoveryPassphrase: passphrase, confirmMigration: true }),
      });
      const result = await response.json();
      if (!response.ok || result.status !== (action === 'resume' ? 'committed' : 'rolled-back')) {
        throw new Error('Recovery unavailable');
      }
    } catch {
      if (captured === generation.current) setFailed(true);
    } finally {
      if (captured === generation.current) {
        setPassphrase(''); setConfirmed(false); setBusy(false); controller.current = null;
        // Cancellation can leave durable pending writes. Always reread server state;
        // recovery itself never proves the encryption session is unlocked.
        await onSettled();
      }
    }
  };
  const cancel = () => {
    setPassphrase(''); setConfirmed(false);
    controller.current?.abort();
  };
  return <Stack spacing={2}>
    <Alert severity="warning">{t('encryption.recovery.help')}</Alert>
    {failed && <Alert severity="error">{t('encryption.recovery.failed')}</Alert>}
    <TextField autoFocus type="password" autoComplete="new-password" disabled={busy}
      label={t('encryption.recovery.passphrase')} value={passphrase}
      onChange={event => setPassphrase(event.target.value)} />
    <FormControlLabel control={<Checkbox checked={confirmed} disabled={busy}
      onChange={event => setConfirmed(event.target.checked)} />} label={t('encryption.recovery.confirm')} />
    <Typography>{t('encryption.recovery.rollbackHelp')}</Typography>
    <Stack direction="row" spacing={1}>
      <Button disabled={busy || !confirmed || passphrase.length < 16} onClick={() => void recover('resume')}>
        {t('encryption.recovery.resume')}</Button>
      <Button disabled={busy || !confirmed || passphrase.length < 16} onClick={() => void recover('rollback')}>
        {t('encryption.recovery.rollback')}</Button>
      {busy && <Button onClick={cancel}>{t('encryption.recovery.cancel')}</Button>}
    </Stack>
  </Stack>;
}
