"use client";

import {
  AddRounded,
  AppsRounded,
  ArrowBackRounded,
  AssignmentRounded,
  AutoStoriesRounded,
  BoltRounded,
  CallRounded,
  ChatBubbleOutlineRounded,
  CheckCircleOutlineRounded,
  EditRounded,
  HistoryRounded,
  HubRounded,
  MemoryRounded,
  OpenInNewRounded,
  PersonAddRounded,
  PushPinRounded,
  RefreshRounded,
  ReplayRounded,
  SettingsRounded,
  TimelineRounded,
  WorkOutlineRounded,
} from '@mui/icons-material';
import {
  Alert,
  Avatar,
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
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
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
  type MemoryItem,
  type Persona,
  type PersonaActivity,
  type PersonaPriority,
  type PersonaWorkItem,
  type PersonaWorkItemStatus,
} from '@/shared/types/enduringAgent';

const AREAS = [
  'now',
  'talk',
  'work',
  'memory',
  'behaviors',
  'apps',
  'activity',
  'settings',
] as const;
type DeskArea = (typeof AREAS)[number];

const AREA_ICON = {
  now: BoltRounded,
  talk: ChatBubbleOutlineRounded,
  work: WorkOutlineRounded,
  memory: MemoryRounded,
  behaviors: AutoStoriesRounded,
  apps: AppsRounded,
  activity: TimelineRounded,
  settings: SettingsRounded,
} satisfies Record<DeskArea, typeof BoltRounded>;

