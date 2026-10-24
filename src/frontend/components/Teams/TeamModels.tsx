'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import ModelModal from '@/frontend/components/models/modal';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { getModelService } from '@/frontend/services/model';
import type { Model } from '@/shared/types/model';
import { teamService, TeamRequestError, modelConfigurationFields, publishableModel, readSharedModel, SHARED_MODEL_FORMAT,
  type TeamSummary, type SharedResource, type EditorLease } from '@/frontend/services/teams';

interface Editing { teamId: string; resource?: SharedResource; lease?: EditorLease; model: Model; }
const message = (error: unknown) => error instanceof Error ? error.message : 'The local team service is unavailable.';

export default function TeamModels() {
  const { t } = useI18n(); const params = useSearchParams();
  const [teams, setTeams] = useState<TeamSummary[]>([]); const [teamId, setTeamId] = useState('');
  const [rows, setRows] = useState<SharedResource[]>([]); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null); const [lockError, setLockError] = useState('');
  const [lostLock, setLostLock] = useState(false); const [confirmClose, setConfirmClose] = useState(false);
  const [sourceModels, setSourceModels] = useState<Model[]>([]); const [sourceOpen, setSourceOpen] = useState(false); const [sourceId, setSourceId] = useState('');
  const draft = useRef<Model | null>(null); const mounted = useRef(true); const selectedTeam = useRef(teamId);
  const acting = useRef(false); const deepLinkOpened = useRef(false);
  const lockLostText = useRef(t('teams.models.lockLost')); lockLostText.current = t('teams.models.lockLost');
  selectedTeam.current = teamId;
  const selected = teams.find(team => team.id === teamId);
  const captureDraft = useCallback((value: Model) => { draft.current = value; }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    void teamService.teams().then(result => {
      if (!current) return;
      setTeams(result.teams);
      const requested = params.get('team');
      setTeamId(requested && result.teams.some(team => team.id === requested) ? requested : result.teams[0]?.id ?? '');
      if (requested && !result.teams.some(team => team.id === requested)) setError('Team unavailable. Choose a team you belong to.');
    }).catch(failure => { if (current) setError(message(failure)); });
    return () => { current = false; };
  }, [params]);

  const refresh = useCallback(async (id: string) => {
    try {
      const result = await teamService.resources(id);
      if (mounted.current && selectedTeam.current === id) setRows(result.resources.filter(row => row.kind === 'model' && row.format === SHARED_MODEL_FORMAT));
    } catch (failure) {
      if (mounted.current && selectedTeam.current === id) { setRows([]); setError(message(failure)); }
    }
  }, []);

  useEffect(() => { setRows([]); if (teamId) void refresh(teamId); }, [teamId, refresh]);

  const openEditor = useCallback(async (row: SharedResource) => {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError('');
    let acquired: Awaited<ReturnType<typeof teamService.acquire>> | undefined;
    try {
      acquired = await teamService.acquire(row.teamId, row.id, row.version);
      const document = readSharedModel(JSON.parse(acquired.revision.content));
      if (!mounted.current || selectedTeam.current !== row.teamId) {
        await teamService.release(row.teamId, row.id, acquired.lease); return;
      }
      const model: Model = { ...document.model, id: row.id, ApiKey: '' };
      draft.current = model; setLockError(''); setLostLock(false);
      setEditing({ teamId: row.teamId, resource: acquired.resource, lease: acquired.lease, model });
    } catch (failure) {
      if (acquired) void teamService.release(row.teamId, row.id, acquired.lease).catch(() => {});
      if (mounted.current) setError(message(failure));
    } finally { acting.current = false; if (mounted.current) setBusy(false); }
  }, []);

  useEffect(() => {
    const requested = params.get('resource');
    if (!requested || deepLinkOpened.current || !rows.length || editing) return;
    const row = rows.find(value => value.id === requested);
    deepLinkOpened.current = true;
    if (row) void openEditor(row);
  }, [params, rows, editing, openEditor]);

  useEffect(() => {
    if (!editing) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    let current = true; let renewing = false; let expiresAt = editing.lease?.expiresAt ?? Infinity;
    const timer = setInterval(async () => {
      if (!editing.lease || !editing.resource || renewing || acting.current) return;
      if (expiresAt <= Date.now()) { setLostLock(true); setLockError(lockLostText.current); clearInterval(timer); return; }
      renewing = true;
      try {
        const result = await teamService.renew(editing.teamId, editing.resource.id, editing.lease);
        expiresAt = result.expiresAt; if (current) setLockError('');
      } catch (failure) {
        if (!current) return;
        setLockError(message(failure));
        if ((failure instanceof TeamRequestError && [401, 403, 404, 409].includes(failure.status)) || expiresAt <= Date.now()) {
          setLostLock(true); clearInterval(timer);
        }
      } finally { renewing = false; }
    }, 20_000);
    return () => {
      current = false; clearInterval(timer); window.removeEventListener('beforeunload', protect);
      if (editing.lease && editing.resource) void teamService.release(editing.teamId, editing.resource.id, editing.lease).catch(() => {});
    };
  }, [editing]);

  async function chooseSource() {
    if (acting.current) return;
    acting.current = true; setBusy(true); setError('');
    try { const models = await getModelService().loadModels('private'); if (mounted.current) { setSourceModels(models); setSourceId(''); setSourceOpen(true); } }
    catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  }

  function reviewSource() {
    const source = sourceModels.find(model => model.id === sourceId); if (!source) return;
    try {
      const document = publishableModel({ ...source });
      const model: Model = { ...document.model, id: 'new-team-model', ApiKey: '' };
      draft.current = model; setSourceOpen(false); setSourceModels([]); setEditing({ teamId, model }); setLostLock(false); setLockError(''); setError('');
    } catch (failure) { setError(message(failure)); }
  }

  function downloadDraft() {
    if (!draft.current) return;
    // The editor only receives a projected configuration; credentials and owner
    // bindings are absent before any keystroke or draft download can occur.
    const configuration = modelConfigurationFields({ ...draft.current });
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'flujo.model.draft.v1', model: configuration }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'flujo-team-model-draft.json'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function save(model: Model) {
    if (!editing || acting.current || lostLock) return { success: false, error: t('teams.models.lockLost') };
    acting.current = true; setBusy(true);
    try {
      const document = publishableModel({ ...draft.current, ...model }); const content = JSON.stringify(document);
      const name = (document.model.displayName || document.model.name).slice(0, 120);
      if (editing.resource && editing.lease) await teamService.save(editing.teamId, editing.resource.id, editing.lease, name, content);
      else await teamService.create(editing.teamId, name, content);
      if (mounted.current) { setEditing(null); draft.current = null; setNotice(t('teams.models.saved')); void refresh(editing.teamId); }
      return { success: true };
    } catch (failure) {
      if (failure instanceof TeamRequestError && [401, 403, 404].includes(failure.status)) setLostLock(true);
      return { success: false, error: `${message(failure)} ${t('teams.models.keepDraft')}` };
    } finally { acting.current = false; if (mounted.current) setBusy(false); }
  }

  return <Box sx={{ p: { xs: 2, md: 4 }, overflowY: 'auto', height: '100%' }}>
    <Stack spacing={2} sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Typography variant="h4" component="h1">{t('teams.models.title')}</Typography>
      <Typography color="text.secondary">{t('teams.models.description')}</Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button component="a" href="/_account/teams">{t('teams.models.membership')}</Button><Button component="a" href="/models">{t('nav.aiSetup')}</Button></Stack>
      {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}
      {notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <TextField select label={t('teams.models.team')} value={teamId} onChange={event => { setTeamId(event.target.value); setError(''); setNotice(''); }} disabled={busy || !!editing} sx={{ minWidth: 240, flex: 1 }}>
          {teams.map(team => <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>)}
        </TextField>
        <Button variant="contained" disabled={!selected || busy || !!editing} onClick={() => void chooseSource()}>{t('teams.models.share')}</Button>
        <Button disabled={!teamId || busy} onClick={() => void refresh(teamId)}>{t('teams.models.refresh')}</Button>
      </Stack>
      {busy && <CircularProgress size={24} aria-label={t('teams.models.loading')} />}
      {!teams.length && <Typography>{t('teams.models.noTeams')}</Typography>}
      {selected && !rows.length && <Typography>{t('teams.models.empty')}</Typography>}
      {rows.map(row => <Paper key={row.id} variant="outlined" sx={{ p: 2, overflowWrap: 'anywhere' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
          <Box><Typography variant="h6">{row.name}</Typography><Typography color="text.secondary">{t('teams.models.revision', { version: row.version })}</Typography></Box>
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button disabled={busy} onClick={() => void openEditor(row)}>{t('teams.models.edit')}</Button>
            <Button component="a" href={teamService.accessUrl(teamId, row.id)}>{t('teams.models.executionAccess')}</Button>
            <Button component="a" href={teamService.historyUrl(teamId, row.id)}>{t('teams.models.history')}</Button></Stack>
        </Stack>
      </Paper>)}
    </Stack>
    <Dialog open={sourceOpen} onClose={() => { setSourceOpen(false); setSourceModels([]); }} fullWidth maxWidth="sm">
      <DialogTitle>{t('teams.models.share')}</DialogTitle><DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        <Typography sx={{ mb: 2 }}>{t('teams.models.sourceNote')}</Typography>
        <TextField select fullWidth label={t('teams.models.source')} value={sourceId} onChange={event => setSourceId(event.target.value)}>
          {sourceModels.map(model => <MenuItem key={model.id} value={model.id}>{model.displayName || model.name}</MenuItem>)}
        </TextField>
      </DialogContent><DialogActions><Button onClick={() => { setSourceOpen(false); setSourceModels([]); }}>{t('common.cancel')}</Button><Button disabled={!sourceId} onClick={reviewSource}>{t('teams.models.review')}</Button></DialogActions>
    </Dialog>
    {editing && <ModelModal open model={editing.model} configurationOnly saveDisabled={busy || lostLock}
      saveLabel={editing.resource ? t('teams.models.save') : t('teams.models.shareTo', { team: selected?.name ?? '' })}
      onDraftChange={captureDraft} onSave={save} onClose={() => { if (!busy) setConfirmClose(true); }}
      notice={<Stack spacing={1} sx={{ mb: 2 }}><Alert severity="info">{t('teams.models.credentials')}{editing.lease ? ` ${t('teams.models.lock')}` : ''}</Alert>
        {lockError && <Alert severity="warning">{lockError} {t('teams.models.keepDraft')}</Alert>}
        <Button onClick={downloadDraft}>{t('teams.models.download')}</Button></Stack>} />}
    <Dialog open={confirmClose} onClose={() => setConfirmClose(false)}><DialogTitle>{t('teams.models.discardTitle')}</DialogTitle>
      <DialogContent>{t('teams.models.keepDraft')}</DialogContent><DialogActions>
        <Button onClick={() => setConfirmClose(false)}>{t('common.cancel')}</Button><Button onClick={downloadDraft}>{t('teams.models.download')}</Button>
        <Button color="error" onClick={() => { setConfirmClose(false); setEditing(null); draft.current = null; }}>{t('teams.models.discard')}</Button>
      </DialogActions></Dialog>
  </Box>;
}
