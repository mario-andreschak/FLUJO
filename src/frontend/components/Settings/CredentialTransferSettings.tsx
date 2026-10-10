"use client";

import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, FormControlLabel, Paper, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getSelectedWorkspace, isValidWorkspaceName, onWorkspaceChanged } from '@/frontend/utils/workspaceSelection';

export default function CredentialTransferSettings() {
  const { t } = useI18n();
  const [recipientPassphrase, setRecipientPassphrase] = useState('');
  const [localPassphrase, setLocalPassphrase] = useState('');
  const [destination, setDestination] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const clear = () => {
      generation.current++;
      requestRef.current?.abort();
      setRecipientPassphrase(''); setLocalPassphrase(''); setDestination('');
      setConfirmed(false); setFile(null); setBusy(false); setMessage(null);
      if (inputRef.current) inputRef.current.value = '';
    };
    const unsubscribe = onWorkspaceChanged(clear);
    return () => { unsubscribe(); generation.current++; requestRef.current?.abort(); };
  }, []);

  const run = async (restore: boolean) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const currentGeneration = ++generation.current;
    const workspace = getSelectedWorkspace();
    const current = () => generation.current === currentGeneration && getSelectedWorkspace() === workspace;
    setBusy(true); setMessage(null);
    try {
      let body: BodyInit;
      const headers: Record<string, string> = {};
      if (restore) {
        if (!file || !file.size || file.size > 32 * 1024 * 1024 + 56) throw new Error();
        const form = new FormData();
        form.set('file', file); form.set('recipientPassphrase', recipientPassphrase);
        form.set('localPassphrase', localPassphrase); form.set('workspace', destination);
        form.set('confirmCredentialTransfer', 'true'); body = form;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ recipientPassphrase, confirmCredentialTransfer: true });
      }
      const response = await fetch(`/api/credential-transfer${restore ? '/restore' : ''}?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST', headers, body, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error();
      if (restore) {
        const result = await response.json() as { workspace?: string };
        if (!result.workspace || !isValidWorkspaceName(result.workspace)) throw new Error();
        if (current()) setMessage({ error: false, text: t('settings.credentialTransfer.restored', { workspace: result.workspace }) });
      } else {
        const blob = await response.blob();
        if (!current()) return;
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url; anchor.download = 'flujo-credentials.flujo-transfer';
        document.body.appendChild(anchor);
        try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
      }
    } catch {
      if (current() && !controller.signal.aborted) setMessage({ error: true, text: t('settings.credentialTransfer.failed') });
    } finally {
      if (current()) { setBusy(false); setRecipientPassphrase(''); setLocalPassphrase(''); setConfirmed(false); }
    }
  };
  const ready = confirmed && recipientPassphrase.length >= 16 && !busy;

  return <Paper sx={{ p: 3, mb: 3 }}>
    <Typography variant="h6" gutterBottom>{t('settings.credentialTransfer.title')}</Typography>
    <Alert severity="warning" sx={{ mb: 2 }}>{t('settings.credentialTransfer.warning')}</Alert>
    {message && <Alert severity={message.error ? 'error' : 'success'} sx={{ mb: 2 }}>{message.text}</Alert>}
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <TextField type="password" autoComplete="new-password" disabled={busy}
        label={t('settings.credentialTransfer.recipientPassphrase')} value={recipientPassphrase}
        onChange={event => setRecipientPassphrase(event.target.value)} />
      <FormControlLabel control={<Checkbox checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />}
        label={t('settings.credentialTransfer.confirm')} />
      <Button variant="outlined" disabled={!ready} onClick={() => void run(false)}>{t('settings.credentialTransfer.export')}</Button>
      <Button variant="outlined" disabled={busy} onClick={() => inputRef.current?.click()}>
        {file ? file.name : t('settings.backup.selectFile')}
      </Button>
      <input ref={inputRef} hidden type="file" accept=".flujo-transfer" onChange={event => { setFile(event.target.files?.[0] ?? null); setMessage(null); }} />
      <TextField disabled={busy} label={t('settings.credentialTransfer.workspace')} value={destination}
        onChange={event => setDestination(event.target.value)} />
      <TextField type="password" autoComplete="new-password" disabled={busy}
        label={t('settings.credentialTransfer.localPassphrase')} value={localPassphrase}
        onChange={event => setLocalPassphrase(event.target.value)} />
      <Button variant="contained" disabled={!ready || !file || !isValidWorkspaceName(destination)
          || localPassphrase.length < 12 || localPassphrase === recipientPassphrase}
        onClick={() => void run(true)}>{t('settings.credentialTransfer.restore')}</Button>
    </Box>
  </Paper>;
}
