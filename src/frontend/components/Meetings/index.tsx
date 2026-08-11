"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import { AddRounded, GroupsRounded, RefreshRounded } from '@mui/icons-material';
import type {
  CreateMeetingInput,
  MeetingEvent,
  MeetingRecord,
  MeetingSummary,
} from '@/shared/types/meeting';
import { meetingsService, type MeetingDetailResponse } from '@/frontend/services/meetings';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { createLogger } from '@/utils/logger';
import PageHeader from '@/frontend/components/shared/PageHeader';
import MeetingList from './MeetingList';
import MeetingView from './MeetingView';
import MeetingWizard from './MeetingWizard';
import { meetingLogMarkdown } from './meetingTranscriptProjection';

const log = createLogger('frontend/components/Meetings');

function initialMeetingId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URL(window.location.href).searchParams.get('meeting');
}

function mergeEvents(current: MeetingEvent[], incoming: MeetingEvent[]): MeetingEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) byId.set(event.eventId, event);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export default function MeetingsManager() {
  const { t } = useI18n();
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialMeetingId);
  const [detail, setDetail] = useState<MeetingDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(initialMeetingId()));
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardSeed, setWizardSeed] = useState<CreateMeetingInput | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [streamConnected, setStreamConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const items = await meetingsService.list();
      setMeetings(items.slice().sort((a, b) => b.updatedAt - a.updatedAt));
      setError(null);
    } catch (loadError) {
      log.warn('Failed to load meetings', loadError);
      setError(loadError instanceof Error ? loadError.message : t('meetings.error.load'));
    } finally {
      setListLoading(false);
    }
  }, [t]);

  const loadDetail = useCallback(async (id: string, foreground = false) => {
    if (foreground) setDetailLoading(true);
    try {
      const next = await meetingsService.get(id);
      setDetail((current) => ({
        meeting: next.meeting,
        events: mergeEvents(current?.meeting.id === id ? current.events : [], next.events),
      }));
      setError(null);
    } catch (loadError) {
      log.warn('Failed to load meeting', { id, loadError });
      setError(loadError instanceof Error ? loadError.message : t('meetings.error.loadOne'));
    } finally {
      if (foreground) setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailLoading(false);
      return;
    }
    void loadDetail(selectedId, true);
  }, [loadDetail, selectedId]);

  const activeStatus = detail?.meeting.id === selectedId
    && detail.meeting.status === 'running';

  useEffect(() => {
    if (!selectedId || !activeStatus) {
      setStreamConnected(false);
      return;
    }

    const source = meetingsService.subscribe(selectedId, {
      onOpen: () => setStreamConnected(true),
      onError: () => setStreamConnected(false),
      onEvent: (event) => {
        setDetail((current) => current?.meeting.id === selectedId
          ? { ...current, events: mergeEvents(current.events, [event]) }
          : current);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => void loadDetail(selectedId), 220);
      },
    }, detail?.events.at(-1) ? detail.events.at(-1)!.seq + 1 : undefined);

    return () => {
      source.close();
      setStreamConnected(false);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [activeStatus, loadDetail, selectedId]);

  const selectMeeting = (id: string | null) => {
    setSelectedId(id);
    setError(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set('meeting', id);
      else url.searchParams.delete('meeting');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
  };

  const createMeeting = async (input: CreateMeetingInput) => {
    setSubmitting(true);
    setWizardError(null);
    try {
      const created = await meetingsService.create(input);
      setWizardOpen(false);
      setWizardSeed(null);
      selectMeeting(created.id);
      setDetail({ meeting: created, events: [] });
      try {
        const started = await meetingsService.start(created.id);
        setDetail((current) => ({ meeting: started, events: current?.events ?? [] }));
        await loadDetail(created.id);
      } catch (startError) {
        setError(startError instanceof Error ? startError.message : t('meetings.error.start'));
      }
      await loadList();
    } catch (createError) {
      setWizardError(createError instanceof Error ? createError.message : t('meetings.error.create'));
    } finally {
      setSubmitting(false);
    }
  };

  const runContinuation = async (steeringPrompt?: string) => {
    if (!selectedMeeting) return;
    const lastOutcome = [...(detail?.events ?? [])].reverse().find((event) => event.type === 'meeting:completed' || event.type === 'meeting:cancelled');
    const outcome = lastOutcome && 'reason' in lastOutcome ? lastOutcome.reason : undefined;
    const direction = steeringPrompt?.trim();
    const input: CreateMeetingInput = {
      title: `${selectedMeeting.title} · Continued`,
      openingPrompt: [
        `Continue the meeting “${selectedMeeting.title}” as a new session.`,
        outcome ? `Previous outcome: ${outcome}` : undefined,
        direction
          ? `The moderator is continuing the meeting with this direction:\n${direction}`
          : 'Revisit unresolved points, incorporate the prior outcome, and converge on the next concrete decision.',
        '',
        'Original brief:',
        selectedMeeting.openingPrompt,
      ].filter((line): line is string => line !== undefined).join('\n'),
      openingMedia: selectedMeeting.openingMedia,
      parentMeetingId: selectedMeeting.id,
      participants: selectedMeeting.participants.map(({ id, name, flowId, role }) => ({ id, name, flowId, role })),
      moderatorParticipantId: selectedMeeting.moderatorParticipantId,
      policy: { ...selectedMeeting.policy },
    };
    setBusy(true);
    try {
      const created = await meetingsService.create(input);
      selectMeeting(created.id);
      setDetail({ meeting: created, events: [] });
      const started = await meetingsService.start(created.id);
      setDetail((current) => ({ meeting: started, events: current?.events ?? [] }));
      await loadDetail(created.id);
      await loadList();
    } finally {
      setBusy(false);
    }
  };

  const continueMeeting = async () => {
    try {
      await runContinuation();
    } catch (continueError) {
      setError(continueError instanceof Error ? continueError.message : t('meetings.error.create'));
    }
  };

  const openFollowup = () => {
    if (!selectedMeeting) return;
    setWizardSeed({
      title: `Follow-up: ${selectedMeeting.title}`,
      openingPrompt: `Define the next decision or action that follows from “${selectedMeeting.title}”.\n\nRelevant context from the original brief:\n${selectedMeeting.openingPrompt}`,
      openingMedia: selectedMeeting.openingMedia,
      parentMeetingId: selectedMeeting.id,
      participants: selectedMeeting.participants.map(({ id, name, flowId, role }) => ({ id, name, flowId, role })),
      moderatorParticipantId: selectedMeeting.moderatorParticipantId,
      policy: { ...selectedMeeting.policy },
    });
    setWizardError(null);
    setWizardOpen(true);
  };

  const addPrivateNote = async (content: string) => {
    if (!selectedId) return;
    const event = await meetingsService.addPrivateNote(selectedId, content);
    setDetail((current) => current?.meeting.id === selectedId ? { ...current, events: mergeEvents(current.events, [event]) } : current);
  };

  const steerMeeting = async (content: string) => {
    if (!selectedId || !selectedMeeting) return;
    if (['completed', 'cancelled', 'error'].includes(selectedMeeting.status)) {
      try {
        await runContinuation(content);
      } catch (continueError) {
        const message = continueError instanceof Error ? continueError.message : t('meetings.error.create');
        setError(message);
        throw continueError instanceof Error ? continueError : new Error(message);
      }
      return;
    }
    const event = await meetingsService.steer(selectedId, content);
    setDetail((current) => current?.meeting.id === selectedId ? { ...current, events: mergeEvents(current.events, [event]) } : current);
  };

  const createMeetingLog = () => {
    if (!selectedMeeting || typeof window === 'undefined') return;
    const blob = new Blob([meetingLogMarkdown(selectedMeeting, detail?.events ?? [])], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedMeeting.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'meeting'}-log.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const startMeeting = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const meeting = await meetingsService.start(selectedId);
      setDetail((current) => current ? { ...current, meeting } : { meeting, events: [] });
      await loadDetail(selectedId);
      await loadList();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t('meetings.error.start'));
    } finally {
      setBusy(false);
    }
  };

  const stopMeeting = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const meeting = await meetingsService.cancel(selectedId);
      setDetail((current) => current ? { ...current, meeting } : { meeting, events: [] });
      await loadDetail(selectedId);
      await loadList();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : t('meetings.error.stop'));
    } finally {
      setBusy(false);
    }
  };

  const selectedMeeting: MeetingRecord | null = detail?.meeting.id === selectedId ? detail.meeting : null;

  return (
    <Box sx={{ minHeight: 'calc(100vh - var(--app-bar-height))' }}>
      <PageHeader
        icon={GroupsRounded}
        eyebrowKey="meetings.eyebrow"
        title={selectedMeeting?.title ?? t('meetings.title')}
        description={selectedMeeting ? t('meetings.detailDescription') : t('meetings.description')}
        badge={<Chip size="small" color="warning" variant="outlined" label={t('meetings.experimental')} />}
        actions={(
          <>
            {!selectedId && error && (
              <Button variant="outlined" startIcon={<RefreshRounded />} onClick={() => void loadList()}>{t('common.tryAgain')}</Button>
            )}
            <Button variant="contained" startIcon={<AddRounded />} onClick={() => { setWizardSeed(null); setWizardError(null); setWizardOpen(true); }}>
              {t('meetings.new')}
            </Button>
          </>
        )}
      />

      <Box component="main" sx={{ width: '100%', maxWidth: 1440, mx: 'auto', px: { xs: 2, sm: 3, lg: 4 }, py: { xs: 2.5, sm: 3.5 } }}>
        {!selectedId && error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {selectedId ? (
          detailLoading && !selectedMeeting ? (
            <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ minHeight: 430 }}>
              <CircularProgress />
              <Typography color="text.secondary">{t('meetings.detail.loading')}</Typography>
            </Stack>
          ) : selectedMeeting ? (
            <MeetingView
              meeting={selectedMeeting}
              events={detail?.events ?? []}
              streamConnected={streamConnected}
              busy={busy}
              error={error}
              onBack={() => selectMeeting(null)}
              onStart={startMeeting}
              onStop={stopMeeting}
              onContinue={continueMeeting}
              onFollowup={openFollowup}
              onPrivateNote={addPrivateNote}
              onSteer={steerMeeting}
              onCreateLog={createMeetingLog}
            />
          ) : (
            <Alert
              severity="error"
              action={<Button color="inherit" onClick={() => selectMeeting(null)}>{t('meetings.back')}</Button>}
            >
              {error ?? t('meetings.error.notFound')}
            </Alert>
          )
        ) : (
          <MeetingList meetings={meetings} loading={listLoading} onSelect={selectMeeting} onCreate={() => setWizardOpen(true)} />
        )}
      </Box>

      <MeetingWizard
        open={wizardOpen}
        submitting={submitting}
        error={wizardError}
        initialInput={wizardSeed}
        onClose={() => { setWizardOpen(false); setWizardSeed(null); }}
        onSubmit={createMeeting}
      />
    </Box>
  );
}
