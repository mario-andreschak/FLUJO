"use client";

import {
  AppsRounded,
  AssignmentRounded,
  AutoStoriesRounded,
  BoltRounded,
  ChatBubbleOutlineRounded,
  CheckCircleOutlineRounded,
  EditRounded,
  HistoryRounded,
  OpenInNewRounded,
  RefreshRounded,
  ReplayRounded,
  SettingsRounded,
  WorkOutlineRounded,
} from '@mui/icons-material';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import FlowCard from '@/frontend/components/Flow/FlowDashboard/FlowCard';
import RoleVersionCard from './RoleVersionCard';
import PersonaDetailShell from './PersonaDetailShell';
import PersonaMemoryArea from './PersonaMemoryArea';
import PersonaSetup from './PersonaSetup';
import PersonasGallery from './PersonasGallery';
import { invalidatePersonaSummaryCache } from './personaQueries';
import {
  personasService,
  type PersonaBundle,
  type PersonaDetail,
  type RolesResponse,
} from '@/frontend/services/personas';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import { emitLaunchGlobalMcpApp } from '@/frontend/utils/quickActions';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import {
  PERSONA_AUTONOMY_LEVELS,
  PERSONA_INTERRUPTION_POLICIES,
  PERSONA_PRIORITIES,
  PERSONA_WORK_ITEM_STATUSES,
  type BehaviorBinding,
  type BehaviorRevision,
  type PersonaActivity,
  type PersonaPriority,
  type PersonaWorkItem,
  type PersonaWorkItemStatus,
} from '@/shared/types/enduringAgent';

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityTime(activity: PersonaActivity): number {
  return activity.completedAt ?? activity.startedAt ?? activity.updatedAt ?? activity.createdAt;
}

function activeActivity(detail?: PersonaDetail): PersonaActivity | undefined {
  const activeId = detail?.runtime?.projection?.active?.activityId;
  return detail?.activities.find((activity) => activity.id === activeId)
    ?? detail?.activities.find((activity) => activity.status === 'running' || activity.status === 'waiting');
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary' {
  if (status === 'completed' || status === 'active') return 'success';
  if (status === 'error' || status === 'forgotten' || status === 'cancelled') return 'error';
  if (status === 'candidate' || status === 'waiting' || status === 'blocked') return 'warning';
  if (status === 'running' || status === 'in_progress') return 'info';
  if (status === 'superseded') return 'default';
  return 'primary';
}

interface PersonasDeskProps {
  initialPersonaId?: string;
}

export default function PersonasDesk({ initialPersonaId }: PersonasDeskProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [selected, setSelected] = useState<PersonaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!initialPersonaId) {
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSelected(await personasService.get(initialPersonaId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [initialPersonaId, t]);

  useEffect(() => { void load(); }, [load]);

  const refreshSelected = useCallback(async () => {
    if (!initialPersonaId) return;
    setSelected(await personasService.get(initialPersonaId));
    invalidatePersonaSummaryCache();
  }, [initialPersonaId]);

  const mutate = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      await refreshSelected();
      if (success) setNotice(success);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      setBusy(false);
    }
  }, [refreshSelected, t]);

  const startConversation = useCallback(async (persona: { id: string; name: string }) => {
    setBusy(true);
    setActionError(null);
    try {
      const now = Date.now();
      const conversation = await personasService.startConversation({
        id: uuidv4(),
        title: `Conversation with ${persona.name}`,
        flowId: null,
        personaTargetId: persona.id,
        createdAt: now,
        updatedAt: now,
      });
      invalidatePersonaSummaryCache();
      router.push(withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: conversation.id })));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('personas.action.failed'));
      setBusy(false);
    }
  }, [router, t]);

  return (
    <Container maxWidth="xl" sx={{ py: { xs: 2, md: 3.5 } }}>
      {busy && <LinearProgress sx={{ position: 'fixed', inset: '0 0 auto', zIndex: 1500 }} />}
      {actionError && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setActionError(null)}>{actionError}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}
      {initialPersonaId && loading ? (
        <Stack alignItems="center" justifyContent="center" minHeight="55vh" spacing={2}>
          <CircularProgress />
          <Typography color="text.secondary">{t('personas.loading')}</Typography>
        </Stack>
      ) : initialPersonaId && error ? (
        <Alert severity="error" action={<Button onClick={() => void load()}>{t('personas.refresh')}</Button>}>
          {error}
        </Alert>
      ) : initialPersonaId && selected ? (
        <PersonaDetailShell
          detail={selected}
          busy={busy}
          refresh={refreshSelected}
          startConversation={() => startConversation(selected.persona)}
          renderArea={(area, subsection) => (
            <>
              {area === 'overview' && (
                <NowArea detail={selected} busy={busy} mutate={mutate} />
              )}
              {area === 'setup' && (
                <PersonaSetup detail={selected}>
                  {(subsection === null || subsection === 'behaviors') && (
                    <BehaviorsArea detail={selected} busy={busy} mutate={mutate} />
                  )}
                  {(subsection === null || subsection === 'apps') && (
                    <AppsArea detail={selected} busy={busy} mutate={mutate} />
                  )}
                </PersonaSetup>
              )}
              {area === 'memory' && (
                <PersonaMemoryArea detail={selected} busy={busy} refresh={refreshSelected} />
              )}
              {area === 'conversations' && (
                <TalkArea
                  detail={selected}
                  busy={busy}
                  startConversation={() => startConversation(selected.persona)}
                />
              )}
              {area === 'tasks' && (
                <WorkArea detail={selected} busy={busy} mutate={mutate} />
              )}
              {area === 'settings' && subsection === 'history' && (
                <ActivityArea detail={selected} />
              )}
              {area === 'settings' && subsection !== 'history' && (
                <Stack spacing={2}>
                  <SettingsArea detail={selected} busy={busy} mutate={mutate} />
                  <ActivityArea detail={selected} />
                </Stack>
              )}
            </>
          )}
        />
      ) : (
        <PersonasGallery
          busy={busy}
          onCreate={() => setCreateOpen(true)}
          onTalk={startConversation}
        />
      )}
      <CreatePersonaDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(detail) => {
          setCreateOpen(false);
          invalidatePersonaSummaryCache();
          router.push(withWorkspaceUrl(
            `/personas/${encodeURIComponent(detail.persona.id)}?area=overview`,
          ));
        }}
      />
    </Container>
  );
}





