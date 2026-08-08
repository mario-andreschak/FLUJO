"use client";

import { Fragment, useMemo } from 'react';
import {
  Avatar,
  Box,
  Chip,
  Divider,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AutoAwesomeRounded,
  CheckCircleRounded,
  ErrorOutlineRounded,
  ForumRounded,
  HowToVoteRounded,
  LockRounded,
  PauseCircleOutlineRounded,
  RecordVoiceOverRounded,
} from '@mui/icons-material';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { isTranscriptVisibleEvent } from './meetingTranscriptProjection';

interface MeetingTranscriptProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
}

interface RoundGroup {
  key: string;
  number: number | null;
  events: MeetingEvent[];
}

function MediaStrip({ media }: { media?: ModelMediaPart[] }) {
  if (!media?.length) return null;
  return (
    <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1.5 }}>
      {media.map((part, index) => {
        const src = part.url ?? (part.data ? `data:${part.mimeType ?? 'application/octet-stream'};base64,${part.data}` : undefined);
        if (!src) return null;
        if (part.type === 'image') {
          return (
            <Box
              key={`${part.name ?? part.type}-${index}`}
              component="img"
              src={src}
              alt={part.name ?? 'Meeting attachment'}
              sx={{ maxWidth: 'min(100%, 420px)', maxHeight: 300, objectFit: 'contain', borderRadius: 2, border: 1, borderColor: 'divider' }}
            />
          );
        }
        if (part.type === 'audio') {
          return <Box key={`${part.name ?? part.type}-${index}`} component="audio" controls src={src} sx={{ maxWidth: '100%' }} />;
        }
        if (part.type === 'video') {
          return <Box key={`${part.name ?? part.type}-${index}`} component="video" controls src={src} sx={{ maxWidth: '100%', maxHeight: 360, borderRadius: 2 }} />;
        }
        return <Link key={`${part.name ?? part.type}-${index}`} href={src} target="_blank" rel="noopener noreferrer">{part.name ?? 'Attachment'}</Link>;
      })}
    </Stack>
  );
}

function SystemEvent({ event }: { event: MeetingEvent }) {
  const { t } = useI18n();
  let icon = <ForumRounded fontSize="small" />;
  let text: string | null = null;
  let color: 'default' | 'success' | 'error' | 'warning' | 'secondary' = 'default';

  switch (event.type) {
    case 'meeting:started':
      text = t('meetings.transcript.started');
      icon = <RecordVoiceOverRounded fontSize="small" />;
      break;
    case 'meeting:completed':
      text = event.reason || t('meetings.transcript.completed');
      icon = <CheckCircleRounded fontSize="small" />;
      color = 'success';
      break;
    case 'meeting:cancelled':
      text = event.reason || t('meetings.transcript.cancelled');
      icon = <PauseCircleOutlineRounded fontSize="small" />;
      color = 'warning';
      break;
    case 'meeting:error':
      text = event.error;
      icon = <ErrorOutlineRounded fontSize="small" />;
      color = 'error';
      break;
    case 'participant:silent':
      text = event.reason
        ? t('meetings.transcript.silentReason', { name: event.participantName, reason: event.reason })
        : t('meetings.transcript.silent', { name: event.participantName });
      break;
    case 'participant:left':
      text = t('meetings.transcript.left', { name: event.participantName });
      color = 'warning';
      break;
    case 'participant:error':
      text = t('meetings.transcript.agentError', { name: event.participantName, error: event.error });
      color = 'error';
      break;
    case 'motion:opened':
      text = event.motion.proposal || event.motion.reason || t('meetings.transcript.motion', { kind: event.motion.kind });
      icon = <HowToVoteRounded fontSize="small" />;
      color = 'secondary';
      break;
    case 'motion:resolved':
      text = t('meetings.transcript.motionResult', { outcome: event.outcome });
      icon = <HowToVoteRounded fontSize="small" />;
      color = event.outcome === 'accepted' ? 'success' : 'warning';
      break;
    case 'breakout:queued':
      text = t('meetings.transcript.breakoutQueued', { topic: event.topic });
      color = 'secondary';
      break;
    case 'breakout:started':
      text = t('meetings.transcript.breakoutStarted', { topic: event.topic });
      color = 'secondary';
      break;
    case 'breakout:completed':
      text = t('meetings.transcript.breakoutCompleted', { summary: event.summary });
      color = 'secondary';
      break;
    default:
      return null;
  }

  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ py: 0.5 }}>
      <Divider sx={{ flex: 1 }} />
      <Chip size="small" variant="outlined" color={color} icon={icon} label={text} sx={{ maxWidth: '80%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }} />
      <Divider sx={{ flex: 1 }} />
    </Stack>
  );
}