function isDeskArea(value: string | null): value is DeskArea {
  return value !== null && (AREAS as readonly string[]).includes(value);
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityTime(activity: PersonaActivity): number {
  return activity.completedAt ?? activity.startedAt ?? activity.updatedAt ?? activity.createdAt;
}

function queuedCount(detail?: PersonaDetail): number {
  return detail?.mailboxItems.filter((item) => item.status === 'queued').length ?? 0;
}

function activeActivity(detail?: PersonaDetail): PersonaActivity | undefined {
  const activeId = detail?.runtime?.projection?.active?.activityId;
  return detail?.activities.find((activity) => activity.id === activeId)
    ?? detail?.activities.find((activity) => activity.status === 'running' || activity.status === 'waiting');
}

function candidateMemoryCount(detail?: PersonaDetail): number {
  return detail?.memoryItems.filter((memory) => memory.status === 'candidate').length ?? 0;
}

function lifecycleColor(state: Persona['lifecycleState']): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (state === 'idle') return 'success';
  if (state === 'busy' || state === 'waiting') return 'info';
  if (state === 'error') return 'error';
  if (state === 'sleeping') return 'warning';
  return 'default';
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
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [details, setDetails] = useState<Record<string, PersonaDetail>>({});
  const [selected, setSelected] = useState<PersonaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await personasService.list();
      setPersonas(list);
      if (initialPersonaId) {
        const detail = await personasService.get(initialPersonaId);
        setSelected(detail);
        setDetails((current) => ({ ...current, [detail.persona.id]: detail }));
      } else {
        const settled = await Promise.allSettled(list.map((persona) => personasService.get(persona.id)));
        const next: Record<string, PersonaDetail> = {};
        settled.forEach((result) => {
          if (result.status === 'fulfilled') next[result.value.persona.id] = result.value;
        });
        setDetails(next);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [initialPersonaId, t]);

  useEffect(() => { void load(); }, [load]);

  const refreshSelected = useCallback(async () => {
    if (!initialPersonaId) return;
    const detail = await personasService.get(initialPersonaId);
    setSelected(detail);
    setDetails((current) => ({ ...current, [detail.persona.id]: detail }));
    setPersonas((current) => current.map((persona) => (
      persona.id === detail.persona.id ? detail.persona : persona
    )));
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

  const startConversation = useCallback(async (persona: Persona) => {
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
      {loading ? (
        <Stack alignItems="center" justifyContent="center" minHeight="55vh" spacing={2}>
          <CircularProgress />
          <Typography color="text.secondary">{t('personas.loading')}</Typography>
        </Stack>
      ) : error ? (
        <Alert severity="error" action={<Button onClick={() => void load()}>{t('personas.refresh')}</Button>}>
          {error}
        </Alert>
      ) : initialPersonaId && selected ? (
        <PersonaDetailView
          detail={selected}
          busy={busy}
          mutate={mutate}
          refresh={refreshSelected}
          startConversation={() => startConversation(selected.persona)}
        />
      ) : (
        <PersonaList
          personas={personas}
          details={details}
          busy={busy}
          onCreate={() => setCreateOpen(true)}
          onRefresh={load}
          onChat={startConversation}
        />
      )}
      <CreatePersonaDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(detail) => {
          setCreateOpen(false);
          router.push(withWorkspaceUrl(`/personas/${encodeURIComponent(detail.persona.id)}`));
        }}
      />
    </Container>
  );
}

function PersonaList({
  personas,
  details,
  busy,
  onCreate,
  onRefresh,
  onChat,
}: {
  personas: Persona[];
  details: Record<string, PersonaDetail>;
  busy: boolean;
  onCreate: () => void;
  onRefresh: () => Promise<void>;
  onChat: (persona: Persona) => Promise<void>;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: { xs: 'flex-start', md: 'center' }, justifyContent: 'space-between', gap: 2, flexDirection: { xs: 'column', md: 'row' } }}>
        <Box>
          <Typography variant="overline" color="primary.main" fontWeight={800}>{t('personas.eyebrow')}</Typography>
          <Typography variant="h3" component="h1" sx={{ fontWeight: 780, letterSpacing: '-0.045em' }}>{t('personas.title')}</Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 760, mt: 1 }}>{t('personas.description')}</Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<RefreshRounded />} onClick={() => void onRefresh()} disabled={busy}>{t('personas.refresh')}</Button>
          <Button variant="contained" startIcon={<PersonAddRounded />} onClick={onCreate}>{t('personas.create')}</Button>
        </Stack>
      </Box>
      {personas.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 6, textAlign: 'center', borderRadius: 4 }}>
          <Avatar sx={{ width: 64, height: 64, mx: 'auto', mb: 2, bgcolor: alpha(theme.palette.primary.main, 0.15), color: 'primary.main' }}><PersonAddRounded /></Avatar>
          <Typography variant="h5" fontWeight={750}>{t('personas.empty')}</Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 520, mx: 'auto', my: 1.5 }}>{t('personas.emptyHelp')}</Typography>
          <Button variant="contained" startIcon={<AddRounded />} onClick={onCreate}>{t('personas.create')}</Button>
        </Paper>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
          {personas.map((persona) => {
            const detail = details[persona.id];
            const active = activeActivity(detail);
            return (
              <Card key={persona.id} variant="outlined" sx={{ borderRadius: 4, overflow: 'visible', display: 'flex', flexDirection: 'column', minHeight: 290 }}>
                <CardContent sx={{ flex: 1 }}>
                  <Stack direction="row" spacing={2} alignItems="flex-start">
                    <Avatar src={persona.presentation?.avatarUrl} alt={persona.name} sx={{ width: 58, height: 58, bgcolor: alpha(theme.palette.primary.main, 0.18), color: 'primary.main', fontWeight: 800 }}>
                      {persona.name.slice(0, 2).toUpperCase()}
                    </Avatar>
                    <Box minWidth={0} flex={1}>
                      <Typography variant="h5" fontWeight={760} noWrap>{persona.name}</Typography>
                      <Typography variant="body2" color="text.secondary" noWrap>
                        {detail ? t('personas.role', { role: detail.roleVersion.name, version: detail.roleVersion.version }) : t('common.loading')}
                      </Typography>
                    </Box>
                    <Chip size="small" color={lifecycleColor(persona.lifecycleState)} label={humanize(persona.lifecycleState)} />
                  </Stack>
                  <Typography color="text.secondary" sx={{ my: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', minHeight: 48 }}>
                    {persona.mission}
                  </Typography>
                  <Stack spacing={1.25}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <BoltRounded fontSize="small" color={active ? 'primary' : 'disabled'} />
                      <Typography variant="body2" fontWeight={650} noWrap>{active ? `${humanize(active.kind)} · ${humanize(active.status)}` : t('personas.noActivity')}</Typography>
                    </Box>
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      <Chip size="small" icon={<AssignmentRounded />} label={t('personas.queue', { count: queuedCount(detail) })} />
                      <Chip size="small" color={candidateMemoryCount(detail) ? 'warning' : 'default'} icon={<MemoryRounded />} label={t('personas.memoryHealth', { count: candidateMemoryCount(detail) })} />
                    </Stack>
                  </Stack>
                </CardContent>
                <Divider />
                <CardActions sx={{ px: 2, py: 1.5 }}>
                  <Button component={Link} href={withWorkspaceUrl(`/personas/${encodeURIComponent(persona.id)}`)} size="small">{t('personas.openDesk')}</Button>
                  <Button size="small" startIcon={<ChatBubbleOutlineRounded />} onClick={() => void onChat(persona)} disabled={busy || persona.lifecycleState === 'disabled' || persona.lifecycleState === 'error'}>{t('personas.chat')}</Button>
                  <Button component={Link} href={withWorkspaceUrl(`/personas/${encodeURIComponent(persona.id)}?area=work`)} size="small">{t('personas.assign')}</Button>
                  <Tooltip title={t('personas.callDeferred')}><span><Button size="small" disabled startIcon={<CallRounded />}>{t('personas.call')}</Button></span></Tooltip>
                </CardActions>
              </Card>
            );
          })}
        </Box>
      )}
    </Stack>
  );
}