function AreaShell({ title, icon, action, children }: { title: string; icon: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2} sx={{ mb: 2.5 }}>
        <Stack direction="row" alignItems="center" spacing={1}><Box color="primary.main">{icon}</Box><Typography variant="h5" fontWeight={760}>{title}</Typography></Stack>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}



function NowArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const { t, formatDate } = useI18n();
  const active = activeActivity(detail);
  const queue = detail.mailboxItems.filter((item) => item.status === 'queued').sort((a, b) => a.sequence - b.sequence);
  return (
    <Stack spacing={2}>
      {detail.runtime.projection.stuck && (
        <Alert severity="warning" action={<Button disabled={busy} onClick={() => void mutate(() => personasService.recoverRuntime(detail.persona.id))}>{t('personas.now.recover')}</Button>}>
          {t('personas.now.stuck')} {detail.runtime.projection.stuckIndicators.map(humanize).join(', ')}
        </Alert>
      )}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.25fr) minmax(320px, .75fr)' }, gap: 2 }}>
        <AreaShell title={t('personas.now.title')} icon={<BoltRounded />}>
          {active ? (
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip color={statusColor(active.status)} label={humanize(active.status)} />
                <Chip label={humanize(active.kind)} />
                <Chip variant="outlined" label={humanize(active.source.kind)} />
              </Stack>
              <Typography variant="h6" fontWeight={720}>{active.source.sourceId ?? active.id}</Typography>
              <Typography color="text.secondary">Updated {formatDate(active.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })}</Typography>
              <Divider />
              <Typography variant="subtitle2">{t('personas.now.scratch')}</Typography>
              {active.resourceRefs?.length ? active.resourceRefs.map((ref) => <Chip key={ref} size="small" label={ref} sx={{ alignSelf: 'flex-start' }} />) : <Typography color="text.secondary">Working state remains Activity-scoped and is not promoted into durable work automatically.</Typography>}
            </Stack>
          ) : <Typography color="text.secondary">{t('personas.now.empty')}</Typography>}
        </AreaShell>
        <AreaShell title={t('personas.now.queue')} icon={<AssignmentRounded />}>
          {queue.length === 0 ? <Typography color="text.secondary">{t('personas.now.empty')}</Typography> : (
            <Stack divider={<Divider flexItem />}>
              {queue.map((item) => (
                <Box key={item.id} sx={{ py: 1.25 }}>
                  <Stack direction="row" justifyContent="space-between" gap={1}><Typography fontWeight={700}>{item.summary}</Typography><Chip size="small" label={humanize(item.priority)} /></Stack>
                  <Typography variant="caption" color="text.secondary">#{item.sequence} · {humanize(item.kind)}</Typography>
                </Box>
              ))}
            </Stack>
          )}
        </AreaShell>
      </Box>
    </Stack>
  );
}

