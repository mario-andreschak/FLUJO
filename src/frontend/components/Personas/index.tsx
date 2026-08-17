"use client";

import {
  AddRounded,
  AppsRounded,
  ArrowDownwardRounded,
  ArrowUpwardRounded,
  AssignmentRounded,
  AutoAwesomeRounded,
  BoltRounded,
  ChatBubbleOutlineRounded,
  CheckCircleOutlineRounded,
  DeleteOutlineRounded,
  EditRounded,
  HistoryRounded,
  HubRounded,
  LightbulbOutlined,
  OpenInNewRounded,
  PauseCircleOutlineRounded,
  RefreshRounded,
  ReplayRounded,
  StopCircleRounded,
  TuneRounded,
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
} from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import ServerCard from '@/frontend/components/mcp/MCPServerManager/ServerCard';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
import CardPickerGrid from '@/frontend/components/shared/CardPickerGrid';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';
import PersonaCreationWizard from './PersonaCreationWizard';
import PersonaAppToolsDialog from './PersonaAppToolsDialog';
import PersonaDetailShell from './PersonaDetailShell';
import PersonaFlowsArea from './PersonaFlowsArea';
import PersonaMemoryArea from './PersonaMemoryArea';
import PersonaImprovementsArea from './PersonaImprovementsArea';
import PersonaSetup from './PersonaSetup';
import PersonaSettings from './settings/PersonaSettings';
import PersonasGallery from './PersonasGallery';
import { invalidatePersonaSummaryCache } from './personaQueries';
import {
  personasService,
  type PersonaDetail,
  type PersonaExecutionPreview,
} from '@/frontend/services/personas';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import { emitLaunchGlobalMcpApp } from '@/frontend/utils/quickActions';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';
import {
  PERSONA_PRIORITIES,
  type PersonaCreationDraft,
  type PersonaHistoryEntry,
  type PersonaPresentationOutcome,
  type PersonaPriority,
  type PersonaTaskSummary,
  type PersonaWorkItem,
} from '@/shared/types/enduringAgent';

const PERSONA_OUTCOME_KEYS = {
  queued: 'personas.outcome.queued',
  working: 'personas.outcome.working',
  waiting: 'personas.outcome.waiting',
  completed: 'personas.outcome.completed',
  cancelled: 'personas.outcome.cancelled',
  needs_attention: 'personas.outcome.needs_attention',
} satisfies Record<PersonaPresentationOutcome, TranslationKey>;

const PERSONA_LEASE_STATUS_KEYS = {
  none: 'personas.now.leaseStatus.none',
  active: 'personas.now.leaseStatus.active',
  released: 'personas.now.leaseStatus.released',
  expired: 'personas.now.leaseStatus.expired',
} satisfies Record<
  PersonaDetail['runtime']['projection']['leaseStatus'],
  TranslationKey
>;

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary' {
  if (status === 'completed' || status === 'active' || status === 'ready') return 'success';
  if (status === 'error' || status === 'forgotten' || status === 'cancelled' || status === 'overdue' || status === 'needs_attention') return 'error';
  if (status === 'candidate' || status === 'waiting' || status === 'blocked' || status === 'queued') return 'warning';
  if (status === 'running' || status === 'in_progress' || status === 'working') return 'info';
  if (status === 'superseded') return 'default';
  return 'primary';
}

interface PersonasDeskProps {
  initialPersonaId?: string;
}

