'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { flowService } from '@/frontend/services/flow';
import type { Flow } from '@/shared/types/flow';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { teamService, TeamRequestError, projectSharedFlow, readSharedFlow, sharedFlowDraftSchema, SHARED_FLOW_FORMAT,
  type SharedFlowDocument, type SharedResource, type EditorLease, type TeamSummary } from '@/frontend/services/teams';
import TeamFlowEditor from './TeamFlowEditor';

interface Editing { teamId: string; resource?: SharedResource; lease?: EditorLease; document: SharedFlowDocument; omitted: string[]; }
const message = (error: unknown) => error instanceof Error ? error.message : 'The local team service is unavailable.';

export default function TeamFlows() {
  const { t } = useI18n(); const params = useSearchParams(); const mounted = useRef(true); const acting = useRef(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]); const [teamId, setTeamId] = useState(''); const selectedTeam = useRef(teamId); selectedTeam.current = teamId;
  const [resources, setResources] = useState<SharedResource[]>([]); const [editing, setEditing] = useState<Editing | null>(null);
  const [document, setDocument] = useState<SharedFlowDocument | null>(null); const draft = useRef(document); draft.current = document;
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [lockError, setLockError] = useState(''); const [lostLock, setLostLock] = useState(false); const expiresAt = useRef(Infinity);
  const [sourceFlows, setSourceFlows] = useState<Flow[]>([]); const [sourceOpen, setSourceOpen] = useState(false); const [sourceId, setSourceId] = useState('');
  const [consent, setConsent] = useState(false); const [confirmClose, setConfirmClose] = useState(false); const deepLinkOpened = useRef(false);
  const [pendingFields, setPendingFields] = useState<Record<string, string>>({});
  const [draftGeneration, setDraftGeneration] = useState(0); const loadingDraft = useRef(false);
  const rows = resources.filter(resource => resource.kind === 'flow' && resource.format === SHARED_FLOW_FORMAT);
  const team = teams.find(value => value.id === teamId);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    void teamService.teams().then(result => {
      if (!current) return; setTeams(result.teams);
      const requested = params.get('team'); setTeamId(result.teams.find(team => team.id === requested)?.id ?? result.teams[0]?.id ?? '');
    }).catch(failure => { if (current) setError(message(failure)); });
    return () => { current = false; };
  }, [params]);
  const refresh = useCallback(async (id: string) => {
    try { const result = await teamService.resources(id); if (mounted.current && selectedTeam.current === id) setResources(result.resources); }
    catch (failure) { if (mounted.current && selectedTeam.current === id) { setResources([]); setError(message(failure)); } }
  }, []);
  useEffect(() => { setResources([]); if (teamId) void refresh(teamId); }, [teamId, refresh]);
  const startEditor = useCallback((next: Editing) => {
    setEditing(next); setDocument(next.document); setConsent(Boolean(next.resource)); setLostLock(false); setLockError('');
    expiresAt.current = next.lease?.expiresAt ?? Infinity; setPendingFields({});
  }, []);
  const openEditor = useCallback(async (row: SharedResource) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError('');
    let acquired: Awaited<ReturnType<typeof teamService.acquire>> | undefined;
    try {
      acquired = await teamService.acquire(row.teamId, row.id, row.version);
      const document = readSharedFlow(JSON.parse(acquired.revision.content), row.teamId);
      if (!mounted.current || selectedTeam.current !== row.teamId) { await teamService.release(row.teamId, row.id, acquired.lease); return; }
      startEditor({ teamId: row.teamId, resource: acquired.resource, lease: acquired.lease, document, omitted: [] });
    } catch (failure) {
      if (acquired) void teamService.release(row.teamId, row.id, acquired.lease).catch(() => {});
      if (mounted.current) setError(message(failure));
    } finally { acting.current = false; if (mounted.current) setBusy(false); }
  }, [startEditor]);
  useEffect(() => {
    const requested = params.get('resource'); if (!requested || deepLinkOpened.current || !rows.length || editing) return;
    const row = rows.find(value => value.id === requested); deepLinkOpened.current = true; if (row) void openEditor(row);
  }, [params, rows, editing, openEditor]);
  useEffect(() => {
    if (!editing) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect); let current = true; let renewing = false;
    const timer = setInterval(async () => {
      if (!editing.resource || !editing.lease || renewing || acting.current) return;
      if (Date.now() >= expiresAt.current) { setLostLock(true); clearInterval(timer); return; }
      renewing = true;
      try { const renewed = await teamService.renew(editing.teamId, editing.resource.id, editing.lease); if (current) { expiresAt.current = renewed.expiresAt; setLockError(''); } }
      catch (failure) { if (current) { setLockError(message(failure)); if ((failure instanceof TeamRequestError && [401, 403, 404, 409].includes(failure.status)) || Date.now() >= expiresAt.current) { setLostLock(true); clearInterval(timer); } } }
      finally { renewing = false; }
    }, 20_000);
    return () => {
      current = false; clearInterval(timer); window.removeEventListener('beforeunload', protect);
      if (editing.resource && editing.lease) void teamService.release(editing.teamId, editing.resource.id, editing.lease).catch(() => {});
    };
  }, [editing]);
  async function chooseSource() {
    if (acting.current) return; acting.current = true; setBusy(true); setError('');
    try { const flows = await flowService.loadFlows({ refresh: true }); if (mounted.current) { setSourceFlows(flows); setSourceId(''); setSourceOpen(true); } }
    catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  }
  function reviewSource() {
    const source = sourceFlows.find(value => value.id === sourceId); if (!source) return;
    try {
      const projected = projectSharedFlow(source); startEditor({ teamId, document: projected.document, omitted: projected.omitted });
      setSourceOpen(false); setSourceId(''); setSourceFlows([]); setError('');
    } catch (failure) { setError(message(failure)); }
  }
  function download() {
    if (!draft.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'flujo.flow.draft.v1', document: draft.current, pendingFields }, null, 2)], { type: 'application/json' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'flujo-team-flow-draft.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadDraft(file?: File) {
    if (!file || !editing || acting.current || loadingDraft.current) return;
    loadingDraft.current = true; acting.current = true; setBusy(true); const previous = editing;
    try {
      if (file.size > 1024 * 1024) throw new Error(t('teams.flows.draftTooLarge'));
      const restored = sharedFlowDraftSchema.parse(JSON.parse(await file.text()));
      if (!mounted.current || editor.current !== previous) return;
      setDocument(restored.document); setPendingFields(restored.pendingFields); setDraftGeneration(value => value + 1); setError('');
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { loadingDraft.current = false; acting.current = false; if (mounted.current) setBusy(false); }
  }
  const editor = useRef(editing); editor.current = editing;
  async function save() {
    if (!editing || !document || acting.current || !consent || lostLock || Object.keys(pendingFields).length) return;
    if (Date.now() >= expiresAt.current) { setLostLock(true); return; }
    acting.current = true; setBusy(true); setError('');
    try {
      const content = readSharedFlow(document, editing.teamId); const name = content.flow.name;
      if (editing.resource && editing.lease) await teamService.save(editing.teamId, editing.resource.id, editing.lease, name, JSON.stringify(content));
      else await teamService.createFlow(editing.teamId, name, JSON.stringify(content));
      if (mounted.current) { setEditing(null); setDocument(null); setNotice(t('teams.flows.saved')); void refresh(editing.teamId); }
    } catch (failure) {
      if (mounted.current) { setError(message(failure)); if (failure instanceof TeamRequestError && [401, 403, 404, 409].includes(failure.status)) setLostLock(true); }
    } finally { acting.current = false; if (mounted.current) setBusy(false); }
  }
  return <Box sx={{ p: { xs: 2, md: 4 }, height: '100%', overflowY: 'auto' }}><Stack spacing={2} sx={{ maxWidth: 1400, mx: 'auto' }}>
    <Typography variant="h4" component="h1">{t('teams.flows.title')}</Typography>
    <Alert severity="info">{t('teams.flows.boundary')}</Alert>
    {!editing && <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button component="a" href="/_account/teams">{t('teams.models.membership')}</Button><Button component="a" href={`/teams/models?team=${teamId}`}>{t('teams.models.title')}</Button></Stack>}
    {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}{notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <TextField select label={t('teams.models.team')} value={teamId} disabled={busy || !!editing} onChange={event => setTeamId(event.target.value)} sx={{ flex: 1, minWidth: 200 }}>
        {teams.map(team => <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>)}
      </TextField><Button disabled={!team || busy || !!editing} onClick={() => void chooseSource()}>{t('teams.flows.share')}</Button>
      <Button disabled={!team || busy || !!editing} onClick={() => startEditor({ teamId, omitted: [], document: { format: SHARED_FLOW_FORMAT, flow: { name: t('teams.flows.defaultName'), nodes: [], edges: [] } } })}>{t('teams.flows.new')}</Button>
      <Button disabled={!team || busy} onClick={() => void refresh(teamId)}>{t('teams.models.refresh')}</Button>
      <Button component="a" href="/flows" disabled={!!editing}>{t('flows.page.title')}</Button>
    </Stack>
    {busy && <CircularProgress size={24} aria-label={t('teams.models.loading')} />}
    {!teams.length && <Typography>{t('teams.models.noTeams')}</Typography>}
    {!editing && rows.map(row => <Paper key={row.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <Typography sx={{ flex: 1, overflowWrap: 'anywhere' }}>{row.name} · {t('teams.models.revision', { version: row.version })}</Typography>
      <Button disabled={busy} onClick={() => void openEditor(row)}>{t('teams.models.edit')}</Button><Button component="a" href={teamService.historyUrl(teamId, row.id)}>{t('teams.models.history')}</Button>
    </Stack></Paper>)}
    {editing && document && <>
      {editing.omitted.length > 0 && <Alert severity="warning">{t('teams.flows.omitted')} {editing.omitted.join(', ')}</Alert>}
      {editing.lease && <Alert severity="info">{t('teams.models.lock')}</Alert>}
      {(lockError || lostLock) && <Alert severity="warning">{lostLock ? t('teams.models.lockLost') : lockError} {t('teams.models.keepDraft')}</Alert>}
      <TeamFlowEditor key={`${editing.resource?.id ?? 'new'}:${editing.lease?.version ?? 0}:${draftGeneration}`} value={document} teamId={editing.teamId} resources={resources} disabled={busy} initialDraftFields={pendingFields}
        onChange={setDocument} onDraftFieldsChange={setPendingFields} />
      {Object.keys(pendingFields).length > 0 && <Alert severity="warning" sx={{ overflowWrap: 'anywhere' }}>{t('teams.flows.invalidProperty')} {Object.keys(pendingFields).map(key => {
        const node = document.flow.nodes.find(item => key.startsWith(`${item.id}:`));
        return node ? `${node.data.label}: ${key.slice(node.id.length + 1)}` : key;
      }).join(', ')}</Alert>}
      {!editing.resource && <FormControlLabel label={t('teams.flows.consent', { team: team?.name ?? '' })} control={<Checkbox checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />} />}
      <Typography>{t('teams.models.keepDraft')}</Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button variant="contained" disabled={busy || lostLock || !consent || Object.keys(pendingFields).length > 0} onClick={() => void save()}>{t('teams.models.save')}</Button>
        <Button onClick={download}>{t('teams.models.download')}</Button>
        <Button component="label" disabled={busy}>{t('teams.flows.loadDraft')}<input hidden type="file" accept="application/json,.json" disabled={busy} onChange={event => { void loadDraft(event.target.files?.[0]); event.target.value = ''; }} /></Button>
        <Button disabled={busy} onClick={() => setConfirmClose(true)}>{t('common.cancel')}</Button></Stack>
    </>}
  </Stack>
    <Dialog open={sourceOpen} onClose={() => { setSourceOpen(false); setSourceId(''); setSourceFlows([]); }} fullWidth maxWidth="sm"><DialogTitle>{t('teams.flows.share')}</DialogTitle><DialogContent><Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}<Typography>{t('teams.flows.sourceNote')}</Typography>
      <TextField select label={t('teams.flows.source')} value={sourceId} onChange={event => setSourceId(event.target.value)}>{sourceFlows.map(flow => <MenuItem key={flow.id} value={flow.id}>{flow.name}</MenuItem>)}</TextField>
    </Stack></DialogContent><DialogActions><Button onClick={() => { setSourceOpen(false); setSourceId(''); setSourceFlows([]); }}>{t('common.cancel')}</Button><Button disabled={!sourceId} onClick={reviewSource}>{t('teams.models.review')}</Button></DialogActions></Dialog>
    <Dialog open={confirmClose} onClose={() => setConfirmClose(false)}><DialogTitle>{t('teams.models.discardTitle')}</DialogTitle><DialogContent>{t('teams.models.keepDraft')}</DialogContent><DialogActions>
      <Button onClick={() => setConfirmClose(false)}>{t('common.cancel')}</Button><Button onClick={download}>{t('teams.models.download')}</Button>
      <Button color="error" onClick={() => { setConfirmClose(false); setEditing(null); setDocument(null); }}>{t('teams.models.discard')}</Button>
    </DialogActions></Dialog>
  </Box>;
}