function TalkArea({ detail, busy, startConversation }: { detail: PersonaDetail; busy: boolean; startConversation: () => Promise<void> }) {
  const { t, formatDate } = useI18n();
  const conversations = useMemo(() => {
    const byId = new Map<string, PersonaActivity>();
    detail.activities.filter((activity) => activity.conversationId).forEach((activity) => {
      const current = byId.get(activity.conversationId!);
      if (!current || activityTime(activity) > activityTime(current)) byId.set(activity.conversationId!, activity);
    });
    return [...byId.values()].sort((a, b) => activityTime(b) - activityTime(a));
  }, [detail.activities]);
  return (
    <AreaShell title={t('personas.talk.title')} icon={<ChatBubbleOutlineRounded />} action={<Button variant="contained" disabled={busy} onClick={() => void startConversation()} startIcon={<AddRounded />}>{t('personas.talk.new')}</Button>}>
      {conversations.length === 0 ? <Typography color="text.secondary">{t('personas.talk.empty')}</Typography> : (
        <Stack divider={<Divider flexItem />}>
          {conversations.map((activity) => (
            <Stack key={activity.conversationId} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5} sx={{ py: 1.5 }}>
              <Box><Typography fontWeight={720}>{humanize(activity.kind)}</Typography><Typography variant="body2" color="text.secondary">{formatDate(activityTime(activity), { dateStyle: 'medium', timeStyle: 'short' })} · {humanize(activity.status)}</Typography></Box>
              <Button component={Link} href={withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: activity.conversationId! }))}>{t('personas.talk.open')}</Button>
            </Stack>
          ))}
        </Stack>
      )}
    </AreaShell>
  );
}

interface WorkDraft {
  id?: string;
  title: string;
  description: string;
  status: PersonaWorkItemStatus;
  priority: PersonaPriority;
  nextAction: string;
  deadline: string;
  dependencyIds: string[];
  expectedUpdatedAt?: number;
}

function draftForWorkItem(item?: PersonaWorkItem): WorkDraft {
  return item ? {
    id: item.id,
    title: item.title,
    description: item.description ?? '',
    status: item.status,
    priority: item.priority,
    nextAction: item.nextAction ?? '',
    deadline: item.deadline ? new Date(item.deadline).toISOString().slice(0, 10) : '',
    dependencyIds: item.dependencyIds,
    expectedUpdatedAt: item.updatedAt,
  } : { title: '', description: '', status: 'open', priority: 'normal', nextAction: '', deadline: '', dependencyIds: [] };
}

function WorkArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const { t, formatDate } = useI18n();
  const [draft, setDraft] = useState<WorkDraft | null>(null);
  const sorted = [...detail.workItems].sort((a, b) => (a.status === 'completed' ? 1 : 0) - (b.status === 'completed' ? 1 : 0) || b.updatedAt - a.updatedAt);
  const save = async () => {
    if (!draft?.title.trim()) return;
    const deadline = draft.deadline ? new Date(`${draft.deadline}T23:59:59`).getTime() : null;
    if (draft.id) {
      await mutate(() => personasService.updateWorkItem(detail.persona.id, draft.id!, {
        title: draft.title,
        description: draft.description || null,
        status: draft.status,
        priority: draft.priority,
        nextAction: draft.nextAction || null,
        deadline,
        dependencyIds: draft.dependencyIds,
        expectedUpdatedAt: draft.expectedUpdatedAt,
      }));
    } else {
      await mutate(() => personasService.createWorkItem(detail.persona.id, {
        title: draft.title,
        ...(draft.description ? { description: draft.description } : {}),
        priority: draft.priority,
        ...(draft.nextAction ? { nextAction: draft.nextAction } : {}),
        ...(deadline ? { deadline } : {}),
        dependencyIds: draft.dependencyIds,
      }));
    }
    setDraft(null);
  };
  return (
    <AreaShell title={t('personas.work.title')} icon={<WorkOutlineRounded />} action={<Button variant="contained" startIcon={<AddRounded />} onClick={() => setDraft(draftForWorkItem())}>{t('personas.work.new')}</Button>}>
      {sorted.length === 0 ? <Typography color="text.secondary">{t('personas.work.empty')}</Typography> : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
          {sorted.map((item) => (
            <Card key={item.id} variant="outlined" sx={{ borderRadius: 3 }}>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                  <Typography variant="h6" fontWeight={720}>{item.title}</Typography>
                  <Stack direction="row" spacing={0.75}><Chip size="small" color={statusColor(item.status)} label={humanize(item.status)} /><Chip size="small" variant="outlined" label={humanize(item.priority)} /></Stack>
                </Stack>
                {item.description && <Typography color="text.secondary" sx={{ mt: 1 }}>{item.description}</Typography>}
                {item.nextAction && <Typography variant="body2" sx={{ mt: 1.5 }}><strong>{t('personas.work.nextAction')}:</strong> {item.nextAction}</Typography>}
                {item.deadline && <Typography variant="caption" color="text.secondary">Due {formatDate(item.deadline, { dateStyle: 'medium' })}</Typography>}
                {item.dependencyIds.length > 0 && <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>{item.dependencyIds.map((id) => <Chip key={id} size="small" label={detail.workItems.find((candidate) => candidate.id === id)?.title ?? id} />)}</Stack>}
              </CardContent>
              <CardActions>
                <Button startIcon={<EditRounded />} onClick={() => setDraft(draftForWorkItem(item))}>{t('personas.work.edit')}</Button>
                {item.status !== 'completed' && <Button disabled={busy} startIcon={<CheckCircleOutlineRounded />} onClick={() => void mutate(() => personasService.updateWorkItem(detail.persona.id, item.id, { status: 'completed', expectedUpdatedAt: item.updatedAt }))}>{t('personas.work.complete')}</Button>}
                <Button color="error" disabled={busy} onClick={() => { if (window.confirm(`Delete “${item.title}”?`)) void mutate(() => personasService.deleteWorkItem(detail.persona.id, item.id)); }}>{t('personas.work.delete')}</Button>
              </CardActions>
            </Card>
          ))}
        </Box>
      )}
      <WorkItemDialog draft={draft} items={detail.workItems} busy={busy} onChange={setDraft} onClose={() => setDraft(null)} onSave={() => void save()} />
    </AreaShell>
  );
}