export default function PersonasDesk({ initialPersonaId }: PersonasDeskProps) {
  const { t, formatDate } = useI18n();
  const router = useRouter();
  const [selected, setSelected] = useState<PersonaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [drafts, setDrafts] = useState<PersonaCreationDraft[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [resumeDraft, setResumeDraft] = useState<PersonaCreationDraft | null>(null);
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

  const loadDrafts = useCallback(async () => {
    if (initialPersonaId) return;
    setDraftsLoading(true);
    setDraftsError(null);
    try {
      setDrafts(await personasService.listDrafts());
    } catch (cause) {
      setDraftsError(cause instanceof Error ? cause.message : t('personas.create.draftsLoadFailed'));
    } finally {
      setDraftsLoading(false);
    }
  }, [initialPersonaId, t]);

  useEffect(() => { void loadDrafts(); }, [loadDrafts]);

  const discardDraft = useCallback(async (draft: PersonaCreationDraft) => {
    setBusy(true);
    setActionError(null);
    try {
      await personasService.deleteDraft(draft.id, { expectedRevision: draft.revision });
      setDrafts((current) => current.filter((candidate) => candidate.id !== draft.id));
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('personas.create.draftDiscardFailed'));
      await loadDrafts();
    } finally {
      setBusy(false);
    }
  }, [loadDrafts, t]);

  const refreshSelected = useCallback(async () => {
    if (!initialPersonaId) return;
    setSelected(await personasService.get(initialPersonaId));
    invalidatePersonaSummaryCache();
  }, [initialPersonaId]);

  useEffect(() => {
    if (!initialPersonaId || !selected) return;
    const shouldRefresh = selected.persona.lifecycleState === 'busy'
      || selected.persona.lifecycleState === 'waiting'
      || selected.runtime.projection.mailbox.ready > 0
      || selected.runtime.projection.mailbox.queued > 0;
    if (!shouldRefresh) return;
    const timer = window.setInterval(() => {
      void refreshSelected().catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [
    initialPersonaId,
    refreshSelected,
    selected,
  ]);

  const mutate = useCallback(async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await action();
      await refreshSelected();
      if (success) setNotice(success);
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('personas.action.failed'));
      await refreshSelected().catch(() => undefined);
      return false;
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
                    <PersonaFlowsArea detail={selected} onChanged={refreshSelected} />
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
              {area === 'improvements' && (
                <PersonaImprovementsArea detail={selected} />
              )}
              {area === 'settings' && subsection === 'history' && (
                <ActivityArea detail={selected} />
              )}
              {area === 'settings' && subsection !== 'history' && (
                <PersonaSettings
                  detail={selected}
                  onRefresh={refreshSelected}
                  onDeleted={() => {
                    setSelected(null);
                    invalidatePersonaSummaryCache();
                    router.push(withWorkspaceUrl('/personas'));
                  }}
                />
              )}
            </>
          )}
        />
      ) : (
        <Stack spacing={3}>
          {(draftsLoading || draftsError || drafts.length > 0) && (
            <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 4 }}>
              <Stack spacing={2}>
                <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
                  <Box>
                    <Typography variant="h6" fontWeight={760}>{t('personas.create.savedDrafts')}</Typography>
                    <Typography color="text.secondary">{t('personas.create.savedDraftsHelp')}</Typography>
                  </Box>
                  <Button disabled={draftsLoading} startIcon={<RefreshRounded />} onClick={() => void loadDrafts()}>
                    {t('personas.refresh')}
                  </Button>
                </Stack>
                {draftsLoading && <LinearProgress />}
                {draftsError && <Alert severity="warning">{draftsError}</Alert>}
                {drafts.map((item) => (
                  <Paper key={item.id} variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={2}>
                      <Box>
                        <Typography fontWeight={720}>
                          {item.payload.name.trim() || t('personas.create.untitledDraft')}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {t('personas.create.draftUpdated', {
                            date: formatDate(item.updatedAt, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }),
                          })}
                        </Typography>
                      </Box>
                      <Stack direction="row" spacing={1}>
                        <Button
                          startIcon={<EditRounded />}
                          onClick={() => {
                            setResumeDraft(item);
                            setCreateOpen(true);
                          }}
                        >
                          {t('personas.create.resumeDraft')}
                        </Button>
                        <Button
                          color="error"
                          startIcon={<DeleteOutlineRounded />}
                          disabled={busy}
                          onClick={() => void discardDraft(item)}
                        >
                          {t('personas.create.discardDraft')}
                        </Button>
                      </Stack>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            </Paper>
          )}
          <PersonasGallery
            busy={busy}
            onCreate={() => {
              setResumeDraft(null);
              setCreateOpen(true);
            }}
            onTalk={startConversation}
          />
        </Stack>
      )}
      <PersonaCreationWizard
        open={createOpen}
        draft={resumeDraft}
        onClose={() => {
          setCreateOpen(false);
          setResumeDraft(null);
        }}
        onDraftSaved={(saved) => {
          setNotice(t('personas.create.draftSaved'));
          setDrafts((current) => [
            saved,
            ...current.filter((candidate) => candidate.id !== saved.id),
          ]);
          setCreateOpen(false);
          setResumeDraft(null);
        }}
        onDraftDiscarded={(draftId) => {
          setDrafts((current) => current.filter((candidate) => candidate.id !== draftId));
          setResumeDraft(null);
        }}
        onCreated={(detail) => {
          setCreateOpen(false);
          setResumeDraft(null);
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



function NowArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const { t, formatDate } = useI18n();
  const current = detail.presentation.current;
  const queuedTasks = detail.presentation.tasks.filter((task) => task.state === 'waiting');
  const activeTask = detail.presentation.tasks.find((task) => task.state === 'in_progress')
    ?? queuedTasks[0];
  const activeWorkItem = activeTask
    ? detail.workItems.find((item) => item.id === activeTask.id)
    : undefined;
  const needsYou = detail.presentation.tasks.filter((task) => (
    task.state === 'blocked' || task.state === 'overdue'
  ));
  const completed = detail.presentation.tasks.filter((task) => task.state === 'completed').slice(0, 3);
  const recentMemories = [...detail.memoryItems]
    .filter((memory) => memory.status === 'candidate' || memory.status === 'active')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3);
  const runtime = detail.runtime;
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [priority, setPriority] = useState<PersonaPriority>('normal');
  const [preview, setPreview] = useState<PersonaExecutionPreview | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useEffect(() => {
    let active = true;
    setPreviewError(false);
    void personasService.executionPreview(detail.persona.id)
      .then((value) => { if (active) setPreview(value); })
      .catch(() => { if (active) setPreviewError(true); });
    return () => { active = false; };
  }, [detail.persona.id, detail.persona.updatedAt]);

  const actionableRecovery = runtime.projection.stuck && (
    runtime.detectedStuckIndicators.length > 0
    || runtime.reconciliation.remainingStuck
    || runtime.projection.leaseStatus === 'expired'
    || runtime.projection.leaseStatus === 'active'
  );
  const giveGoal = async () => {
    if (!goal.trim()) return;
    await mutate(async () => {
      const created = await personasService.createWorkItem(detail.persona.id, {
        title: goal.trim(),
        ...(context.trim() ? { description: context.trim() } : {}),
        priority,
        dependencyIds: [],
      });
      await personasService.assignWorkItem(detail.persona.id, created.id, {
        expectedUpdatedAt: created.updatedAt,
        idempotencyKey: uuidv4(),
      });
    }, t('personas.goal.queued'));
    setGoalOpen(false);
    setGoal('');
    setContext('');
    setPriority('normal');
  };
  const memoryRecall = preview?.nativeAbilities.includes('recall') ?? false;
  const memoryChanges = preview?.nativeAbilities.some((ability) => (
    ['remember', 'correct', 'forget', 'pin', 'unpin'] as string[]
  ).includes(ability)) ?? false;
  const workAbilities = preview?.nativeAbilities.some((ability) => ability.startsWith('work_item_'))
    ?? false;
  const improvementAbility = preview?.nativeAbilities.includes('suggest_improvement') ?? false;
  const everydayAbilityNeedsSetup = preview !== null && (
    (!memoryRecall && !memoryChanges)
    || !workAbilities
    || !improvementAbility
  );
  return (
    <Stack spacing={2}>
      {runtime.projection.stuck && (
        <Alert
          severity="warning"
          action={actionableRecovery ? (
            <Button
              disabled={busy}
              onClick={() => void mutate(() => personasService.recoverRuntime(detail.persona.id))}
            >
              {t('personas.now.recover')}
            </Button>
          ) : undefined}
        >
          <Stack spacing={0.5}>
            <Typography>{t('personas.now.stuck')}</Typography>
            <Typography variant="body2">{t('personas.now.stuckHelp')}</Typography>
            <Box component="details" sx={{ mt: 0.5 }}>
              <Box component="summary" sx={{ cursor: 'pointer' }}>{t('personas.history.advanced')}</Box>
              {runtime.detectedStuckIndicators.map((indicator) => (
                <Typography key={indicator} variant="body2">{indicator}</Typography>
              ))}
              <Typography variant="body2">
                {t('personas.now.runtimeState', {
                  status: t(PERSONA_LEASE_STATUS_KEYS[runtime.projection.leaseStatus]),
                  queued: runtime.projection.mailbox.queued,
                  ready: runtime.projection.mailbox.ready,
                })}
              </Typography>
              <Typography variant="body2">
                {t('personas.now.reconciliation', {
                  attempted: runtime.reconciliation.attempted ? 'yes' : 'no',
                  changed: runtime.reconciliation.changed ? 'yes' : 'no',
                  remaining: runtime.reconciliation.remainingStuck ? 'yes' : 'no',
                })}
              </Typography>
            </Box>
          </Stack>
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 2, md: 3 },
          borderRadius: 4,
          bgcolor: 'primary.main',
          color: 'primary.contrastText',
        }}
      >
        <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={2} alignItems={{ md: 'center' }}>
          <Box>
            <Typography variant="h4" fontWeight={790}>{t('personas.goal.title')}</Typography>
            <Typography sx={{ opacity: 0.86, mt: 0.5 }}>{t('personas.goal.help')}</Typography>
          </Box>
          <Button
            variant="contained"
            color="inherit"
            startIcon={<AssignmentRounded />}
            disabled={busy || detail.persona.lifecycleState === 'disabled'}
            onClick={() => setGoalOpen(true)}
            sx={{ color: 'primary.main', flexShrink: 0 }}
          >
            {t('personas.goal.action')}
          </Button>
        </Stack>
      </Paper>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.25fr) minmax(320px, .75fr)' }, gap: 2 }}>
        <AreaShell title={t('personas.now.title')} icon={<BoltRounded />}>
          {current || activeTask ? (
            <Stack spacing={1.25}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {current && <Chip color={statusColor(current.outcome)} label={t(PERSONA_OUTCOME_KEYS[current.outcome])} />}
                {activeTask && <Chip variant="outlined" label={t(`personas.priority.${activeTask.priority}`)} />}
              </Stack>
              <Typography variant="h6" fontWeight={740}>
                {activeTask?.title ?? current?.summary}
              </Typography>
              {activeTask?.description && <Typography color="text.secondary">{activeTask.description}</Typography>}
              {activeTask?.nextAction && (
                <Typography variant="body2"><strong>{t('personas.tasks.nextAction')}:</strong> {activeTask.nextAction}</Typography>
              )}
              {current && (
                <Typography color="text.secondary">
                  {t('personas.history.when', { date: formatDate(current.occurredAt, { dateStyle: 'medium', timeStyle: 'short' }) })}
                </Typography>
              )}
              {activeWorkItem && (
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    color="inherit"
                    disabled={busy}
                    startIcon={<PauseCircleOutlineRounded />}
                    onClick={() => void mutate(
                      () => personasService.controlWorkItem(detail.persona.id, activeWorkItem.id, 'pause'),
                      t('personas.tasks.paused'),
                    )}
                  >
                    {t('personas.tasks.pause')}
                  </Button>
                  <Button
                    color="inherit"
                    disabled={busy}
                    startIcon={<StopCircleRounded />}
                    onClick={() => void mutate(
                      () => personasService.controlWorkItem(detail.persona.id, activeWorkItem.id, 'stop'),
                      t('personas.tasks.stopped'),
                    )}
                  >
                    {t('personas.tasks.stop')}
                  </Button>
                </Stack>
              )}
            </Stack>
          ) : <Typography color="text.secondary">{t('personas.now.empty')}</Typography>}
        </AreaShell>
        <AreaShell title={t('personas.now.upNext')} icon={<AssignmentRounded />}>
          {queuedTasks.length === 0 && detail.presentation.queuedInputCount === 0 ? (
            <Typography color="text.secondary">{t('personas.now.nothingQueued')}</Typography>
          ) : (
            <Stack spacing={1.25}>
              {queuedTasks.map((task) => (
                <Stack key={task.id} direction="row" justifyContent="space-between" gap={1}>
                  <Typography fontWeight={700}>{task.title}</Typography>
                  <Chip size="small" label={t('personas.taskState.waiting')} />
                </Stack>
              ))}
              {detail.presentation.queuedInputCount > 0 && (
                <Typography color="text.secondary">{t('personas.conversations.queuedInput', { count: detail.presentation.queuedInputCount })}</Typography>
              )}
            </Stack>
          )}
        </AreaShell>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
        <AreaShell title={t('personas.home.needsYou')} icon={<AssignmentRounded />}>
          {needsYou.length === 0 ? (
            <Typography color="text.secondary">{t('personas.home.noNeeds')}</Typography>
          ) : (
            <Stack spacing={1}>
              {needsYou.map((task) => (
                <Box key={task.id}>
                  <Typography fontWeight={720}>{task.title}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {task.state === 'blocked'
                      ? t('personas.home.blocked', { count: task.blockerTitles.length })
                      : t('personas.home.overdue')}
                  </Typography>
                  {task.state === 'blocked' && task.blockerTitles.length === 0 && (
                    <Button
                      size="small"
                      disabled={busy}
                      startIcon={<ReplayRounded />}
                      onClick={() => void mutate(
                        () => personasService.controlWorkItem(detail.persona.id, task.id, 'retry'),
                        t('personas.tasks.restarted'),
                      )}
                      sx={{ mt: 0.5 }}
                    >
                      {t('personas.tasks.resumeRetry')}
                    </Button>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </AreaShell>
        <AreaShell title={t('personas.home.learned')} icon={<LightbulbOutlined />}>
          {recentMemories.length === 0 ? (
            <Typography color="text.secondary">{t('personas.home.noLearning')}</Typography>
          ) : (
            <Stack spacing={1}>
              {recentMemories.map((memory) => (
                <Box key={memory.id}>
                  <Typography variant="body2" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {memory.content}
                  </Typography>
                  <Chip
                    size="small"
                    color={memory.status === 'candidate' ? 'warning' : 'success'}
                    label={memory.status === 'candidate'
                      ? t('personas.memory.needsReview')
                      : t('personas.memory.remembered')}
                    sx={{ mt: 0.5 }}
                  />
                </Box>
              ))}
              <Button component={Link} href={withWorkspaceUrl(`/personas/${encodeURIComponent(detail.persona.id)}?area=memory`)}>
                {t('personas.home.openMemory')}
              </Button>
            </Stack>
          )}
        </AreaShell>
        <AreaShell title={t('personas.home.done')} icon={<CheckCircleOutlineRounded />}>
          {completed.length === 0 ? (
            <Typography color="text.secondary">{t('personas.home.nothingDone')}</Typography>
          ) : (
            <Stack spacing={1}>{completed.map((task) => (
              <Box key={task.id}>
                <Typography fontWeight={720}>{task.title}</Typography>
                {task.resultSummary && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mt: 0.25, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                  >
                    {task.resultSummary}
                  </Typography>
                )}
                {task.completedAt && (
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(task.completedAt, { dateStyle: 'medium' })}
                  </Typography>
                )}
                {task.recordLinks && task.recordLinks.length > 0 && (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                    {task.recordLinks.map((link) => link.kind === 'conversation' ? (
                      <Button
                        key={`${link.kind}:${link.id}`}
                        size="small"
                        component={Link}
                        href={withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: link.id }))}
                      >
                        {t('personas.talk.open')}
                      </Button>
                    ) : (
                      <Button
                        key={`${link.kind}:${link.id}`}
                        size="small"
                        component={Link}
                        href={withWorkspaceUrl(`/meetings?meeting=${encodeURIComponent(link.id)}`)}
                      >
                        {t('personas.history.openMeeting')}
                      </Button>
                    ))}
                  </Stack>
                )}
              </Box>
            ))}</Stack>
          )}
        </AreaShell>
      </Box>
      <AreaShell
        title={t('personas.capabilities.title')}
        icon={<AutoAwesomeRounded />}
        action={(
          <Button component={Link} href={withWorkspaceUrl(`/personas/${encodeURIComponent(detail.persona.id)}?area=setup&section=behaviors`)}>
            {t('personas.capabilities.change')}
          </Button>
        )}
      >
        {previewError ? (
          <Alert severity="warning">{t('personas.capabilities.unavailable')}</Alert>
        ) : !preview ? (
          <Stack direction="row" alignItems="center" spacing={1}><CircularProgress size={18} /><Typography color="text.secondary">{t('personas.capabilities.loading')}</Typography></Stack>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
            <Box>
              <Typography variant="subtitle2">{t('personas.capabilities.everyday')}</Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                <Chip
                  color={memoryRecall || memoryChanges ? 'success' : 'default'}
                  label={memoryChanges
                    ? t('personas.capabilities.memoryOn')
                    : memoryRecall
                      ? t('personas.capabilities.memoryReadOnly')
                      : t('personas.capabilities.memoryOff')}
                />
                <Chip color={workAbilities ? 'success' : 'default'} label={workAbilities ? t('personas.capabilities.workOn') : t('personas.capabilities.workOff')} />
                <Chip color={improvementAbility ? 'success' : 'default'} label={improvementAbility ? t('personas.capabilities.improvementOn') : t('personas.capabilities.improvementOff')} />
              </Stack>
              {everydayAbilityNeedsSetup ? (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  {t('personas.capabilities.enableHelp')}
                </Typography>
              ) : null}
            </Box>
            <Box>
              <Typography variant="subtitle2">{t('personas.capabilities.apps')}</Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {preview.apps.length > 0
                  ? preview.apps.map((app) => <Chip key={app} label={app} />)
                  : <Typography variant="body2" color="text.secondary">{t('personas.capabilities.noApps')}</Typography>}
              </Stack>
            </Box>
            <Box>
              <Typography variant="subtitle2">{t('personas.capabilities.behaviors')}</Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
                {preview.behaviors.length > 0
                  ? preview.behaviors.map((behavior) => <Chip key={behavior.slotKey} label={behavior.name} />)
                  : <Typography variant="body2" color="text.secondary">{t('personas.capabilities.noBehaviors')}</Typography>}
              </Stack>
            </Box>
          </Box>
        )}
      </AreaShell>
      <Dialog open={goalOpen} fullWidth maxWidth="sm" onClose={() => setGoalOpen(false)}>
        <DialogTitle>{t('personas.goal.dialogTitle')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <TextField
              autoFocus
              required
              label={t('personas.goal.field.goal')}
              placeholder={t('personas.goal.field.goalPlaceholder')}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
            />
            <TextField
              multiline
              minRows={3}
              label={t('personas.goal.field.context')}
              placeholder={t('personas.goal.field.contextPlaceholder')}
              value={context}
              onChange={(event) => setContext(event.target.value)}
            />
            <TextField
              select
              label={t('personas.goal.field.priority')}
              value={priority}
              onChange={(event) => setPriority(event.target.value as PersonaPriority)}
            >
              {PERSONA_PRIORITIES.map((value) => (
                <MenuItem key={value} value={value}>{t(`personas.priority.${value}`)}</MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setGoalOpen(false)}>{t('personas.action.cancel')}</Button>
          <Button variant="contained" disabled={busy || !goal.trim()} onClick={() => void giveGoal()}>
            {t('personas.goal.start')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function TalkArea({ detail, busy, startConversation }: { detail: PersonaDetail; busy: boolean; startConversation: () => Promise<void> }) {
  const { t, formatDate } = useI18n();
  const conversations = detail.presentation.conversations;
  return (
    <AreaShell title={t('personas.talk.title')} icon={<ChatBubbleOutlineRounded />} action={<Button variant="contained" disabled={busy} onClick={() => void startConversation()} startIcon={<AddRounded />}>{t('personas.talk.new')}</Button>}>
      {conversations.length === 0 ? <Typography color="text.secondary">{t('personas.talk.empty')}</Typography> : (
        <Stack divider={<Divider flexItem />}>
          {conversations.map((conversation) => (
            <Stack key={conversation.conversationId} direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1.5} sx={{ py: 1.5 }}>
              <Box>
                <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography fontWeight={720}>{t(`personas.origin.${conversation.origin}`)}</Typography>
                  {conversation.active && <Chip size="small" color="primary" label={t('personas.conversations.active')} />}
                  {conversation.queuedInputCount > 0 && <Chip size="small" label={t('personas.conversations.queuedInput', { count: conversation.queuedInputCount })} />}
                </Stack>
                <Typography variant="body2" color="text.secondary">{formatDate(conversation.occurredAt, { dateStyle: 'medium', timeStyle: 'short' })} · {t(PERSONA_OUTCOME_KEYS[conversation.outcome])}</Typography>
              </Box>
              <Button component={Link} href={withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: conversation.conversationId }))}>{t('personas.talk.open')}</Button>
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
    priority: item.priority,
    nextAction: item.nextAction ?? '',
    deadline: item.deadline ? new Date(item.deadline).toISOString().slice(0, 10) : '',
    dependencyIds: item.dependencyIds,
    expectedUpdatedAt: item.updatedAt,
  } : { title: '', description: '', priority: 'normal', nextAction: '', deadline: '', dependencyIds: [] };
}

function WorkArea({ detail, busy, mutate }: { detail: PersonaDetail; busy: boolean; mutate: (action: () => Promise<unknown>, success?: string) => Promise<boolean> }) {
  const { t, formatDate } = useI18n();
  const [draft, setDraft] = useState<WorkDraft | null>(null);
  const [assignmentNotice, setAssignmentNotice] = useState<string | null>(null);
  const tasks = detail.presentation.tasks;
  const save = async () => {
    if (!draft?.title.trim()) return;
    const deadline = draft.deadline ? new Date(`${draft.deadline}T23:59:59`).getTime() : null;
    if (draft.id) {
      await mutate(() => personasService.updateWorkItem(detail.persona.id, draft.id!, {
        title: draft.title,
        description: draft.description || null,
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
  const assign = (task: PersonaTaskSummary) => mutate(async () => {
    const result = await personasService.assignWorkItem(detail.persona.id, task.id, {
      expectedUpdatedAt: task.expectedUpdatedAt,
      idempotencyKey: uuidv4(),
    });
    setAssignmentNotice(t(
      result.admission === 'already_queued'
        ? 'personas.assign.alreadyQueued'
        : 'personas.assign.queued',
    ));
  });
  const control = (
    task: PersonaTaskSummary,
    action: 'pause' | 'stop' | 'retry' | 'move_earlier' | 'move_later',
    success: TranslationKey,
  ) => mutate(
    () => personasService.controlWorkItem(detail.persona.id, task.id, action),
    t(success),
  );
  return (
    <AreaShell title={t('personas.tasks.title')} icon={<WorkOutlineRounded />} action={<Button variant="contained" startIcon={<AddRounded />} onClick={() => setDraft(draftForWorkItem())}>{t('personas.tasks.new')}</Button>}>
      <Stack spacing={2}>
        <Alert severity="info">{t('personas.tasks.temporaryHelp')}</Alert>
        {assignmentNotice && <Alert severity="success" onClose={() => setAssignmentNotice(null)}>{assignmentNotice}</Alert>}
        {tasks.length === 0 ? <Typography color="text.secondary">{t('personas.tasks.empty')}</Typography> : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
            {tasks.map((task) => {
              const item = detail.workItems.find((candidate) => candidate.id === task.id);
              const assignable = task.state === 'ready' || task.state === 'overdue';
              const active = task.state === 'waiting' || task.state === 'in_progress';
              const samePriorityWaiting = tasks.filter((candidate) => (
                candidate.state === 'waiting' && candidate.priority === task.priority
              ));
              const waitingIndex = samePriorityWaiting.findIndex((candidate) => (
                candidate.id === task.id
              ));
              const canMoveEarlier = task.state === 'waiting' && waitingIndex > 0;
              const canMoveLater = task.state === 'waiting'
                && waitingIndex >= 0
                && waitingIndex < samePriorityWaiting.length - 1;
              return (
                <Card key={task.id} variant="outlined" sx={{ borderRadius: 3, minWidth: 0 }}>
                  <CardContent>
                    <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'flex-start' }} gap={1}>
                      <Typography variant="h6" fontWeight={720}>{task.title}</Typography>
                      <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                        <Chip size="small" color={statusColor(task.state)} label={t(`personas.taskState.${task.state}`)} />
                        <Chip size="small" variant="outlined" label={t(`personas.priority.${task.priority}`)} />
                      </Stack>
                    </Stack>
                    {task.description && <Typography color="text.secondary" sx={{ mt: 1 }}>{task.description}</Typography>}
                    {task.nextAction && <Typography variant="body2" sx={{ mt: 1.5 }}><strong>{t('personas.tasks.nextAction')}:</strong> {task.nextAction}</Typography>}
                    {task.deadline && <Typography variant="caption" color={task.state === 'overdue' ? 'error.main' : 'text.secondary'}>{t('personas.tasks.deadline', { date: formatDate(task.deadline, { dateStyle: 'medium' }) })}</Typography>}
                    {task.blockerTitles.length > 0 && <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>{task.blockerTitles.map((title) => <Chip key={title} size="small" color="warning" label={title} />)}</Stack>}
                  </CardContent>
                  <CardActions sx={{ flexWrap: 'wrap' }}>
                    <Button disabled={busy || !assignable} startIcon={<AssignmentRounded />} onClick={() => void assign(task)}>
                      {task.state === 'waiting' ? t('personas.assign.assigned') : t('personas.assign.action')}
                    </Button>
                    {active && item && (
                      <Button
                        disabled={busy}
                        startIcon={<PauseCircleOutlineRounded />}
                        onClick={() => void control(task, 'pause', 'personas.tasks.paused')}
                      >
                        {t('personas.tasks.pause')}
                      </Button>
                    )}
                    {active && item && (
                      <Button
                        color="error"
                        disabled={busy}
                        startIcon={<StopCircleRounded />}
                        onClick={() => void control(task, 'stop', 'personas.tasks.stopped')}
                      >
                        {t('personas.tasks.stop')}
                      </Button>
                    )}
                    {task.state === 'waiting' && item && (
                      <Button
                        disabled={busy || !canMoveEarlier}
                        startIcon={<ArrowUpwardRounded />}
                        onClick={() => void control(
                          task,
                          'move_earlier',
                          'personas.tasks.movedEarlier',
                        )}
                      >
                        {t('personas.tasks.moveEarlier')}
                      </Button>
                    )}
                    {task.state === 'waiting' && item && (
                      <Button
                        disabled={busy || !canMoveLater}
                        startIcon={<ArrowDownwardRounded />}
                        onClick={() => void control(
                          task,
                          'move_later',
                          'personas.tasks.movedLater',
                        )}
                      >
                        {t('personas.tasks.moveLater')}
                      </Button>
                    )}
                    {task.state === 'blocked' && task.blockerTitles.length === 0 && item && (
                      <Button
                        disabled={busy}
                        startIcon={<ReplayRounded />}
                        onClick={() => void control(task, 'retry', 'personas.tasks.restarted')}
                      >
                        {t('personas.tasks.resumeRetry')}
                      </Button>
                    )}
                    {item && <Button startIcon={<EditRounded />} onClick={() => setDraft(draftForWorkItem(item))}>{t('personas.tasks.edit')}</Button>}
                    {item && !active && item.status !== 'completed' && item.status !== 'cancelled' && <Button disabled={busy} startIcon={<CheckCircleOutlineRounded />} onClick={() => void mutate(() => personasService.updateWorkItem(detail.persona.id, item.id, { status: 'completed', expectedUpdatedAt: item.updatedAt }))}>{t('personas.tasks.complete')}</Button>}
                    {item && <Button color="error" disabled={busy || active} onClick={() => { if (window.confirm(t('personas.tasks.deleteConfirm', { title: item.title }))) void mutate(() => personasService.deleteWorkItem(detail.persona.id, item.id)); }}>{t('personas.tasks.delete')}</Button>}
                  </CardActions>
                </Card>
              );
            })}
          </Box>
        )}
      </Stack>
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
      <DialogTitle>{draft.id ? t('personas.tasks.edit') : t('personas.tasks.new')}</DialogTitle>
      <DialogContent dividers><Stack spacing={2} sx={{ pt: 0.5 }}>
        <TextField label={t('personas.tasks.field.title')} value={draft.title} onChange={(event) => set('title', event.target.value)} required autoFocus />
        <TextField label={t('personas.tasks.field.description')} value={draft.description} onChange={(event) => set('description', event.target.value)} multiline minRows={3} />
        <TextField select fullWidth label={t('personas.tasks.field.priority')} value={draft.priority} onChange={(event) => set('priority', event.target.value as PersonaPriority)}>{PERSONA_PRIORITIES.map((priority) => <MenuItem key={priority} value={priority}>{t(`personas.priority.${priority}`)}</MenuItem>)}</TextField>
        <TextField label={t('personas.tasks.nextAction')} value={draft.nextAction} onChange={(event) => set('nextAction', event.target.value)} />
        <TextField label={t('personas.tasks.field.deadline')} type="date" value={draft.deadline} onChange={(event) => set('deadline', event.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
        <FormControl><InputLabel>{t('personas.tasks.dependencies')}</InputLabel><Select multiple label={t('personas.tasks.dependencies')} value={draft.dependencyIds} onChange={(event) => set('dependencyIds', typeof event.target.value === 'string' ? event.target.value.split(',') : event.target.value)}>{items.filter((item) => item.id !== draft.id).map((item) => <MenuItem key={item.id} value={item.id}>{item.title}</MenuItem>)}</Select></FormControl>
      </Stack></DialogContent>
      <DialogActions><Button onClick={onClose}>{t('personas.action.cancel')}</Button><Button variant="contained" disabled={busy || !draft.title.trim()} onClick={onSave}>{t('personas.action.save')}</Button></DialogActions>
    </Dialog>
  );
}


function AppsArea({ detail, busy, mutate }: {
  detail: PersonaDetail;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [selectedConfig, setSelectedConfig] = useState('');
  const [launching, setLaunching] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [configuredGrant, setConfiguredGrant] = useState<PersonaDetail['appGrants'][number] | null>(null);
  const { servers, loading, refreshing, error, refresh } = useMcpAppsDiscovery({
    active: true,
    includeAllServers: true,
  });
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
        <Alert severity="info">
          <Stack spacing={0.5}>
            <Typography variant="body2">{t('personas.apps.description')}</Typography>
            <Typography variant="body2">{t('personas.apps.launchSafety')}</Typography>
          </Stack>
        </Alert>
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
                        showName={false}
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
                      startIcon={<TuneRounded />}
                      disabled={busy || !server || !!server.error}
                      onClick={() => setConfiguredGrant(grant)}
                    >
                      {t('personas.apps.configureTools')}
                    </Button>
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
        <PersonaAppToolsDialog
          open={!!configuredGrant}
          grant={configuredGrant}
          workspaceRoots={configuredGrant
            ? servers.find((server) => server.name === configuredGrant.mcpServerName)?.config?.roots
            : undefined}
          busy={busy}
          onClose={() => setConfiguredGrant(null)}
          onSave={async ({ enabledTools, toolParameterPresets }) => {
            if (!configuredGrant) return false;
            return mutate(
              () => personasService.configureApp(detail.persona.id, configuredGrant.id, {
                mcpServerName: configuredGrant.mcpServerName,
                enabledTools,
                toolParameterPresets,
                expectedUpdatedAt: configuredGrant.updatedAt,
              }),
              t('personas.apps.toolsSaved'),
            );
          }}
        />
      </Stack>
    </AreaShell>
  );
}

function ActivityArea({ detail }: { detail: PersonaDetail }) {
  const { t, formatDate } = useI18n();
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const activityTypes = [...new Set(detail.presentation.history.map((entry) => entry.kind))];
  const activities: PersonaHistoryEntry[] = useMemo(() => {
    const since = dateFilter ? new Date(`${dateFilter}T00:00:00`).getTime() : 0;
    return detail.presentation.history.filter((entry) => (
      (!typeFilter || entry.kind === typeFilter)
      && (!statusFilter || entry.outcome === statusFilter)
      && entry.occurredAt >= since
    ));
  }, [dateFilter, detail.presentation.history, statusFilter, typeFilter]);
  const clearFilters = () => {
    setTypeFilter('');
    setStatusFilter('');
    setDateFilter('');
  };
  return (
    <AreaShell title={t('personas.history.title')} icon={<HistoryRounded />}>
      <Stack spacing={2}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField select fullWidth label={t('personas.history.filter.type')} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <MenuItem value="">{t('personas.history.filter.allTypes')}</MenuItem>
            {activityTypes.map((kind) => <MenuItem key={kind} value={kind}>{t(`personas.history.type.${kind}`)}</MenuItem>)}
          </TextField>
          <TextField select fullWidth label={t('personas.history.filter.status')} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <MenuItem value="">{t('personas.history.filter.allStatuses')}</MenuItem>
            {(Object.keys(PERSONA_OUTCOME_KEYS) as PersonaPresentationOutcome[]).map((outcome) => <MenuItem key={outcome} value={outcome}>{t(PERSONA_OUTCOME_KEYS[outcome])}</MenuItem>)}
          </TextField>
          <TextField fullWidth type="date" label={t('personas.history.filter.date')} value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          {(typeFilter || statusFilter || dateFilter) && <Button onClick={clearFilters}>{t('personas.history.filter.clear')}</Button>}
        </Stack>
        {activities.length === 0 ? <Typography color="text.secondary">{detail.presentation.history.length === 0 ? t('personas.history.empty') : t('personas.history.noMatches')}</Typography> : (
          <Stack divider={<Divider flexItem />}>
            {activities.map((activity) => (
              <Stack key={activity.key} direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1.5} sx={{ py: 1.5 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
                    <Chip size="small" color={statusColor(activity.outcome)} label={t(PERSONA_OUTCOME_KEYS[activity.outcome])} />
                    <Chip size="small" variant="outlined" label={t(`personas.history.type.${activity.kind}`)} />
                    <Chip size="small" variant="outlined" label={t(`personas.origin.${activity.origin}`)} />
                  </Stack>
                  <Typography fontWeight={700} sx={{ mt: 0.75 }}>{activity.summary}</Typography>
                  {activity.resultSummary && (
                    <Typography color="text.secondary" sx={{ mt: 0.25 }}>{activity.resultSummary}</Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">{t('personas.history.when', { date: formatDate(activity.occurredAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Typography>
                  <Box component="details" sx={{ mt: 1 }}>
                    <Box component="summary" sx={{ cursor: 'pointer', color: 'text.secondary' }}>{t('personas.history.advanced')}</Box>
                    <Typography variant="caption" color="text.secondary">
                      {t('personas.history.advancedSummary', {
                        type: t(`personas.history.type.${activity.advanced.activityKind}`),
                        origin: t(`personas.origin.${activity.origin}`),
                        status: t(PERSONA_OUTCOME_KEYS[activity.outcome]),
                      })}
                    </Typography>
                  </Box>
                </Box>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {activity.recordLinks.map((link) => link.kind === 'conversation' ? (
                    <Button key={`${link.kind}:${link.id}`} component={Link} href={withWorkspaceUrl(magicLinkPath({ kind: 'conversation', id: link.id }))}>{t('personas.talk.open')}</Button>
                  ) : (
                    <Button key={`${link.kind}:${link.id}`} component={Link} href={withWorkspaceUrl(`/meetings?meeting=${encodeURIComponent(link.id)}`)}>{t('personas.history.openMeeting')}</Button>
                  ))}
                </Stack>
              </Stack>
            ))}
          </Stack>
        )}
      </Stack>
    </AreaShell>
  );
}
