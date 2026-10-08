"use client";

import {
  Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import { useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { useI18n } from '@/frontend/contexts/I18nContext';
import { personasService } from '@/frontend/services/personas';
import { PERSONA_PRIORITIES, type CreatePersonaWorkItemInput, type PersonaPriority, type PersonaWorkItem } from '@/shared/types/enduringAgent';

type GoalInput = Omit<CreatePersonaWorkItemInput, 'id' | 'personaId'>;

function creationDefinitelyRejected(cause: unknown): boolean {
  const status = cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined;
  // A conflict may mean that this exact client id already committed. Server
  // errors and transport failures also require recovery of the original id.
  return typeof status === 'number' && [400, 401, 403, 404, 422].includes(status);
}

export default function PersonaGoalDialog({ open, personaId, busy, mutate, onClose }: {
  open: boolean;
  personaId: string;
  busy: boolean;
  mutate: (action: () => Promise<unknown>, success?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');
  const [priority, setPriority] = useState<PersonaPriority>('normal');
  const [ongoing, setOngoing] = useState(true);
  const [criteria, setCriteria] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState('60');
  const [maxRounds, setMaxRounds] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [saved, setSaved] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const attempt = useRef<{ input: GoalInput; fingerprint: string; id: string; assignmentKey: string; created?: PersonaWorkItem; attempted: boolean } | null>(null);
  const submitting = useRef(false);
  const cadenceValid = Number.isInteger(Number(intervalSeconds)) && Number(intervalSeconds) >= 10 && Number(intervalSeconds) <= 604_800;
  const budgetValid = !maxRounds || (Number.isInteger(Number(maxRounds)) && Number(maxRounds) > 0);
  const dailyLimitValid = !dailyLimit || (Number.isInteger(Number(dailyLimit)) && Number(dailyLimit) >= 1 && Number(dailyLimit) <= 10_000);
  const requestBusy = busy || isSubmitting;
  const readOnly = requestBusy || saved || uncertain;

  const close = () => {
    if (busy || submitting.current) return;
    if (uncertain) {
      // Closing the dialog cannot undo a possibly committed creation. Keep its
      // identity and form for recovery when the owner opens the dialog again.
      onClose();
      return;
    }
    setTitle(''); setContext(''); setPriority('normal'); setOngoing(true);
    setCriteria(''); setIntervalSeconds('60'); setMaxRounds(''); setDailyLimit(''); setSaved(false);
    setUncertain(false); setSubmitError(null);
    attempt.current = null;
    onClose();
  };

  const submit = async () => {
    if (submitting.current || !title.trim() || (ongoing && (!cadenceValid || !budgetValid || !dailyLimitValid))) return;
    const input: GoalInput = {
      title: title.trim(),
      ...(context.trim() ? { description: context.trim() } : {}),
      priority,
      dependencyIds: [],
      ...(ongoing ? { goal: {
        successCriteria: criteria.trim() || t('personas.goal.ongoingCriteria'),
        completionPolicy: criteria.trim() ? 'success_criteria' : 'until_stopped',
        continuationIntervalMs: Number(intervalSeconds) * 1_000,
        ...(maxRounds ? { maxRounds: Number(maxRounds) } : {}),
        ...(dailyLimit ? { maxRoundsPerDay: Number(dailyLimit) } : {}),
      } } : {}),
    };
    const fingerprint = JSON.stringify(input);
    if (!attempt.current || (!attempt.current.attempted && !attempt.current.created && attempt.current.fingerprint !== fingerprint)) {
      attempt.current = { input, fingerprint, id: `work_${uuidv4().replaceAll('-', '')}`, assignmentKey: uuidv4(), attempted: false };
    }
    const request = attempt.current;
    const ongoingRequest = Boolean(request.input.goal);
    submitting.current = true;
    setIsSubmitting(true);
    setSubmitError(null);
    let succeeded = false;
    try {
      succeeded = await mutate(async () => {
        const recoveringEarlierAttempt = request.attempted;
        // A lost POST response must not publish the same goal twice. The client
        // keeps its identity across retries and checks whether it was committed.
        if (!request.created && request.attempted) {
          try { request.created = await personasService.getWorkItem(personaId, request.id); } catch { /* Retry the same id below. */ }
        }
        if (!request.created) {
          request.attempted = true;
          setUncertain(true);
          try {
            request.created = await personasService.createWorkItem(personaId, { ...request.input, id: request.id });
          } catch (cause) {
            if (!recoveringEarlierAttempt && creationDefinitelyRejected(cause)) {
              request.attempted = false;
              setUncertain(false);
              throw cause;
            }
            try { request.created = await personasService.getWorkItem(personaId, request.id); } catch { throw cause; }
          }
        }
        setUncertain(false);
        setSaved(true);
        // Ongoing goals start through the durable controller at creation. A
        // separate assignment here would race that controller and repeat work.
        if (!ongoingRequest) {
          await personasService.assignWorkItem(personaId, request.created.id, {
            expectedUpdatedAt: request.created.updatedAt,
            idempotencyKey: request.assignmentKey,
          });
        }
      }, t(ongoingRequest ? 'personas.goal.owned' : 'personas.goal.queued'));
    } catch (cause) {
      // Callers normally turn failures into false. A rejected mutation wrapper
      // must still leave a usable retry action and preserve the frozen request.
      setSubmitError(cause instanceof Error ? cause.message : t('personas.action.failed'));
    } finally {
      submitting.current = false;
      setIsSubmitting(false);
    }
    if (succeeded) {
      // mutate has finished, but the parent's busy prop can lag one render.
      setTitle(''); setContext(''); setPriority('normal'); setOngoing(true);
      setCriteria(''); setIntervalSeconds('60'); setMaxRounds(''); setDailyLimit(''); setSaved(false);
      setUncertain(false); setSubmitError(null);
      attempt.current = null;
      onClose();
    }
  };

  return (
    <Dialog open={open} fullWidth maxWidth="sm" onClose={close}>
      <DialogTitle>{t('personas.goal.dialogTitle')}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ pt: 0.5 }}>
          {saved && !requestBusy && <Alert severity="info">{t(ongoing ? 'personas.goal.savedRefresh' : 'personas.goal.savedRetry')}</Alert>}
          {uncertain && !requestBusy && <Alert severity="info">{t('personas.goal.recoveringSubmission')}</Alert>}
          {submitError && <Alert severity="error">{submitError}</Alert>}
          <TextField autoFocus required label={t('personas.goal.field.goal')} placeholder={t('personas.goal.field.goalPlaceholder')} value={title} disabled={readOnly} onChange={(event) => { if (!readOnly) setTitle(event.target.value); }} />
          <TextField multiline minRows={3} label={t('personas.goal.field.context')} placeholder={t('personas.goal.field.contextPlaceholder')} value={context} disabled={readOnly} onChange={(event) => { if (!readOnly) setContext(event.target.value); }} />
          <FormControlLabel control={<Checkbox checked={ongoing} disabled={readOnly} onChange={(_event, checked) => { if (!readOnly) setOngoing(checked); }} />} label={t('personas.goal.keepWorking')} />
          {ongoing && <>
            <Typography variant="body2" color="text.secondary">{t('personas.goal.ongoingHelp')}</Typography>
            <TextField multiline minRows={2} label={t('personas.goal.successCriteria')} helperText={t('personas.goal.successCriteriaHelp')} value={criteria} disabled={readOnly} onChange={(event) => { if (!readOnly) setCriteria(event.target.value); }} />
            <Box component="details">
              <Box component="summary" sx={{ cursor: 'pointer' }}>{t('personas.goal.continuationControls')}</Box>
              <Stack spacing={2} sx={{ mt: 2 }}>
                <TextField type="number" label={t('personas.goal.cadence')} value={intervalSeconds} disabled={readOnly} error={!cadenceValid} helperText={t('personas.goal.cadenceHelp')} onChange={(event) => { if (!readOnly) setIntervalSeconds(event.target.value); }} slotProps={{ htmlInput: { min: 10, max: 604_800, step: 1 } }} />
                <TextField type="number" label={t('personas.goal.dailyLimit')} value={dailyLimit} disabled={readOnly} error={!dailyLimitValid} helperText={t('personas.goal.dailyLimitHelp')} onChange={(event) => { if (!readOnly) setDailyLimit(event.target.value); }} slotProps={{ htmlInput: { min: 1, max: 10_000, step: 1 } }} />
                <TextField type="number" label={t('personas.goal.maxRounds')} value={maxRounds} disabled={readOnly} error={!budgetValid} helperText={t('personas.goal.maxRoundsHelp')} onChange={(event) => { if (!readOnly) setMaxRounds(event.target.value); }} slotProps={{ htmlInput: { min: 1, step: 1 } }} />
                <Typography variant="body2" color="text.secondary">{t('personas.goal.retryBudgetHelp')}</Typography>
              </Stack>
            </Box>
          </>}
          <TextField select label={t('personas.goal.field.priority')} value={priority} disabled={readOnly} onChange={(event) => { if (!readOnly) setPriority(event.target.value as PersonaPriority); }}>
            {PERSONA_PRIORITIES.map((value) => <MenuItem key={value} value={value}>{t(`personas.priority.${value}`)}</MenuItem>)}
          </TextField>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button disabled={requestBusy} onClick={close}>{t(uncertain && !requestBusy ? 'personas.action.close' : 'personas.action.cancel')}</Button>
        <Button variant="contained" aria-busy={requestBusy} startIcon={requestBusy ? <CircularProgress size={16} color="inherit" aria-hidden="true" /> : undefined} disabled={requestBusy || !title.trim() || (ongoing && (!cadenceValid || !budgetValid || !dailyLimitValid))} onClick={() => void submit()}>{t(requestBusy ? 'personas.goal.starting' : saved || uncertain ? 'personas.retry' : 'personas.goal.start')}</Button>
      </DialogActions>
    </Dialog>
  );
}