function PersonaDetailView({
  detail,
  busy,
  mutate,
  refresh,
  startConversation,
}: {
  detail: PersonaDetail;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, success?: string) => Promise<void>;
  refresh: () => Promise<void>;
  startConversation: () => Promise<void>;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const theme = useTheme();
  const [area, setArea] = useState<DeskArea>('now');

  useEffect(() => {
    const requested = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('area');
    if (isDeskArea(requested)) setArea(requested);
  }, [detail.persona.id]);

  const selectArea = (next: DeskArea) => {
    setArea(next);
    router.replace(withWorkspaceUrl(`/personas/${encodeURIComponent(detail.persona.id)}?area=${next}`));
  };

  return (
    <Stack spacing={2.5}>
      <Button component={Link} href={withWorkspaceUrl('/personas')} startIcon={<ArrowBackRounded />} sx={{ alignSelf: 'flex-start' }}>{t('personas.back')}</Button>
      <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4, background: `linear-gradient(135deg, ${alpha(theme.palette.primary.main, 0.12)}, ${alpha(theme.palette.background.paper, 0.92)} 48%, ${alpha(theme.palette.secondary.main, 0.08)})` }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2.5} alignItems={{ xs: 'flex-start', sm: 'center' }}>
          <Avatar src={detail.persona.presentation?.avatarUrl} sx={{ width: 76, height: 76, bgcolor: alpha(theme.palette.primary.main, 0.2), color: 'primary.main', fontSize: 26, fontWeight: 800 }}>
            {detail.persona.name.slice(0, 2).toUpperCase()}
          </Avatar>
          <Box flex={1} minWidth={0}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <Typography variant="h3" component="h1" fontWeight={790} letterSpacing="-0.045em">{detail.persona.name}</Typography>
              <Chip color={lifecycleColor(detail.persona.lifecycleState)} label={humanize(detail.persona.lifecycleState)} />
            </Stack>
            <Typography color="text.secondary" fontWeight={650}>{t('personas.role', { role: detail.roleVersion.name, version: detail.roleVersion.version })}</Typography>
            <Typography sx={{ mt: 0.75, maxWidth: 900 }}>{detail.persona.mission}</Typography>
          </Box>
          <Button variant="contained" startIcon={<ChatBubbleOutlineRounded />} onClick={() => void startConversation()} disabled={busy || detail.persona.lifecycleState === 'disabled' || detail.persona.lifecycleState === 'error'}>{t('personas.chat')}</Button>
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
        <Tabs value={area} onChange={(_event, value: DeskArea) => selectArea(value)} variant="scrollable" scrollButtons="auto" aria-label="Persona desk areas">
          {AREAS.map((key) => {
            const Icon = AREA_ICON[key];
            return <Tab key={key} value={key} icon={<Icon fontSize="small" />} iconPosition="start" label={t(`personas.area.${key}`)} />;
          })}
        </Tabs>
      </Paper>
      {area === 'now' && <NowArea detail={detail} busy={busy} mutate={mutate} />}
      {area === 'talk' && <TalkArea detail={detail} busy={busy} startConversation={startConversation} />}
      {area === 'work' && <WorkArea detail={detail} busy={busy} mutate={mutate} />}
      {area === 'memory' && <MemoryArea detail={detail} busy={busy} mutate={mutate} />}
      {area === 'behaviors' && <BehaviorsArea detail={detail} busy={busy} mutate={mutate} />}
      {area === 'apps' && <AppsArea detail={detail} busy={busy} mutate={mutate} />}
      {area === 'activity' && <ActivityArea detail={detail} />}
      {area === 'settings' && <SettingsArea detail={detail} busy={busy} mutate={mutate} />}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}><Button startIcon={<RefreshRounded />} onClick={() => void refresh()} disabled={busy}>{t('personas.refresh')}</Button></Box>
    </Stack>
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

function MemoryArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const { t, formatDate } = useI18n();
  const [query, setQuery] = useState('');
  const [correction, setCorrection] = useState<MemoryItem | null>(null);
  const [content, setContent] = useState('');
  const coreIds = new Set(detail.persona.coreMemoryItemIds ?? []);
  const memories = detail.memoryItems.filter((memory) => memory.content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt);
  const groups = ['candidate', 'active', 'superseded', 'forgotten'] as const;
  return (
    <AreaShell title={t('personas.memory.title')} icon={<MemoryRounded />} action={<TextField size="small" label={t('personas.memory.search')} value={query} onChange={(event) => setQuery(event.target.value)} />}>
      {memories.length === 0 ? <Typography color="text.secondary">{t('personas.memory.empty')}</Typography> : (
        <Stack spacing={3}>
          {groups.map((status) => {
            const items = memories.filter((memory) => memory.status === status);
            if (items.length === 0) return null;
            return <Box key={status}><Typography variant="overline" color="text.secondary" fontWeight={800}>{status === 'candidate' ? 'Proposed' : humanize(status)} · {items.length}</Typography><Stack spacing={1.25} sx={{ mt: 0.75 }}>{items.map((memory) => {
              const core = coreIds.has(memory.id);
              const canPin = memory.status === 'active' && (memory.trust === 'explicit_user' || memory.trust === 'verified_tool');
              return <Card key={memory.id} variant="outlined" sx={{ borderRadius: 3 }}><CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}><Typography sx={{ whiteSpace: 'pre-wrap' }}>{memory.content}</Typography><Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap justifyContent="flex-end"><Chip size="small" color={statusColor(memory.status)} label={humanize(memory.status)} />{core && <Chip size="small" color="primary" icon={<PushPinRounded />} label={t('personas.memory.core')} />}</Stack></Stack>
                <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}><Chip size="small" variant="outlined" label={humanize(memory.kind)} /><Chip size="small" variant="outlined" label={humanize(memory.scope)} /><Chip size="small" variant="outlined" label={humanize(memory.trust)} /><Chip size="small" variant="outlined" label={`Confidence ${Math.round(memory.confidence * 100)}%`} /></Stack>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{t('personas.memory.sources')}: {memory.sourceRefs.map((source) => `${humanize(source.kind)} · ${source.id}`).join(' | ')}</Typography>
                <Typography variant="caption" color="text.secondary">Updated {formatDate(memory.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })}</Typography>
              </CardContent><CardActions>
                {memory.status === 'candidate' && <Button disabled={busy} onClick={() => void mutate(() => personasService.activateMemory(detail.persona.id, memory.id))}>{t('personas.memory.activate')}</Button>}
                {memory.status !== 'forgotten' && <Button startIcon={<EditRounded />} onClick={() => { setCorrection(memory); setContent(memory.content); }}>{t('personas.memory.correct')}</Button>}
                {memory.status !== 'forgotten' && <Button color="error" disabled={busy} onClick={() => { if (window.confirm('Forget this memory?')) void mutate(() => personasService.forgetMemory(detail.persona.id, memory.id)); }}>{t('personas.memory.forget')}</Button>}
                {canPin && <Button disabled={busy} startIcon={<PushPinRounded />} onClick={() => void mutate(() => personasService.pinMemory(detail.persona.id, memory.id, !core))}>{core ? t('personas.memory.unpin') : t('personas.memory.pin')}</Button>}
              </CardActions></Card>;
            })}</Stack></Box>;
          })}
        </Stack>
      )}
      <Dialog open={Boolean(correction)} onClose={() => setCorrection(null)} fullWidth maxWidth="sm"><DialogTitle>{t('personas.memory.correct')}</DialogTitle><DialogContent dividers><TextField fullWidth multiline minRows={5} value={content} onChange={(event) => setContent(event.target.value)} /></DialogContent><DialogActions><Button onClick={() => setCorrection(null)}>{t('personas.action.cancel')}</Button><Button variant="contained" disabled={busy || !content.trim()} onClick={() => { if (!correction) return; void mutate(() => personasService.correctMemory(detail.persona.id, correction, content)).then(() => setCorrection(null)); }}>{t('personas.action.save')}</Button></DialogActions></Dialog>
    </AreaShell>
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
                  <CardActions>
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
  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true); setError(null);
    try {
      const detail = await personasService.create({
        name: name.trim(),
        ...(roleVersionId ? { roleVersionId } : {}),
        ...(mission.trim() ? { mission: mission.trim() } : {}),
        idempotencyKey: uuidv4(),
        ...(fact.trim() ? { initialMemories: [{ content: fact.trim() }] } : {}),
      });
      onCreated(detail);
      setName(''); setMission(''); setFact('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally { setSaving(false); }
  };
  return <Dialog open={open} onClose={saving ? undefined : onClose} fullScreen={fullScreen} fullWidth maxWidth="md"><DialogTitle>{t('personas.create.title')}</DialogTitle><DialogContent dividers><Stack spacing={2} sx={{ pt: 0.5 }}>{error && <Alert severity="error">{error}</Alert>}<TextField label={t('personas.create.name')} value={name} onChange={(event) => setName(event.target.value)} required autoFocus /><Box><Typography variant="subtitle2" sx={{ mb: 1 }}>{t('personas.create.role')}</Typography><CardPickerGrid searchable selectionMode="single" ariaLabel={t('personas.create.role')} isLoading={!roles && !error} emptyMessage={t('cardPicker.empty')} columns={{ xs: 12, sm: 6, md: 6 }} items={(roles?.roleVersions ?? []).map((role) => ({ key: role.id, label: `${role.name} v${role.version}`, selected: roleVersionId === role.id, searchText: `${role.name} ${role.mission} v${role.version}`, onSelect: () => setRoleVersionId(role.id), content: <RoleVersionCard role={role} selected={roleVersionId === role.id} onSelect={() => {}} /> }))} /></Box><TextField label={t('personas.create.mission')} value={mission} onChange={(event) => setMission(event.target.value)} multiline minRows={3} /><TextField label={t('personas.create.fact')} helperText={t('personas.create.factHelp')} value={fact} onChange={(event) => setFact(event.target.value)} multiline minRows={2} /></Stack></DialogContent><DialogActions><Button disabled={saving} onClick={onClose}>{t('personas.action.cancel')}</Button><Button variant="contained" disabled={saving || !name.trim() || !roleVersionId} onClick={() => void submit()}>{saving ? t('personas.action.saving') : t('personas.create')}</Button></DialogActions></Dialog>;
}