function WorkItemDialog({ draft, items, busy, onChange, onClose, onSave }: { draft: WorkDraft | null; items: PersonaWorkItem[]; busy: boolean; onChange: (draft: WorkDraft | null) => void; onClose: () => void; onSave: () => void }) {
  const { t } = useI18n();
  if (!draft) return null;
  const set = <K extends keyof WorkDraft>(key: K, value: WorkDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <Dialog open fullWidth maxWidth="sm" onClose={onClose}>
      <DialogTitle>{draft.id ? t('personas.work.edit') : t('personas.work.new')}</DialogTitle>
      <DialogContent dividers><Stack spacing={2} sx={{ pt: 0.5 }}>
        <TextField label="Title" value={draft.title} onChange={(event) => set('title', event.target.value)} required autoFocus />
        <TextField label="Description" value={draft.description} onChange={(event) => set('description', event.target.value)} multiline minRows={3} />
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <TextField select fullWidth label="Status" value={draft.status} onChange={(event) => set('status', event.target.value as PersonaWorkItemStatus)}>{PERSONA_WORK_ITEM_STATUSES.map((status) => <MenuItem key={status} value={status}>{humanize(status)}</MenuItem>)}</TextField>
          <TextField select fullWidth label="Priority" value={draft.priority} onChange={(event) => set('priority', event.target.value as PersonaPriority)}>{PERSONA_PRIORITIES.map((priority) => <MenuItem key={priority} value={priority}>{humanize(priority)}</MenuItem>)}</TextField>
        </Stack>
        <TextField label={t('personas.work.nextAction')} value={draft.nextAction} onChange={(event) => set('nextAction', event.target.value)} />
        <TextField label="Deadline" type="date" value={draft.deadline} onChange={(event) => set('deadline', event.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <FormControl><InputLabel>{t('personas.work.dependencies')}</InputLabel><Select multiple label={t('personas.work.dependencies')} value={draft.dependencyIds} onChange={(event) => set('dependencyIds', typeof event.target.value === 'string' ? event.target.value.split(',') : event.target.value)}>{items.filter((item) => item.id !== draft.id).map((item) => <MenuItem key={item.id} value={item.id}>{item.title}</MenuItem>)}</Select></FormControl>
      </Stack></DialogContent>
      <DialogActions><Button onClick={onClose}>{t('personas.action.cancel')}</Button><Button variant="contained" disabled={busy || !draft.title.trim()} onClick={onSave}>{t('personas.action.save')}</Button></DialogActions>
    </Dialog>
  );
}

function BehaviorsArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const { t, formatDate } = useI18n();
  if (detail.behaviorBindings.length === 0) return <AreaShell title={t('personas.behaviors.title')} icon={<AutoStoriesRounded />}><Typography color="text.secondary">{t('personas.behaviors.empty')}</Typography></AreaShell>;
  return (
    <AreaShell title={t('personas.behaviors.title')} icon={<AutoStoriesRounded />}>
      <Stack spacing={2}>
        {detail.behaviorBindings.map((binding) => {
          const slot = detail.roleVersion.behaviorSlots.find((candidate) => candidate.key === binding.slotKey);
          const revisions = detail.behaviorRevisions.filter((revision) => revision.behaviorId === binding.id).sort((a, b) => b.revision - a.revision);
          return <Card key={binding.id} variant="outlined" sx={{ borderRadius: 3 }}><CardContent>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}><Box><Typography variant="h6" fontWeight={750}>{slot?.name ?? humanize(binding.slotKey)}</Typography><Typography color="text.secondary">{slot?.description ?? detail.roleVersion.mission}</Typography></Box><Chip color="primary" label={`${t('personas.behaviors.active')} · r${revisions.find((revision) => revision.id === binding.activeRevisionId)?.revision ?? '?'}`} /></Stack>
            <Box sx={{ mt: 2 }}>
              <CardPickerGrid
                columns={{ xs: 12, sm: 12, md: 6 }}
                items={revisions.map((revision) => ({
                  key: revision.id,
                  label: revision.flowSnapshot.name,
                  selected: revision.id === binding.activeRevisionId,
                  content: <BehaviorRevisionRow revision={revision} binding={binding} busy={busy} activate={() => mutate(() => personasService.activateBehavior(detail.persona.id, binding.id, { revisionId: revision.id, expectedActiveRevisionId: binding.activeRevisionId }))} />,
                }))}
              />
            </Box>
          </CardContent></Card>;
        })}
      </Stack>
    </AreaShell>
  );

  function BehaviorRevisionRow({ revision, binding, busy: rowBusy, activate }: { revision: BehaviorRevision; binding: BehaviorBinding; busy: boolean; activate: () => Promise<void> }) {
    const active = revision.id === binding.activeRevisionId;
    const inherited = revision.source.kind === 'role_template';
    return <Stack spacing={1.25} sx={{ height: '100%' }}><FlowCard flow={revision.flowSnapshot} selected={active} pickerMode selectionManaged onSelect={() => {}} /><Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, bgcolor: active ? 'action.selected' : undefined }}><Stack spacing={1}><Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap><Chip size="small" color={active ? 'success' : 'default'} label={`r${revision.revision}${active ? ' · Active' : ''}`} /><Chip size="small" variant="outlined" label={inherited ? t('personas.behaviors.roleDefault') : t('personas.behaviors.override')} /></Stack><Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{t('personas.behaviors.evidence')}: {revision.contentHash} · {formatDate(revision.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}</Typography>{revision.source.kind === 'persona_override' && revision.source.evidenceRefs?.length ? <Typography variant="caption" display="block">{revision.source.evidenceRefs.join(' · ')}</Typography> : null}{!active && <Button disabled={rowBusy} startIcon={<ReplayRounded />} onClick={() => void activate()}>{revision.revision < Math.max(...detail.behaviorRevisions.filter((candidate) => candidate.behaviorId === binding.id).map((candidate) => candidate.revision)) ? t('personas.behaviors.rollback') : t('personas.behaviors.activate')}</Button>}</Stack></Paper></Stack>;
  }
}

