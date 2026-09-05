"use client";

import { PauseCircleOutlineRounded, ReplayRounded, StopCircleRounded } from '@mui/icons-material';
import { Alert, Box, Button, Checkbox, Chip, FormControlLabel, Paper, Stack, TextField, Typography } from '@mui/material';
import { useEffect, useState, type ReactNode } from 'react';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { personasService } from '@/frontend/services/personas';
import type { PersonaWorkItem } from '@/shared/types/enduringAgent';

export default function PersonaGoalCard({ item, busy, mutate, children }: {
  item: PersonaWorkItem;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
  children?: ReactNode;
}) {
  const { t, formatDate } = useI18n();
  const goal = item.goal;
  const [criteria, setCriteria] = useState(goal?.successCriteria ?? '');
  const [finishOnSuccess, setFinishOnSuccess] = useState(goal?.completionPolicy !== 'until_stopped');
  const [cadence, setCadence] = useState(String((goal?.continuationIntervalMs ?? 60_000) / 1_000));
  const [limit, setLimit] = useState(goal?.maxRounds === undefined ? '' : String(goal.maxRounds));
  const [dailyLimit, setDailyLimit] = useState(String(goal?.maxRoundsPerDay ?? ''));
  const [dirty, setDirty] = useState(false);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(item.updatedAt);
  useEffect(() => {
    if (dirty) return;
    setCriteria(goal?.successCriteria ?? '');
    setFinishOnSuccess(goal?.completionPolicy !== 'until_stopped');
    setCadence(String((goal?.continuationIntervalMs ?? 60_000) / 1_000));
    setLimit(goal?.maxRounds === undefined ? '' : String(goal.maxRounds));
    setDailyLimit(String(goal?.maxRoundsPerDay ?? ''));
    setExpectedUpdatedAt(item.updatedAt);
  }, [dirty, goal?.successCriteria, goal?.completionPolicy, goal?.continuationIntervalMs, goal?.maxRounds, goal?.maxRoundsPerDay, item.updatedAt]);
  if (!goal) return null;
  const terminal = goal.state === 'completed' || goal.state === 'stopped';
  const currentSession = Boolean(goal.pendingTaskId) && (goal.nextRunAt === undefined || goal.nextRunAt <= Date.now());
  const valid = criteria.trim().length > 0 && Number.isInteger(Number(cadence)) && Number(cadence) >= 10 && Number(cadence) <= 604_800
    && (!limit || (Number.isInteger(Number(limit)) && Number(limit) > 0))
    && Number.isInteger(Number(dailyLimit)) && Number(dailyLimit) >= 1 && Number(dailyLimit) <= 10_000;
  const save = async () => {
    const saved = await mutate(() => personasService.updateWorkItem(item.personaId, item.id, {
      expectedUpdatedAt,
      goal: { successCriteria: criteria.trim(), completionPolicy: finishOnSuccess ? 'success_criteria' : 'until_stopped', continuationIntervalMs: Number(cadence) * 1_000, maxRounds: limit ? Number(limit) : null, maxRoundsPerDay: Number(dailyLimit) },
    }));
    if (saved) setDirty(false);
  };
  return <Paper variant="outlined" sx={{ p: { xs: 2, md: 2.5 }, borderRadius: 3 }}>
    <Stack spacing={1.5}>
      <Stack direction="row" justifyContent="space-between" gap={1} flexWrap="wrap">
        <Typography variant="h6" fontWeight={760}>{item.title}</Typography>
        <Chip label={t(`personas.goal.${goal.state}`)} color={goal.state === 'active' ? 'info' : goal.state === 'completed' ? 'success' : goal.state === 'needs_input' ? 'warning' : 'default'} />
      </Stack>
      {item.description && <Typography color="text.secondary">{item.description}</Typography>}
      {goal.progressSummary && <Typography>{goal.progressSummary}</Typography>}
      {item.nextAction && <Typography variant="body2"><strong>{t('personas.tasks.nextAction')}:</strong> {item.nextAction}</Typography>}
      {goal.interventionReason && <Alert severity={goal.state === 'needs_input' ? 'warning' : 'info'}>
        {goal.state === 'active' && <Typography variant="subtitle2">{t('personas.goal.workingAroundDependency')}</Typography>}
        {goal.interventionReason}
      </Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {goal.completionPolicy === 'until_stopped' && <Chip size="small" variant="outlined" label={t('personas.goal.untilStopped')} />}
        <Chip size="small" label={t('personas.goal.rounds', { count: goal.rounds })} />
        <Typography variant="body2" color="text.secondary">{t('personas.goal.dailyUsage', { count: goal.roundsInWindow, limit: goal.maxRoundsPerDay })}</Typography>
        {goal.recoveryCount !== undefined && goal.recoveryCount > 0 && <Chip size="small" variant="outlined" label={t('personas.goal.recoveries', { count: goal.recoveryCount })} />}
        {goal.state === 'active' && (currentSession
          ? <Typography variant="body2">{t('personas.goal.currentSession')}</Typography>
          : goal.nextRunAt !== undefined && <Typography variant="body2">{t(goal.pendingTaskId ? 'personas.goal.nextAttempt' : 'personas.goal.nextWake', { date: formatDate(goal.nextRunAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Typography>)}
        {goal.lastProgressAt !== undefined && <Typography variant="body2" color="text.secondary">{t('personas.goal.lastProgress', { date: formatDate(goal.lastProgressAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Typography>}
      </Stack>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        {goal.state === 'active' && <Button disabled={busy} startIcon={<PauseCircleOutlineRounded />} onClick={() => void mutate(() => personasService.controlWorkItem(item.personaId, item.id, 'pause'), t('personas.tasks.paused'))}>{t('personas.tasks.pause')}</Button>}
        {(goal.state === 'paused' || goal.state === 'needs_input') && <Button disabled={busy || dirty} startIcon={<ReplayRounded />} onClick={() => void mutate(() => personasService.controlWorkItem(item.personaId, item.id, 'retry'), t('personas.tasks.restarted'))}>{t('personas.goal.continue')}</Button>}
        {!terminal && <Button color="error" disabled={busy} startIcon={<StopCircleRounded />} onClick={() => void mutate(() => personasService.controlWorkItem(item.personaId, item.id, 'stop'), t('personas.tasks.stopped'))}>{t('personas.tasks.stop')}</Button>}
      </Stack>
      {children}
      <Box component="details">
        <Box component="summary" sx={{ cursor: 'pointer', color: 'text.secondary' }}>{t('personas.goal.criteriaAndLimits')}</Box>
        <Stack spacing={2} sx={{ mt: 2 }}>
          <FormControlLabel control={<Checkbox checked={finishOnSuccess} disabled={busy || terminal} onChange={(_, checked) => { setFinishOnSuccess(checked); setDirty(true); }} />} label={t('personas.goal.finishOnSuccess')} />
          <TextField multiline minRows={2} label={t('personas.goal.criteriaLabel')} value={criteria} disabled={busy || terminal} onChange={(event) => { setCriteria(event.target.value); setDirty(true); }} />
          <TextField type="number" label={t('personas.goal.cadence')} value={cadence} disabled={busy || terminal} onChange={(event) => { setCadence(event.target.value); setDirty(true); }} slotProps={{ htmlInput: { min: 10, max: 604_800, step: 1 } }} />
          <TextField type="number" label={t('personas.goal.dailyLimitCurrent')} helperText={t('personas.goal.dailyLimitCurrentHelp')} value={dailyLimit} disabled={busy || terminal} onChange={(event) => { setDailyLimit(event.target.value); setDirty(true); }} slotProps={{ htmlInput: { min: 1, max: 10_000, step: 1 } }} />
          <TextField type="number" label={t('personas.goal.maxRounds')} helperText={t('personas.goal.maxRoundsHelp')} value={limit} disabled={busy || terminal} onChange={(event) => { setLimit(event.target.value); setDirty(true); }} slotProps={{ htmlInput: { min: 1, step: 1 } }} />
          {dirty && <Stack direction="row" spacing={1}>
            <Button disabled={busy || !valid} onClick={() => void save()}>{t('personas.action.save')}</Button>
            <Button disabled={busy} onClick={() => setDirty(false)}>{t('personas.settings.reloadServer')}</Button>
          </Stack>}
        </Stack>
      </Box>
    </Stack>
  </Paper>;
}
