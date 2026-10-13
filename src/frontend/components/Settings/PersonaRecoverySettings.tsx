'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Paper, TextField, Typography } from '@mui/material';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import { getSelectedWorkspace, isValidWorkspaceName, onWorkspaceChanged, workspacePageUrl } from '@/frontend/utils/workspaceSelection';
import { PERSONA_RECOVERY_MAX_ARCHIVE_BYTES, type PersonaRecoveryBackupSummary, type PersonaRecoveryRestorePreview } from '@/shared/types/personaRecovery';

const dialogActionsSx = {
  flexDirection: { xs: 'column', sm: 'row' }, alignItems: { xs: 'stretch', sm: 'center' }, gap: 1,
  '& .MuiButton-root': { minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere', whiteSpace: 'normal' },
} as const;

const failureKeys = {
  capture: 'settings.personaRecovery.captureFailed',
  inspect: 'settings.personaRecovery.inspectFailed',
  restore: 'settings.personaRecovery.restoreFailed',
} as const;
type RecoveryAction = keyof typeof failureKeys;
// Recognize the existing API diagnostics without displaying backend text or
// losing the different next actions for a collision and an outdated review.
const restoreFailureKeys = new Map<string, TranslationKey>([
  ['The recovery destination already exists; choose a new workspace name.', 'settings.personaRecovery.destinationExists'],
  ['A case-equivalent recovery workspace already exists.', 'settings.personaRecovery.destinationExists'],
  ['The destination contains a different recovery or existing workspace.', 'settings.personaRecovery.destinationExists'],
  ['Recovery preview changed; inspect the archive and destination again.', 'settings.personaRecovery.previewChanged'],
]);
/** Only messages translated by this UI may be presented as recovery errors. */
class RecoveryUiError extends Error {}

export default function PersonaRecoverySettings() {
  const { t, formatDate } = useI18n();
  const [workspace, setWorkspace] = useState(getSelectedWorkspace);
  const [file, setFile] = useState<File | null>(null);
  const [destination, setDestination] = useState('');
  const [backup, setBackup] = useState<{ blob: Blob; summary: PersonaRecoveryBackupSummary } | null>(null);
  const [preview, setPreview] = useState<PersonaRecoveryRestorePreview | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const prepareRef = useRef<HTMLButtonElement>(null);
  const inspectRef = useRef<HTMLButtonElement>(null);
  const restoredLinkRef = useRef<HTMLAnchorElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const dialogWorkspaceRef = useRef<string | null>(null);
  const requestRef = useRef<{ controller: AbortController; generation: number } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const unsubscribe = onWorkspaceChanged((selected) => {
      generation.current++;
      dialogWorkspaceRef.current = null;
      requestRef.current?.controller.abort();
      setWorkspace(selected); setFile(null); setDestination(''); setBackup(null); setPreview(null); setRestored(null); setError(null); setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    });
    return () => { unsubscribe(); generation.current++; requestRef.current?.controller.abort(); };
  }, []);

  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const run = async (action: RecoveryAction, task: (signal: AbortSignal, current: () => boolean) => Promise<void>) => {
    requestRef.current?.controller.abort();
    const request = { controller: new AbortController(), generation: ++generation.current };
    requestRef.current = request;
    const current = () => generation.current === request.generation && getSelectedWorkspace() === workspace;
    setBusy(true); setError(null); setRestored(null);
    try { await task(request.controller.signal, current); }
    catch (reason) {
      if (current() && !request.controller.signal.aborted) {
        setError(reason instanceof RecoveryUiError ? reason.message : t(failureKeys[action]));
      }
    }
    finally { if (current()) setBusy(false); }
  };
  const checkResponse = async (response: Response, action: RecoveryAction) => {
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: unknown } | null;
      const specificKey = action === 'restore' && typeof result?.error === 'string'
        ? restoreFailureKeys.get(result.error) : undefined;
      const key = response.status === 423 ? 'settings.personaRecovery.locked'
        : response.status === 403 ? 'settings.personaRecovery.localOnly'
          : response.status === 413 ? 'settings.personaRecovery.fileLimit' : specificKey ?? failureKeys[action];
      throw new RecoveryUiError(t(key));
    }
  };
  const endpoint = `/api/persona-recovery?workspace=${encodeURIComponent(workspace)}`;
  const prepare = () => run('capture', async (signal, current) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'x-persona-recovery-action': 'capture' }, signal });
    await checkResponse(response, 'capture');
    const summary = JSON.parse(decodeURIComponent(response.headers.get('x-flujo-persona-recovery-summary') ?? '')) as PersonaRecoveryBackupSummary;
    const blob = await response.blob();
    if (summary.sourceWorkspace !== workspace || blob.size !== summary.archiveBytes) throw new RecoveryUiError(t('settings.personaRecovery.captureFailed'));
    if (current()) { dialogWorkspaceRef.current = workspace; setBackup({ blob, summary }); }
  });
  const inspect = () => run('inspect', async (signal, current) => {
    if (!file || !file.size || file.size > PERSONA_RECOVERY_MAX_ARCHIVE_BYTES) throw new RecoveryUiError(t('settings.personaRecovery.fileLimit'));
    const response = await fetch(`${endpoint}&destination=${encodeURIComponent(destination)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/zip', 'x-persona-recovery-action': 'inspect' }, body: file, signal,
    });
    await checkResponse(response, 'inspect');
    const next = await response.json() as PersonaRecoveryRestorePreview;
    if (current()) { dialogWorkspaceRef.current = workspace; setPreview(next); }
  });
  const restore = () => run('restore', async (signal, current) => {
    if (!file || !preview) return;
    const response = await fetch(`${endpoint}&destination=${encodeURIComponent(preview.destinationWorkspace)}`, {
      method: 'POST', headers: {
        'Content-Type': 'application/zip', 'x-persona-recovery-action': 'restore', 'x-persona-recovery-preview': preview.previewToken,
      }, body: file, signal,
    });
    await checkResponse(response, 'restore');
    const result = await response.json() as { workspace: string };
    if (current()) { setRestored(result.workspace); setPreview(null); }
  });
  const download = () => {
    if (!backup) return;
    const url = URL.createObjectURL(backup.blob);
    const link = document.createElement('a');
    link.href = url; link.download = `flujo-persona-recovery-${backup.summary.captureId}.zip`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
    setBackup(null);
  };
  const contents = (counts: Record<string, number>) => t('settings.personaRecovery.contents', {
    personas: counts.personas ?? 0, memories: counts['persona-memories'] ?? 0,
    tasks: counts['persona-work-items'] ?? 0, conversations: counts.conversations ?? 0, flows: counts.flows ?? 0,
  });
  const source = (value: { sourceWorkspace: string; capturedAt: number }) => t('settings.personaRecovery.source', {
    workspace: value.sourceWorkspace, date: formatDate(value.capturedAt, { dateStyle: 'medium', timeStyle: 'medium' }),
  });
  const destinationValid = isValidWorkspaceName(destination) && destination.toLowerCase() !== workspace.toLowerCase();
  // Preparing a preview disables its trigger during the request, so the browser
  // may move focus to body before MUI records where to restore it. Restore to an
  // explicit, still-mounted control only in the workspace that opened the dialog.
  const restoreDialogFocus = (target: HTMLElement | null) => {
    if (dialogWorkspaceRef.current === getSelectedWorkspace() && target?.isConnected) target.focus();
  };

  return <Paper sx={{ p: { xs: 2, sm: 3 }, mb: 3, minWidth: 0 }}>
    <Typography variant="h6" component="h3" gutterBottom>{t('settings.personaRecovery.title')}</Typography>
    <Typography sx={{ mb: 2 }}>{t('settings.personaRecovery.description')}</Typography>
    <Alert severity="warning" sx={{ mb: 2 }}>{t('settings.personaRecovery.sensitive')}</Alert>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{t('settings.personaRecovery.exclusions')}</Typography>
    <Button ref={prepareRef} variant="contained" disabled={busy} onClick={() => void prepare()}>{t('settings.personaRecovery.prepare')}</Button>
    <Divider sx={{ my: 3 }} />
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
      <Button type="button" variant="outlined" disabled={busy} onClick={() => inputRef.current?.click()}>
        {t('settings.personaRecovery.chooseFile')}
      </Button>
      <input ref={inputRef} type="file" accept=".zip,application/zip" hidden disabled={busy} onChange={(event) => {
          setFile(event.target.files?.[0] ?? null); setPreview(null); setRestored(null); setError(null);
      }} />
      {file && <Typography variant="body2" sx={{ overflowWrap: 'anywhere', maxWidth: '100%' }}>{file.name}</Typography>}
      <TextField fullWidth label={t('settings.personaRecovery.destination')} value={destination} disabled={busy}
        helperText={t('settings.personaRecovery.destinationHelp')} slotProps={{ htmlInput: { maxLength: 64 } }}
        onChange={(event) => { setDestination(event.target.value); setPreview(null); setRestored(null); }} />
      <Button ref={inspectRef} variant="outlined" disabled={busy || !file || !destinationValid} onClick={() => void inspect()}>{t('settings.personaRecovery.inspect')}</Button>
    </Box>
    {busy && <Box role="status" sx={{ display: 'flex', gap: 1, alignItems: 'center', mt: 2 }}>
      <CircularProgress size={20} aria-label={t('settings.personaRecovery.working')} />
      <Typography>{t('settings.personaRecovery.working')}</Typography>
    </Box>}
    {/* Moving focus announces errors; a live alert would repeat the same message. */}
    {error && !preview && <Alert ref={errorRef} tabIndex={-1} aria-live="off" severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    {restored && <Alert severity="success" sx={{ mt: 2, overflowWrap: 'anywhere' }}>
      {t('settings.personaRecovery.success', { workspace: restored })}
      <Box sx={{ mt: 1 }}><Button ref={restoredLinkRef} href={workspacePageUrl(restored)}>{t('settings.personaRecovery.open')}</Button></Box>
    </Alert>}
    <Dialog open={backup !== null} onClose={() => setBackup(null)} disableRestoreFocus
      slotProps={{ transition: { onExited: () => restoreDialogFocus(prepareRef.current) } }}
      fullWidth maxWidth="sm" aria-labelledby="persona-recovery-download-title">
      <DialogTitle id="persona-recovery-download-title">{t('settings.personaRecovery.prepare')}</DialogTitle>
      <DialogContent sx={{ overflowWrap: 'anywhere' }}>
        {backup && <><Typography>{source(backup.summary)}</Typography><Typography sx={{ my: 2 }}>{contents(backup.summary.counts)}</Typography></>}
        {!!backup?.summary.counts.conversationLogSequenceAnomalies && <Alert severity="info" sx={{ mb: 2 }}>{t('settings.personaRecovery.historyNotice')}</Alert>}
        <Alert severity="warning">{t('settings.personaRecovery.sensitive')}</Alert>
      </DialogContent>
      <DialogActions disableSpacing sx={dialogActionsSx}><Button onClick={() => setBackup(null)}>{t('common.cancel')}</Button><Button variant="contained" onClick={download}>{t('settings.personaRecovery.download')}</Button></DialogActions>
    </Dialog>
    <Dialog open={preview !== null} onClose={() => { if (!busy) setPreview(null); }} disableRestoreFocus
      slotProps={{ transition: { onExited: () => restoreDialogFocus(restoredLinkRef.current ?? inspectRef.current) } }}
      fullWidth maxWidth="sm" aria-labelledby="persona-recovery-restore-title">
      <DialogTitle id="persona-recovery-restore-title">{t('settings.personaRecovery.inspect')}</DialogTitle>
      <DialogContent sx={{ overflowWrap: 'anywhere' }}>
        {preview && <>
          <Typography>{source(preview)}</Typography>
          <Typography sx={{ my: 2 }}>{contents(preview.sourceCounts)}</Typography>
          <Typography sx={{ mb: 2 }}>{t('settings.personaRecovery.destination')}: <strong>{preview.destinationWorkspace}</strong></Typography>
          <Alert severity="info">{t('settings.personaRecovery.frozen')}</Alert>
          {!!preview.sourceCounts.conversationLogSequenceAnomalies && <Alert severity="info" sx={{ mt: 2 }}>{t('settings.personaRecovery.historyNotice')}</Alert>}
          <Typography sx={{ mt: 2 }}>{t('settings.personaRecovery.connections', { models: preview.requiredModelIds.length, apps: preview.requiredAppNames.length })}</Typography>
        </>}
        {busy && <Typography role="status" sx={{ mt: 2 }}>{t('settings.personaRecovery.working')}</Typography>}
        {error && preview && <Alert ref={errorRef} tabIndex={-1} aria-live="off" severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions disableSpacing sx={dialogActionsSx}><Button disabled={busy} onClick={() => setPreview(null)}>{t('common.cancel')}</Button><Button disabled={busy} variant="contained" onClick={() => void restore()}>{t('settings.personaRecovery.restore')}</Button></DialogActions>
    </Dialog>
  </Paper>;
}