function AppsArea({ detail, busy, mutate }: {
  detail: PersonaDetail;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, success?: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [selectedConfig, setSelectedConfig] = useState('');
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const { servers, loading, refreshing, error, refresh } = useMcpAppsDiscovery({ active: true });
  const grantsByServer = new Map(detail.appGrants.map((grant) => [grant.mcpServerName, grant]));
  const availableServers = servers.filter((server) => !grantsByServer.has(server.name));

  useEffect(() => {
    if (selectedConfig && !availableServers.some((server) => server.name === selectedConfig)) {
      setSelectedConfig('');
    }
  }, [availableServers, selectedConfig]);

  const launch = async (grantId: string, uri: string) => {
    const launchKey = `${grantId}:${uri}`;
    setLaunching(launchKey);
    setLaunchError(null);
    try {
      const descriptor = await personasService.authorizeAppLaunch(
        detail.persona.id,
        grantId,
        uri,
      );
      emitLaunchGlobalMcpApp({ serverName: descriptor.mcpServerName, uri: descriptor.uri });
    } catch (cause) {
      setLaunchError(cause instanceof Error ? cause.message : t('personas.apps.launchFailed'));
    } finally {
      setLaunching(null);
    }
  };

  return (
    <AreaShell
      title={t('personas.apps.title')}
      icon={<AppsRounded />}
      action={<Button component={Link} href={withWorkspaceUrl('/mcp')} startIcon={<HubRounded />}>{t('personas.apps.manage')}</Button>}
    >
      <Stack spacing={2.5}>
        <Alert severity="info">{t('personas.apps.description')}</Alert>
        {launchError && <Alert severity="error">{launchError}</Alert>}
        {error && <Alert severity="warning">{error}</Alert>}

        <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
          <CardPickerGrid
            searchable
            stickySearch
            selectionMode="single"
            ariaLabel={t('personas.apps.config')}
            isLoading={loading || refreshing}
            error={error}
            emptyMessage={t('personas.apps.noEligible')}
            columns={{ xs: 12, sm: 6, md: 6 }}
            items={availableServers.map((server) => ({
              key: server.name,
              label: server.name,
              selected: selectedConfig === server.name,
              disabled: busy,
              searchText: `${server.name} ${server.config?.rootPath ?? ''}`,
              onSelect: () => setSelectedConfig(server.name),
              content: (
                <ServerCard
                  name={server.name}
                  status={server.error ? 'error' : 'connected'}
                  path={server.config?.rootPath ?? ''}
                  enabled={server.config ? !server.config.disabled : true}
                  transport={server.config?.transport ?? 'stdio'}
                  pickerMode
                  selectionManaged
                  disabled={busy}
                  selected={selectedConfig === server.name}
                  serverConfig={server.config}
                  onClick={() => {}}
                />
              ),
            }))}
          />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mt: 2 }}>
            <Button
              variant="contained"
              startIcon={<AddRounded />}
              disabled={busy || !selectedConfig}
              onClick={() => void mutate(
                () => personasService.grantApp(detail.persona.id, selectedConfig),
                t('personas.apps.granted'),
              ).then(() => setSelectedConfig(''))}
            >
              {t('personas.apps.grant')}
            </Button>
            <Button startIcon={<RefreshRounded />} disabled={loading || refreshing} onClick={refresh}>
              {t('personas.refresh')}
            </Button>
          </Stack>
        </Paper>

        {detail.appGrants.length === 0 ? (
          <Typography color="text.secondary">{t('personas.apps.empty')}</Typography>
        ) : (
          <Stack spacing={2}>
            {detail.appGrants.map((grant) => {
              const server = servers.find((candidate) => candidate.name === grant.mcpServerName);
              return (
                <Card key={grant.id} variant="outlined" sx={{ borderRadius: 3 }}>
                  <CardContent>
                    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5}>
                      <Box minWidth={0}>
                        <Typography variant="overline" color="text.secondary">
                          {t('personas.apps.account')}
                        </Typography>
                        <Typography variant="h6" fontWeight={760} sx={{ overflowWrap: 'anywhere' }}>
                          {grant.mcpServerName}
                        </Typography>
                      </Box>
                      <Chip color={server && !server.error ? 'success' : 'warning'} label={server && !server.error ? t('personas.apps.available') : t('personas.apps.unavailable')} />
                    </Stack>
                    <Box sx={{ mt: 2 }}>
                      <ServerCard
                        name={grant.mcpServerName}
                        status={!server || server.error ? 'error' : 'connected'}
                        path={server?.config?.rootPath ?? ''}
                        enabled={server?.config ? !server.config.disabled : false}
                        transport={server?.config?.transport ?? 'stdio'}
                        pickerMode
                        selectionManaged
                        disabled={busy}
                        selected
                        serverConfig={server?.config}
                        onClick={() => {}}
                      />
                    </Box>
                    {!server ? (
                      <Alert severity="warning" sx={{ mt: 2 }}>{t('personas.apps.stale')}</Alert>
                    ) : server.error ? (
                      <Alert severity="warning" sx={{ mt: 2 }}>{server.error}</Alert>
                    ) : server.apps.length === 0 ? (
                      <Typography color="text.secondary" sx={{ mt: 2 }}>{t('personas.apps.none')}</Typography>
                    ) : (
                      <Stack spacing={1} sx={{ mt: 2 }}>
                        {server.apps.map((app) => {
                          const launchKey = `${grant.id}:${app.uri}`;
                          return (
                            <Paper key={app.uri} variant="outlined" sx={{ p: 1.5, borderRadius: 2.5 }}>
                              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5} alignItems={{ sm: 'center' }}>
                                <Box minWidth={0}>
                                  <Typography fontWeight={700}>{app.name}</Typography>
                                  <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>{app.uri}</Typography>
                                </Box>
                                <Button
                                  variant="outlined"
                                  startIcon={<OpenInNewRounded />}
                                  disabled={launching !== null}
                                  onClick={() => void launch(grant.id, app.uri)}
                                >
                                  {launching === launchKey ? t('personas.apps.launching') : t('personas.apps.launch')}
                                </Button>
                              </Stack>
                            </Paper>
                          );
                        })}
                      </Stack>
                    )}
                  </CardContent>
                  <CardActions sx={{ flexWrap: 'wrap', gap: 1 }}>
                    {!server ? (
                      <Button component={Link} href={withWorkspaceUrl('/mcp')}>
                        {t('personas.apps.connect')}
                      </Button>
                    ) : server.error ? (
                      <Button disabled={refreshing} onClick={refresh}>
                        {t('personas.retry')}
                      </Button>
                    ) : null}
                    <Button
                      disabled={busy || !selectedConfig}
                      onClick={() => void mutate(
                        () => personasService.replaceApp(
                          detail.persona.id,
                          grant.id,
                          selectedConfig,
                          grant.updatedAt,
                        ),
                        t('personas.apps.switched'),
                      ).then(() => setSelectedConfig(''))}
                    >
                      {t('personas.apps.switch')}
                    </Button>
                    <Button
                      color="error"
                      disabled={busy}
                      onClick={() => void mutate(
                        () => personasService.revokeApp(detail.persona.id, grant.id),
                        t('personas.apps.revoked'),
                      )}
                    >
                      {t('personas.apps.revoke')}
                    </Button>
                  </CardActions>
                </Card>
              );
            })}
          </Stack>
        )}
      </Stack>
    </AreaShell>
  );
}

