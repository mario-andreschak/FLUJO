"use client";

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { CallMergeRounded, ForumRounded, GroupsRounded } from '@mui/icons-material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import { meetingsService, type MeetingDetailResponse } from '@/frontend/services/meetings';
import { useI18n } from '@/frontend/contexts/I18nContext';

interface BreakoutPanelProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
}

interface BreakoutRoom {
  id: string;
  childMeetingId?: string;
  participantIds: string[];
  topic: string;
  status: 'queued' | 'live';
}

export default function BreakoutPanel({ meeting, events }: BreakoutPanelProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const [details, setDetails] = useState<Record<string, MeetingDetailResponse | null>>({});
  const [rejoined, setRejoined] = useState<Set<string>>(new Set());

  const rooms = useMemo<BreakoutRoom[]>(() => {
    const completed = new Set(events.filter((event) => event.type === 'breakout:completed').map((event) => event.childMeetingId));
    const started = events
      .filter((event): event is Extract<MeetingEvent, { type: 'breakout:started' }> => event.type === 'breakout:started')
      .filter((event) => !completed.has(event.childMeetingId))
      .map((event) => ({
        id: event.childMeetingId,
        childMeetingId: event.childMeetingId,
        participantIds: event.participantIds,
        topic: event.topic,
        status: 'live' as const,
      }));
    if (started.length) return started;
    return events
      .filter((event): event is Extract<MeetingEvent, { type: 'breakout:queued' }> => event.type === 'breakout:queued')
      .slice(-4)
      .map((event) => ({
        id: event.eventId,
        participantIds: event.participantIds,
        topic: event.topic,
        status: 'queued' as const,
      }));
  }, [events]);

  useEffect(() => {
    let active = true;
    const pending = rooms.filter((room) => room.childMeetingId && details[room.childMeetingId] === undefined);
    if (!pending.length) return;
    void Promise.all(pending.map(async (room) => {
      try {
        const detail = await meetingsService.get(room.childMeetingId!);
        if (active) setDetails((current) => ({ ...current, [room.childMeetingId!]: detail }));
      } catch {
        if (active) setDetails((current) => ({ ...current, [room.childMeetingId!]: null }));
      }
    }));
    return () => { active = false; };
  }, [details, rooms]);

  if (!rooms.length) {
    return <Alert severity="info">{t('meetings.breakout.waiting')}</Alert>;
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <GroupsRounded color="secondary" />
        <Box>
          <Typography variant="h6" fontWeight={780}>{t('meetings.breakout.title')}</Typography>
          <Typography variant="body2" color="text.secondary">{t('meetings.breakout.description')}</Typography>
        </Box>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
        {rooms.map((room, roomIndex) => {
          const detail = room.childMeetingId ? details[room.childMeetingId] : undefined;
          const speech = detail?.events
            .filter((event): event is Extract<MeetingEvent, { type: 'participant:spoke' }> => event.type === 'participant:spoke')
            .slice(-3) ?? [];
          const hasRejoined = rejoined.has(room.id);
          return (
            <Paper key={room.id} variant="outlined" sx={{ p: 2, bgcolor: alpha(theme.palette.secondary.main, 0.025) }}>
              <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                <Box>
                  <Typography variant="overline" color="secondary.main">{t('meetings.breakout.room', { count: roomIndex + 1 })}</Typography>
                  <Typography variant="subtitle1" fontWeight={760}>{room.topic}</Typography>
                </Box>
                <Chip size="small" color={room.status === 'live' ? 'success' : 'default'} label={t(`meetings.breakout.${room.status}`)} />
              </Stack>
              <Stack direction="row" spacing={-0.75} sx={{ my: 1.5 }}>
                {room.participantIds.map((id) => {
                  const participant = meeting.participants.find((item) => item.id === id);
                  return (
                    <Avatar key={id} title={participant?.name ?? id} sx={{ width: 32, height: 32, fontSize: '0.68rem', border: `2px solid ${theme.palette.background.paper}` }}>
                      {(participant?.name ?? '?').slice(0, 2).toUpperCase()}
                    </Avatar>
                  );
                })}
              </Stack>
              <Paper variant="outlined" sx={{ minHeight: 130, maxHeight: 240, overflowY: 'auto', p: 1.25, bgcolor: 'background.default' }}>
                {room.childMeetingId && detail === undefined ? (
                  <Stack alignItems="center" justifyContent="center" sx={{ minHeight: 105 }}><CircularProgress size={22} /></Stack>
                ) : speech.length ? (
                  <Stack spacing={1.2}>
                    {speech.map((event) => (
                      <Box key={event.eventId}>
                        <Typography variant="caption" fontWeight={760} color="primary.main">{event.participantName}</Typography>
                        <Box sx={{ fontSize: '0.82rem', '& p': { my: 0.4 } }}><ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown></Box>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Stack alignItems="center" justifyContent="center" spacing={0.7} sx={{ minHeight: 105, textAlign: 'center' }}>
                    <ForumRounded color="disabled" />
                    <Typography variant="caption" color="text.secondary">{t('meetings.breakout.noTranscript')}</Typography>
                  </Stack>
                )}
              </Paper>
              <Button
                fullWidth
                sx={{ mt: 1.5 }}
                variant={hasRejoined ? 'text' : 'outlined'}
                startIcon={<CallMergeRounded />}
                disabled={hasRejoined}
                onClick={() => setRejoined((current) => new Set(current).add(room.id))}
              >
                {hasRejoined ? t('meetings.breakout.rejoined') : t('meetings.breakout.rejoin')}
              </Button>
            </Paper>
          );
        })}
      </Box>
    </Box>
  );
}