export default function MeetingTranscript({ meeting, events }: MeetingTranscriptProps) {
  const { t, formatDate } = useI18n();
  const theme = useTheme();

  const groups = useMemo<RoundGroup[]>(() => {
    const roundNumbers = new Map<string, number>();
    for (const event of events) {
      if (event.type === 'round:started') roundNumbers.set(event.round.id, event.round.number);
    }
    const grouped = new Map<string, RoundGroup>();
    for (const event of events) {
      const key = event.roundId ?? (event.type === 'round:started' ? event.round.id : 'meeting');
      const number = key === 'meeting' ? null : roundNumbers.get(key) ?? null;
      const group = grouped.get(key) ?? { key, number, events: [] };
      group.events.push(event);
      grouped.set(key, group);
    }
    return [...grouped.values()].sort((a, b) => (a.events[0]?.seq ?? 0) - (b.events[0]?.seq ?? 0));
  }, [events]);

  if (!events.some(isTranscriptVisibleEvent)) {
    return (
      <Stack alignItems="center" justifyContent="center" spacing={1.2} sx={{ py: 10, px: 3, textAlign: 'center' }}>
        <Avatar sx={{ width: 52, height: 52, bgcolor: alpha(theme.palette.primary.main, 0.12), color: 'primary.light' }}>
          <ForumRounded />
        </Avatar>
        <Typography variant="h6" fontWeight={720}>{t('meetings.transcript.waitingTitle')}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>{t('meetings.transcript.waiting')}</Typography>
      </Stack>
    );
  }

  return (
    <Stack spacing={2.5}>
      {groups.map((group) => {
        const visibleEvents = group.events.filter(isTranscriptVisibleEvent);
        if (visibleEvents.length === 0) return null;
        return (
          <Box key={group.key}>
            {group.number !== null && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
                <Divider sx={{ flex: 1 }} />
                <Chip
                  size="small"
                  color={group.number === meeting.roundNumber && meeting.status === 'running' ? 'primary' : 'default'}
                  label={t('meetings.transcript.round', { count: group.number })}
                  sx={{ fontWeight: 750 }}
                />
                <Divider sx={{ flex: 1 }} />
              </Stack>
            )}
            <Stack spacing={1.5}>
              {visibleEvents.map((event) => {
                if (event.type === 'participant:spoke') {
                  const participant = meeting.participants.find((person) => person.id === event.participantId);
                  const initials = event.participantName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
                  return (
                    <Stack key={event.eventId} direction="row" spacing={1.2} alignItems="flex-start">
                      <Avatar
                        sx={{
                          mt: 0.3,
                          width: 36,
                          height: 36,
                          flexShrink: 0,
                          fontSize: '0.72rem',
                          fontWeight: 800,
                          background: participant?.role === 'moderator'
                            ? `linear-gradient(145deg, ${theme.palette.secondary.main}, ${theme.palette.primary.dark})`
                            : `linear-gradient(145deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})`,
                        }}
                      >
                        {initials}
                      </Avatar>
                      <Paper
                        variant="outlined"
                        sx={{
                          minWidth: 0,
                          maxWidth: 780,
                          p: { xs: 1.5, sm: 2 },
                          borderRadius: '4px 18px 18px 18px',
                          borderColor: participant?.role === 'moderator' ? alpha(theme.palette.secondary.main, 0.35) : 'divider',
                          bgcolor: participant?.role === 'moderator' ? alpha(theme.palette.secondary.main, 0.035) : 'background.paper',
                        }}
                      >
                        <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 0.7 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 780 }}>{event.participantName}</Typography>
                          {participant?.role === 'moderator' && <AutoAwesomeRounded sx={{ fontSize: 14, color: 'secondary.main' }} />}
                          <Typography variant="caption" color="text.disabled">
                            {formatDate(event.timestamp, { hour: '2-digit', minute: '2-digit' })}
                          </Typography>
                        </Stack>
                        <Box
                          className="meeting-markdown"
                          sx={{
                            overflowWrap: 'anywhere',
                            '& > :first-of-type': { mt: 0 },
                            '& > :last-child': { mb: 0 },
                            '& p': { my: 1 },
                            '& pre': { overflowX: 'auto', p: 1.5, borderRadius: 1.5, bgcolor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.25 : 0.055) },
                            '& code': { fontFamily: 'monospace' },
                            '& table': { display: 'block', maxWidth: '100%', overflowX: 'auto', borderCollapse: 'collapse' },
                            '& th, & td': { p: 0.75, border: 1, borderColor: 'divider' },
                          }}
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.content}</ReactMarkdown>
                        </Box>
                        <MediaStrip media={event.media} />
                      </Paper>
                    </Stack>
                  );
                }

                if (event.type === 'private-message') {
                  const sender = meeting.participants.find((person) => person.id === event.fromParticipantId);
                  const recipients = event.toParticipantIds
                    .map((id) => meeting.participants.find((person) => person.id === id)?.name)
                    .filter(Boolean)
                    .join(', ');
                  return (
                    <Paper key={event.eventId} variant="outlined" sx={{ p: 1.5, ml: { sm: 6 }, borderStyle: 'dashed', bgcolor: alpha(theme.palette.secondary.main, 0.035) }}>
                      <Stack direction="row" spacing={0.8} alignItems="center" sx={{ mb: 0.7 }}>
                        <LockRounded sx={{ fontSize: 16, color: 'secondary.main' }} />
                        <Typography variant="caption" fontWeight={750}>{t('meetings.transcript.privateFrom', { from: sender?.name ?? t('meetings.transcript.unknown'), to: recipients })}</Typography>
                      </Stack>
                      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{event.content}</Typography>
                      <MediaStrip media={event.media} />
                    </Paper>
                  );
                }

                return <Fragment key={event.eventId}><SystemEvent event={event} /></Fragment>;
              })}
            </Stack>
          </Box>
        );
      })}
    </Stack>
  );
}
