'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material';
import { mcpService } from '@/frontend/services/mcp';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { teamService, TeamRequestError, projectSharedMcp, readSharedMcp, sharedMcpDraftSchema, SHARED_MCP_FORMAT, MCP_DRAFT_BYTES,
  type SharedMcpDocument, type SharedResource, type EditorLease, type TeamSummary } from '@/frontend/services/teams';
import TeamMcpEditor from './TeamMcpEditor';

interface Editing { teamId: string; resource?: SharedResource; lease?: EditorLease; document: SharedMcpDocument; omitted: string[]; }
const message = (error: unknown) => error instanceof Error ? error.message : 'The local team service is unavailable.';

export default function TeamMcps() {
  const { t } = useI18n(); const params = useSearchParams(); const mounted = useRef(true); const acting = useRef(false);
  const [teams, setTeams] = useState<TeamSummary[]>([]); const [teamId, setTeamId] = useState(''); const selectedTeam = useRef(teamId); selectedTeam.current = teamId;
  const [resources, setResources] = useState<SharedResource[]>([]); const [editing, setEditing] = useState<Editing | null>(null);
  const [document, setDocument] = useState<SharedMcpDocument | null>(null); const draft = useRef(document); draft.current = document;
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [lockError, setLockError] = useState(''); const [lostLock, setLostLock] = useState(false); const expiresAt = useRef(Infinity);
  const [sourceServers, setSourceServers] = useState<MCPServerConfig[]>([]); const [sourceOpen, setSourceOpen] = useState(false); const [sourceId, setSourceId] = useState('');
  const [consent, setConsent] = useState(false); const [confirmClose, setConfirmClose] = useState(false); const deepLinkOpened = useRef(false);
  const loadingDraft = useRef(false);
  const rows = resources.filter(resource => resource.kind === 'mcp' && resource.format === SHARED_MCP_FORMAT);
  const team = teams.find(value => value.id === (editing?.teamId ?? teamId));
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
    expiresAt.current = next.lease?.expiresAt ?? Infinity;
  }, []);
  const openEditor = useCallback(async (row: SharedResource) => {
    if (acting.current) return; acting.current = true; setBusy(true); setError('');
    let acquired: Awaited<ReturnType<typeof teamService.acquire>> | undefined;
    try {
      acquired = await teamService.acquire(row.teamId, row.id, row.version);
      const document = readSharedMcp(JSON.parse(acquired.revision.content));
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
    try { const servers = await mcpService.loadServerConfigs(); if (!Array.isArray(servers)) throw new Error(servers.error || 'Servers unavailable.'); if (mounted.current) { setSourceServers(servers); setSourceId(''); setSourceOpen(true); } }
    catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { acting.current = false; if (mounted.current) setBusy(false); }
  }
  function reviewSource() {
    const source = sourceServers.find(value => value.name === sourceId); if (!source) return;
    try {
      const projected = projectSharedMcp({ ...source }); startEditor({ teamId, document: projected.document, omitted: projected.omitted });
      setSourceOpen(false); setSourceId(''); setSourceServers([]); setError('');
    } catch (failure) { setError(message(failure)); }
  }
  function download() {
    if (!draft.current) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'flujo.mcp.draft.v1', document: draft.current }, null, 2)], { type: 'application/json' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'flujo-team-mcp-draft.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadDraft(file?: File) {
    if (!file || !editing || acting.current || loadingDraft.current) return;
    loadingDraft.current = true; acting.current = true; setBusy(true); const previous = editing;
    try {
      if (file.size > MCP_DRAFT_BYTES) throw new Error(t('teams.mcp.draftTooLarge'));
      const restored = sharedMcpDraftSchema.parse(JSON.parse(await file.text()));
      if (!mounted.current || editor.current !== previous) return;
      setDocument(restored.document); setError('');
    } catch (failure) { if (mounted.current) setError(message(failure)); }
    finally { loadingDraft.current = false; acting.current = false; if (mounted.current) setBusy(false); }
  }
  const editor = useRef(editing); editor.current = editing;
  async function save() {
    if (!editing || !document || acting.current || !consent || lostLock) return;
    if (Date.now() >= expiresAt.current) { setLostLock(true); return; }
    acting.current = true; setBusy(true); setError('');
    try {
      const content = readSharedMcp(document); const name = content.mcp.name;
      if (editing.resource && editing.lease) await teamService.save(editing.teamId, editing.resource.id, editing.lease, name, JSON.stringify(content));
      else await teamService.createMcp(editing.teamId, name, JSON.stringify(content));
      if (mounted.current) { setEditing(null); setDocument(null); setNotice(t('teams.mcp.saved')); void refresh(editing.teamId); }
    } catch (failure) {
      if (mounted.current) { setError(message(failure)); if (failure instanceof TeamRequestError && [401, 403, 404, 409].includes(failure.status)) setLostLock(true); }
    } finally { acting.current = false; if (mounted.current) setBusy(false); }
  }
  return <Box sx={{ p: { xs: 2, md: 4 }, height: '100%', overflowY: 'auto' }}><Stack spacing={2} sx={{ maxWidth: 1400, mx: 'auto' }}>
    <Typography variant="h4" component="h1">{t('teams.mcp.title')}</Typography>
    <Alert severity="info">{t('teams.mcp.boundary')}</Alert>
    {!editing && <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button component="a" href="/_account/teams">{t('teams.models.membership')}</Button><Button component="a" href={`/teams/models?team=${teamId}`}>{t('teams.models.title')}</Button></Stack>}
    {error && <Alert severity="error" onClose={() => setError('')}>{error}</Alert>}{notice && <Alert severity="success" onClose={() => setNotice('')}>{notice}</Alert>}
    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <TextField select label={t('teams.models.team')} value={editing?.teamId ?? teamId} disabled={busy || !!editing} onChange={event => setTeamId(event.target.value)} sx={{ flex: 1, minWidth: 200 }}>
        {teams.map(team => <MenuItem key={team.id} value={team.id}>{team.name}</MenuItem>)}
      </TextField><Button disabled={!team || busy || !!editing} onClick={() => void chooseSource()}>{t('teams.mcp.share')}</Button>
      <Button disabled={!team || busy || !!editing} onClick={() => startEditor({ teamId, omitted: [], document: { format: SHARED_MCP_FORMAT, mcp: { name: t('teams.mcp.defaultName'), transport: 'stdio', command: '', args: [] } } })}>{t('teams.mcp.new')}</Button>
      <Button disabled={!team || busy} onClick={() => void refresh(teamId)}>{t('teams.models.refresh')}</Button>
    </Stack>
    {busy && <CircularProgress size={24} aria-label={t('teams.models.loading')} />}
    {!teams.length && <Typography>{t('teams.models.noTeams')}</Typography>}
    {!editing && rows.map(row => <Paper key={row.id} variant="outlined" sx={{ p: 2 }}><Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
      <Typography sx={{ flex: 1, overflowWrap: 'anywhere' }}>{row.name} · {t('teams.models.revision', { version: row.version })}</Typography>
      <Button disabled={busy} onClick={() => void openEditor(row)}>{t('teams.models.edit')}</Button><Button component="a" href={teamService.historyUrl(teamId, row.id)}>{t('teams.models.history')}</Button>
    </Stack></Paper>)}
    {editing && document && <>
      {editing.omitted.length > 0 && <Alert severity="warning">{t('teams.mcp.omitted')} {editing.omitted.join(', ')}</Alert>}
      {editing.lease && <Alert severity="info">{t('teams.models.lock')}</Alert>}
      {(lockError || lostLock) && <Alert severity="warning">{lostLock ? t('teams.models.lockLost') : lockError} {t('teams.models.keepDraft')}</Alert>}
      <TeamMcpEditor value={document} disabled={busy} onChange={setDocument} />
      {!editing.resource && <FormControlLabel label={t('teams.mcp.consent', { team: team?.name ?? '' })} control={<Checkbox checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} />} />}
      <Typography>{t('teams.models.keepDraft')}</Typography>
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}><Button variant="contained" disabled={busy || lostLock || !consent} onClick={() => void save()}>{t('teams.models.save')}</Button>
        <Button onClick={download}>{t('teams.models.download')}</Button>
        <Button component="label" disabled={busy}>{t('teams.flows.loadDraft')}<input hidden type="file" accept="application/json,.json" disabled={busy} onChange={event => { void loadDraft(event.target.files?.[0]); event.target.value = ''; }} /></Button>
        <Button disabled={busy} onClick={() => setConfirmClose(true)}>{t('common.cancel')}</Button></Stack>
    </>}
  </Stack>
    <Dialog open={sourceOpen} onClose={() => { setSourceOpen(false); setSourceId(''); setSourceServers([]); }} fullWidth maxWidth="sm"><DialogTitle>{t('teams.mcp.share')}</DialogTitle><DialogContent><Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}<Typography>{t('teams.mcp.sourceNote')}</Typography>
      <TextField select label={t('teams.mcp.source')} value={sourceId} onChange={event => setSourceId(event.target.value)}>{sourceServers.map(server => <MenuItem key={server.name} value={server.name}>{server.name}</MenuItem>)}</TextField>
    </Stack></DialogContent><DialogActions><Button onClick={() => { setSourceOpen(false); setSourceId(''); setSourceServers([]); }}>{t('common.cancel')}</Button><Button disabled={!sourceId} onClick={reviewSource}>{t('teams.models.review')}</Button></DialogActions></Dialog>
    <Dialog open={confirmClose} onClose={() => setConfirmClose(false)}><DialogTitle>{t('teams.models.discardTitle')}</DialogTitle><DialogContent>{t('teams.models.keepDraft')}</DialogContent><DialogActions>
      <Button onClick={() => setConfirmClose(false)}>{t('common.cancel')}</Button><Button onClick={download}>{t('teams.models.download')}</Button>
      <Button color="error" onClick={() => { setConfirmClose(false); setEditing(null); setDocument(null); }}>{t('teams.models.discard')}</Button>
    </DialogActions></Dialog>
  </Box>;
}