function ActivityArea({ detail }: { detail: PersonaDetail }) {
  const { t, formatDate } = useI18n();
  const activities = [...detail.activities].sort((a, b) => activityTime(b) - activityTime(a));
  return <AreaShell title={t('personas.activity.title')} icon={<HistoryRounded />}>{activities.length === 0 ? <Typography color="text.secondary">{t('personas.activity.empty')}</Typography> : <Stack divider={<Divider flexItem />}>{activities.map((activity) => <Stack key={activity.id} direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5} sx={{ py: 1.5 }}><Box><Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap><Chip size="small" color={statusColor(activity.status)} label={humanize(activity.status)} /><Chip size="small" variant="outlined" label={humanize(activity.kind)} /><Chip size="small" variant="outlined" label={humanize(activity.source.kind)} /></Stack><Typography fontWeight={700} sx={{ mt: 0.75 }}>{activity.source.sourceId ?? activity.id}</Typography><Typography variant="caption" color="text.secondary">{formatDate(activityTime(activity), { dateStyle: 'medium', timeStyle: 'short' })}{activity.behaviorRevisionId ? ` · revision ${activity.behaviorRevisionId}` : ''}</Typography>{activity.error && <Alert severity="error" sx={{ mt: 1 }}>{activity.error}</Alert>}</Box><Stack direction="row" spacing={1}>{activity.conversationId && <Button component={Link} href={withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: activity.conversationId }))}>{t('personas.talk.open')}</Button>}{activity.meetingId && <Button component={Link} href={withWorkspaceUrl(`/meetings?meeting=${encodeURIComponent(activity.meetingId)}`)}>Meeting</Button>}</Stack></Stack>)}</Stack>}</AreaShell>;
}

function SettingsArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const { t } = useI18n();
  const [form, setForm] = useState(() => ({
    name: detail.persona.name,
    mission: detail.persona.mission ?? '',
    avatarUrl: detail.persona.presentation?.avatarUrl ?? '',
    voice: detail.persona.presentation?.voice ?? '',
    language: detail.persona.presentation?.language ?? '',
    lifecycleState: detail.persona.lifecycleState === 'busy' || detail.persona.lifecycleState === 'waiting' || detail.persona.lifecycleState === 'error' ? 'idle' : detail.persona.lifecycleState,
    autonomyLevel: detail.persona.autonomyLevel,
    interruptionPolicy: detail.persona.interruptionPolicy,
  }));
  useEffect(() => setForm({
    name: detail.persona.name,
    mission: detail.persona.mission ?? '',
    avatarUrl: detail.persona.presentation?.avatarUrl ?? '',
    voice: detail.persona.presentation?.voice ?? '',
    language: detail.persona.presentation?.language ?? '',
    lifecycleState: detail.persona.lifecycleState === 'busy' || detail.persona.lifecycleState === 'waiting' || detail.persona.lifecycleState === 'error' ? 'idle' : detail.persona.lifecycleState,
    autonomyLevel: detail.persona.autonomyLevel,
    interruptionPolicy: detail.persona.interruptionPolicy,
  }), [detail.persona]);
  const set = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  return <AreaShell title={t('personas.settings.title')} icon={<SettingsRounded />}><Stack spacing={2} maxWidth={820}>
    <Alert severity="info">{t('personas.busyHint')}</Alert>
    <TextField label={t('personas.settings.name')} value={form.name} onChange={(event) => set('name', event.target.value)} required />
    <TextField label={t('personas.settings.mission')} value={form.mission} onChange={(event) => set('mission', event.target.value)} multiline minRows={3} />
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}><TextField fullWidth label={t('personas.settings.avatar')} value={form.avatarUrl} onChange={(event) => set('avatarUrl', event.target.value)} /><TextField fullWidth label={t('personas.settings.voice')} value={form.voice} onChange={(event) => set('voice', event.target.value)} /><TextField fullWidth label={t('personas.settings.language')} value={form.language} onChange={(event) => set('language', event.target.value)} /></Stack>
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
      <TextField select fullWidth label={t('personas.settings.lifecycle')} value={form.lifecycleState} onChange={(event) => set('lifecycleState', event.target.value)}>{['idle', 'sleeping', 'disabled'].map((value) => <MenuItem key={value} value={value}>{humanize(value)}</MenuItem>)}</TextField>
      <TextField select fullWidth label={t('personas.settings.autonomy')} value={form.autonomyLevel} onChange={(event) => set('autonomyLevel', event.target.value)}>{PERSONA_AUTONOMY_LEVELS.map((value) => <MenuItem key={value} value={value}>{humanize(value)}</MenuItem>)}</TextField>
      <TextField select fullWidth label={t('personas.settings.interruption')} value={form.interruptionPolicy} onChange={(event) => set('interruptionPolicy', event.target.value)}>{PERSONA_INTERRUPTION_POLICIES.map((value) => <MenuItem key={value} value={value}>{humanize(value)}</MenuItem>)}</TextField>
    </Stack>
    <Box><Button variant="contained" disabled={busy || !form.name.trim()} onClick={() => void mutate(() => personasService.update(detail.persona.id, { name: form.name, mission: form.mission || null, presentation: { avatarUrl: form.avatarUrl || null, voice: form.voice || null, language: form.language || null }, lifecycleState: form.lifecycleState as 'idle' | 'sleeping' | 'disabled', autonomyLevel: form.autonomyLevel, interruptionPolicy: form.interruptionPolicy, expectedUpdatedAt: detail.persona.updatedAt }))}>{t('personas.settings.save')}</Button></Box>
  </Stack></AreaShell>;
}

function CreatePersonaDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (detail: PersonaBundle) => void }) {
  const { t } = useI18n();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [roles, setRoles] = useState<RolesResponse | null>(null);
  const [roleVersionId, setRoleVersionId] = useState('');
  const [appRefs, setAppRefs] = useState<string[]>([]);
  const [appsEdited, setAppsEdited] = useState(false);
  const {
    servers: createAppServers,
    loading: createAppsLoading,
    error: createAppsError,
  } = useMcpAppsDiscovery({ active: open });
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [fact, setFact] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    void personasService.roles().then((result) => {
      setRoles(result);
      setRoleVersionId((current) => current || result.roleVersions[0]?.id || '');
    }).catch((cause) => setError(cause instanceof Error ? cause.message : t('personas.action.failed')));
  }, [open, t]);
  useEffect(() => {
    if (!open || appsEdited) return;
    const role = roles?.roleVersions.find((candidate) => candidate.id === roleVersionId);
    const eligible = new Set(createAppServers.map((server) => server.name));
    setAppRefs((role?.capabilityRequirements?.preferredMcpServers ?? []).filter(
      (name) => eligible.has(name),
    ));
  }, [appsEdited, createAppServers, open, roleVersionId, roles]);
  const toggleCreateApp = (name: string) => {
    setAppsEdited(true);
    setAppRefs((current) => current.includes(name)
      ? current.filter((candidate) => candidate !== name)
      : [...current, name]);
  };
  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true); setError(null);
    try {
      const detail = await personasService.create({
        name: name.trim(),
        ...(roleVersionId ? { roleVersionId } : {}),
        appRefs,
        ...(mission.trim() ? { mission: mission.trim() } : {}),
        idempotencyKey: uuidv4(),
        ...(fact.trim() ? { initialMemories: [{ content: fact.trim() }] } : {}),
      });
      onCreated(detail);
      setName(''); setMission(''); setFact(''); setAppRefs([]); setAppsEdited(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally { setSaving(false); }
  };
  return <Dialog open={open} onClose={saving ? undefined : onClose} fullScreen={fullScreen} fullWidth maxWidth="md"><DialogTitle>{t('personas.create.title')}</DialogTitle><DialogContent dividers><Stack spacing={2} sx={{ pt: 0.5 }}>{error && <Alert severity="error">{error}</Alert>}<TextField label={t('personas.create.name')} value={name} onChange={(event) => setName(event.target.value)} required autoFocus /><Box><Typography variant="subtitle2" sx={{ mb: 1 }}>{t('personas.create.role')}</Typography><CardPickerGrid searchable selectionMode="single" ariaLabel={t('personas.create.role')} isLoading={!roles && !error} emptyMessage={t('cardPicker.empty')} columns={{ xs: 12, sm: 6, md: 6 }} items={(roles?.roleVersions ?? []).map((role) => ({ key: role.id, label: `${role.name} v${role.version}`, selected: roleVersionId === role.id, searchText: `${role.name} ${role.mission} v${role.version}`, onSelect: () => setRoleVersionId(role.id), content: <RoleVersionCard role={role} selected={roleVersionId === role.id} onSelect={() => {}} /> }))} /></Box><Box><Typography variant="subtitle2" sx={{ mb: 1 }}>{t('personas.apps.title')}</Typography>{createAppsError && <Alert severity="warning" sx={{ mb: 1 }}>{createAppsError}</Alert>}<CardPickerGrid searchable selectionMode="multiple" ariaLabel={t('personas.apps.config')} isLoading={createAppsLoading} emptyMessage={t('personas.apps.noEligible')} columns={{ xs: 12, sm: 6, md: 6 }} items={createAppServers.map((server) => ({ key: server.name, label: server.name, selected: appRefs.includes(server.name), searchText: `${server.name} ${server.config?.rootPath ?? ''}`, onSelect: () => toggleCreateApp(server.name), content: <ServerCard name={server.name} status={server.error ? 'error' : 'connected'} path={server.config?.rootPath ?? ''} enabled={server.config ? !server.config.disabled : true} transport={server.config?.transport ?? 'stdio'} pickerMode selectionManaged selected={appRefs.includes(server.name)} serverConfig={server.config} onClick={() => {}} /> }))} /></Box><TextField label={t('personas.create.mission')} value={mission} onChange={(event) => setMission(event.target.value)} multiline minRows={3} /><TextField label={t('personas.create.fact')} helperText={t('personas.create.factHelp')} value={fact} onChange={(event) => setFact(event.target.value)} multiline minRows={2} /></Stack></DialogContent><DialogActions><Button disabled={saving} onClick={onClose}>{t('personas.action.cancel')}</Button><Button variant="contained" disabled={saving || !name.trim() || !roleVersionId} onClick={() => void submit()}>{saving ? t('personas.action.saving') : t('personas.create')}</Button></DialogActions></Dialog>;
}
