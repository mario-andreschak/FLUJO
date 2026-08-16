"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Avatar,
  Box,
  Chip,
  Divider,
  Link,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AutoAwesomeRounded,
  CheckCircleRounded,
  ErrorOutlineRounded,
  ExpandMoreRounded,
  FiberManualRecordRounded,
  FilterAltOffRounded,
  ForumRounded,
  HowToVoteRounded,
  LockRounded,
  PauseCircleOutlineRounded,
  RecordVoiceOverRounded,
  ReplayRounded,
} from '@mui/icons-material';
import { VariableSizeList, type ListChildComponentProps } from 'react-window';
import type { ModelMediaPart } from '@/shared/types/model/media';
import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { isTranscriptVisibleEvent } from './meetingTranscriptProjection';
import { ChatMarkdownContent } from '@/frontend/components/Chat/ChatMarkdown';

interface MeetingTranscriptProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
}

type LogFilter = 'all' | 'errors' | 'motions';
type TranscriptRow =
  | { kind: 'round'; id: string; number: number }
  | { kind: 'event'; id: string; event: MeetingEvent };

function MediaStrip({ media }: { media?: ModelMediaPart[] }) {
  if (!media?.length) return null;
  return (
    <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 1.5 }}>
      {media.map((part, index) => {
        const src = part.url ?? (part.data ? `data:${part.mimeType ?? 'application/octet-stream'};base64,${part.data}` : undefined);
        if (!src) return null;
        if (part.type === 'image') {
          return <Box key={`${part.name ?? part.type}-${index}`} component="img" src={src} alt={part.name ?? 'Meeting attachment'} sx={{ maxWidth: 'min(100%, 420px)', maxHeight: 300, objectFit: 'contain', borderRadius: 2, border: 1, borderColor: 'divider' }} />;
        }
        if (part.type === 'audio') return <Box key={`${part.name ?? part.type}-${index}`} component="audio" controls src={src} sx={{ maxWidth: '100%' }} />;
        if (part.type === 'video') return <Box key={`${part.name ?? part.type}-${index}`} component="video" controls src={src} sx={{ maxWidth: '100%', maxHeight: 360, borderRadius: 2 }} />;
        return <Link key={`${part.name ?? part.type}-${index}`} href={src} target="_blank" rel="noopener noreferrer">{part.name ?? 'Attachment'}</Link>;
      })}
    </Stack>
  );
}

function eventParticipantIds(event: MeetingEvent): string[] {
  if ('participantId' in event && typeof event.participantId === 'string') return [event.participantId];
  if (event.type === 'private-message') return [event.fromParticipantId, ...event.toParticipantIds];
  if (event.type === 'motion:opened') return [event.motion.proposedByParticipantId];
  if (event.type.startsWith('breakout:') && 'participantIds' in event) return event.participantIds;
  return [];
}

function eventAnnouncement(event: MeetingEvent): string {
  switch (event.type) {
    case 'participant:spoke': return `${event.participantName}: ${event.content}`;
    case 'participant:error': return `${event.participantName}: ${event.error}`;
    case 'private-note': return `Private note: ${event.content}`;
    case 'moderator:intervention': return `You: ${event.content}`;
    case 'meeting:resumed': return `Meeting continued: ${event.direction ?? ''}`;
    case 'motion:opened': return `Motion: ${event.motion.proposal ?? event.motion.kind}`;
    case 'meeting:error': return event.error;
    default: return event.type.replaceAll(':', ' ');
  }
}

function SystemEvent({ event }: { event: MeetingEvent }) {
  const { t } = useI18n();
  let icon = <ForumRounded fontSize="small" />;
  let text: string | null = null;
  let color: 'default' | 'success' | 'error' | 'warning' | 'secondary' | 'primary' = 'default';

  switch (event.type) {
    case 'meeting:started': text = t('meetings.transcript.started'); icon = <RecordVoiceOverRounded fontSize="small" />; break;
    case 'meeting:resumed': text = event.direction || t('meetings.transcript.resumed'); icon = <ReplayRounded fontSize="small" />; color = 'primary'; break;
    case 'meeting:completed': text = event.reason || t('meetings.transcript.completed'); icon = <CheckCircleRounded fontSize="small" />; color = 'success'; break;
    case 'meeting:cancelled': text = event.reason || t('meetings.transcript.cancelled'); icon = <PauseCircleOutlineRounded fontSize="small" />; color = 'warning'; break;
    case 'meeting:error': text = event.error; icon = <ErrorOutlineRounded fontSize="small" />; color = 'error'; break;
    case 'participant:silent': text = event.reason ? t('meetings.transcript.silentReason', { name: event.participantName, reason: event.reason }) : t('meetings.transcript.silent', { name: event.participantName }); break;
    case 'participant:left': text = t('meetings.transcript.left', { name: event.participantName }); color = 'warning'; break;
    case 'participant:error': text = t('meetings.transcript.agentError', { name: event.participantName, error: event.error }); color = 'error'; break;
    case 'motion:opened': text = event.motion.proposal || event.motion.reason || t('meetings.transcript.motion', { kind: event.motion.kind }); icon = <HowToVoteRounded fontSize="small" />; color = 'secondary'; break;
    case 'vote:cast': text = t('meetings.transcript.voteCast', { choice: event.choice }); icon = <HowToVoteRounded fontSize="small" />; color = 'secondary'; break;
    case 'motion:resolved': text = t('meetings.transcript.motionResult', { outcome: event.outcome }); icon = <HowToVoteRounded fontSize="small" />; color = event.outcome === 'accepted' ? 'success' : 'warning'; break;
    case 'breakout:queued': text = t('meetings.transcript.breakoutQueued', { topic: event.topic }); color = 'secondary'; break;
    case 'breakout:started': text = t('meetings.transcript.breakoutStarted', { topic: event.topic }); color = 'secondary'; break;
    case 'breakout:completed': text = t('meetings.transcript.breakoutCompleted', { summary: event.summary }); color = 'secondary'; break;
    case 'private-note': text = event.content; icon = <LockRounded fontSize="small" />; color = 'secondary'; break;
    default: return null;
  }
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="center" sx={{ height: '100%' }}>
      <Divider sx={{ flex: 1 }} />
      <Chip size="small" variant="outlined" color={color} icon={icon} label={text} sx={{ maxWidth: '82%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }} />
      <Divider sx={{ flex: 1 }} />
    </Stack>
  );
}

interface RowData {
  rows: TranscriptRow[];
  meeting: MeetingRecord;
  collapsedSpeakers: Set<string>;
  toggleSpeaker: (participantId: string) => void;
  measureRow: (rowId: string, index: number, height: number) => void;
  formatDate: ReturnType<typeof useI18n>['formatDate'];
}

interface MeasuredTranscriptRowProps {
  children: ReactNode;
  data: RowData;
  index: number;
  rowId: string;
  style: ListChildComponentProps<RowData>['style'];
}

function MeasuredTranscriptRow({ children, data, index, rowId, style }: MeasuredTranscriptRowProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { measureRow } = data;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;

    const measure = () => {
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height > 0) measureRow(rowId, index, height);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [index, measureRow, rowId]);

  return (
    <Box style={style}>
      <Box ref={contentRef} sx={{ width: '100%', boxSizing: 'border-box' }}>
        {children}
      </Box>
    </Box>
  );
}

function TranscriptListRow({ index, style, data }: ListChildComponentProps<RowData>) {
  const theme = useTheme();
  const { t } = useI18n();
  const row = data.rows[index];
  if (row.kind === 'round') {
    return (
      <MeasuredTranscriptRow data={data} index={index} rowId={row.id} style={style}>
        <Box sx={{ px: 1.5, height: 46, display: 'flex', alignItems: 'center' }}>
          <Divider sx={{ flex: 1 }} />
          <Chip size="small" color={row.number === data.meeting.roundNumber && data.meeting.status === 'running' ? 'primary' : 'default'} label={t('meetings.transcript.round', { count: row.number })} sx={{ mx: 1, fontWeight: 750 }} />
          <Divider sx={{ flex: 1 }} />
        </Box>
      </MeasuredTranscriptRow>
    );
  }
  const event = row.event;
  if (event.type === 'participant:spoke') {
    const participant = data.meeting.participants.find((person) => person.id === event.participantId);
    const initials = event.participantName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    const expanded = !data.collapsedSpeakers.has(event.participantId);
    return (
      <MeasuredTranscriptRow data={data} index={index} rowId={row.id} style={style}>
        <Box sx={{ px: 1.5, py: 0.6 }}>
          <Stack direction="row" spacing={1.2} alignItems="flex-start">
            <Avatar sx={{ mt: 0.6, width: 36, height: 36, flexShrink: 0, fontSize: '0.72rem', fontWeight: 800, background: participant?.role === 'moderator' ? `linear-gradient(145deg, ${theme.palette.secondary.main}, ${theme.palette.primary.dark})` : `linear-gradient(145deg, ${theme.palette.primary.main}, ${theme.palette.primary.dark})` }}>{initials}</Avatar>
            <Accordion
              disableGutters
              expanded={expanded}
              onChange={() => data.toggleSpeaker(event.participantId)}
              variant="outlined"
              sx={{
                flex: 1,
                minWidth: 0,
                maxWidth: 800,
                borderRadius: '4px 18px 18px 18px !important',
                overflow: 'hidden',
                borderColor: participant?.role === 'moderator' ? alpha(theme.palette.secondary.main, 0.35) : 'divider',
                bgcolor: participant?.role === 'moderator' ? alpha(theme.palette.secondary.main, 0.035) : 'background.paper',
                '&::before': { display: 'none' },
              }}
            >
              <AccordionSummary expandIcon={<ExpandMoreRounded />} sx={{ minHeight: 50, '& .MuiAccordionSummary-content': { minWidth: 0, my: 0.8 } }}>
                <Box sx={{ minWidth: 0 }}>
                  <Stack direction="row" spacing={0.8} alignItems="center">
                    <Typography variant="subtitle2" sx={{ fontWeight: 780 }}>{event.participantName}</Typography>
                    {participant?.role === 'moderator' && <AutoAwesomeRounded sx={{ fontSize: 14, color: 'secondary.main' }} />}
                    <Typography variant="caption" color="text.disabled">{data.formatDate(event.timestamp, { hour: '2-digit', minute: '2-digit' })}</Typography>
                  </Stack>
                  {!expanded && <Typography variant="caption" color="text.secondary" noWrap component="div">{event.content.replace(/\s+/g, ' ')}</Typography>}
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, pb: 1.6 }}>
                <Box className="meeting-markdown" sx={{ overflowWrap: 'anywhere', '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 }, '& p': { my: 1 }, '& pre': { overflowX: 'auto', p: 1.5, borderRadius: 1.5, bgcolor: alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.25 : 0.055) }, '& code': { fontFamily: 'monospace' }, '& table': { display: 'block', maxWidth: '100%', overflowX: 'auto', borderCollapse: 'collapse' }, '& th, & td': { p: 0.75, border: 1, borderColor: 'divider' } }}>
                  <ChatMarkdownContent>{event.content}</ChatMarkdownContent>
                </Box>
                <MediaStrip media={event.media} />
              </AccordionDetails>
            </Accordion>
          </Stack>
        </Box>
      </MeasuredTranscriptRow>
    );
  }
  if (event.type === 'moderator:intervention') {
    return (
      <MeasuredTranscriptRow data={data} index={index} rowId={row.id} style={style}>
        <Box sx={{ px: 1.5, py: 0.6 }}>
          <Stack direction="row" justifyContent="flex-end">
            <Paper
              variant="outlined"
              sx={{
                width: 'fit-content',
                maxWidth: 800,
                px: 1.6,
                py: 1.2,
                borderRadius: '18px 4px 18px 18px',
                borderColor: alpha(theme.palette.primary.main, 0.35),
                bgcolor: alpha(theme.palette.primary.main, 0.07),
              }}
            >
              <Stack direction="row" spacing={0.8} alignItems="center" sx={{ mb: 0.45 }}>
                <Typography variant="caption" fontWeight={780} color="primary.main">{t('meetings.transcript.you')}</Typography>
                <Typography variant="caption" color="text.disabled">{data.formatDate(event.timestamp, { hour: '2-digit', minute: '2-digit' })}</Typography>
              </Stack>
              <Box className="meeting-markdown" sx={{ overflowWrap: 'anywhere', '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 }, '& p': { my: 0.7 } }}>
                <ChatMarkdownContent>{event.content}</ChatMarkdownContent>
              </Box>
            </Paper>
          </Stack>
        </Box>
      </MeasuredTranscriptRow>
    );
  }
  if (event.type === 'private-message') {
    const sender = data.meeting.participants.find((person) => person.id === event.fromParticipantId);
    const recipients = event.toParticipantIds.map((id) => data.meeting.participants.find((person) => person.id === id)?.name).filter(Boolean).join(', ');
    return (
      <MeasuredTranscriptRow data={data} index={index} rowId={row.id} style={style}>
        <Box sx={{ px: 1.5, py: 0.6 }}>
          <Paper variant="outlined" sx={{ p: 1.5, ml: { sm: 6 }, borderStyle: 'dashed', bgcolor: alpha(theme.palette.secondary.main, 0.035) }}>
            <Stack direction="row" spacing={0.8} alignItems="center" sx={{ mb: 0.7 }}><LockRounded sx={{ fontSize: 16, color: 'secondary.main' }} /><Typography variant="caption" fontWeight={750}>{t('meetings.transcript.privateFrom', { from: sender?.name ?? t('meetings.transcript.unknown'), to: recipients })}</Typography></Stack>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{event.content}</Typography>
            <MediaStrip media={event.media} />
          </Paper>
        </Box>
      </MeasuredTranscriptRow>
    );
  }
  return (
    <MeasuredTranscriptRow data={data} index={index} rowId={row.id} style={style}>
      <Box sx={{ px: 1.5, py: 0.4, minHeight: 52, boxSizing: 'border-box' }}><SystemEvent event={event} /></Box>
    </MeasuredTranscriptRow>
  );
}

export default function MeetingTranscript({ meeting, events }: MeetingTranscriptProps) {
  const { t, formatDate } = useI18n();
  const theme = useTheme();
  const listRef = useRef<VariableSizeList<RowData>>(null);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const [live, setLive] = useState(true);
  const [speakerIds, setSpeakerIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<LogFilter>('all');
  const [collapsedSpeakers, setCollapsedSpeakers] = useState<Set<string>>(new Set());

  const rows = useMemo<TranscriptRow[]>(() => {
    const roundNumbers = new Map<string, number>();
    for (const event of events) if (event.type === 'round:started') roundNumbers.set(event.round.id, event.round.number);
    const allowed = events.filter((event) => {
      const visible = isTranscriptVisibleEvent(event) || (filter === 'motions' && event.type === 'vote:cast');
      if (!visible) return false;
      if (filter === 'errors' && event.type !== 'participant:error' && event.type !== 'meeting:error') return false;
      if (filter === 'motions' && !['motion:opened', 'vote:cast', 'motion:resolved'].includes(event.type)) return false;
      if (speakerIds.size) {
        const ids = eventParticipantIds(event);
        if (!ids.some((id) => speakerIds.has(id))) return false;
      }
      return true;
    });
    const result: TranscriptRow[] = [];
    let lastRoundId: string | undefined;
    for (const event of allowed) {
      if (event.roundId && event.roundId !== lastRoundId) {
        const number = roundNumbers.get(event.roundId);
        if (number !== undefined) result.push({ kind: 'round', id: `round-${event.roundId}`, number });
        lastRoundId = event.roundId;
      }
      result.push({ kind: 'event', id: event.eventId, event });
    }
    return result;
  }, [events, filter, speakerIds]);

  const toggleSpeakerCollapse = useCallback((participantId: string) => {
    setCollapsedSpeakers((current) => {
      const next = new Set(current);
      if (next.has(participantId)) next.delete(participantId); else next.add(participantId);
      return next;
    });
    requestAnimationFrame(() => listRef.current?.resetAfterIndex(0));
  }, []);

  const estimatedRowHeight = useCallback((index: number) => {
    const row = rows[index];
    if (row.kind === 'round') return 46;
    const event = row.event;
    if (event.type === 'participant:spoke') {
      if (collapsedSpeakers.has(event.participantId)) return 70;
      const lines = Math.ceil(event.content.length / 86) + (event.content.match(/\n/g)?.length ?? 0);
      return Math.min(520, 112 + Math.max(1, lines) * 21 + (event.media?.length ? 170 : 0));
    }
    if (event.type === 'private-message') return Math.min(260, 90 + Math.ceil(event.content.length / 90) * 20);
    if (event.type === 'moderator:intervention') return Math.min(260, 74 + Math.ceil(event.content.length / 90) * 20);
    return 52;
  }, [collapsedSpeakers, rows]);

  const rowHeight = useCallback((index: number) => {
    const row = rows[index];
    return measuredHeightsRef.current.get(row.id) ?? estimatedRowHeight(index);
  }, [estimatedRowHeight, rows]);

  const measureRow = useCallback((rowId: string, index: number, height: number) => {
    const previous = measuredHeightsRef.current.get(rowId);
    if (previous === height) return;
    measuredHeightsRef.current.set(rowId, height);
    listRef.current?.resetAfterIndex(index);
  }, []);

  const rowData = useMemo<RowData>(() => ({ rows, meeting, collapsedSpeakers, toggleSpeaker: toggleSpeakerCollapse, measureRow, formatDate }), [collapsedSpeakers, formatDate, measureRow, meeting, rows, toggleSpeakerCollapse]);

  useEffect(() => {
    listRef.current?.resetAfterIndex(0);
    if (live && rows.length) requestAnimationFrame(() => listRef.current?.scrollToItem(rows.length - 1, 'end'));
  }, [live, rows]);

  const newest = [...rows].reverse().find((row): row is Extract<TranscriptRow, { kind: 'event' }> => row.kind === 'event');
  const totalHeight = rows.reduce((sum, _, index) => sum + rowHeight(index), 0);
  const listHeight = Math.min(650, Math.max(310, totalHeight));
  const noFilters = speakerIds.size === 0 && filter === 'all';

  return (
    <Box>
      <Paper variant="outlined" sx={{ position: 'sticky', top: 0, zIndex: 2, mb: 1, p: 1, bgcolor: alpha(theme.palette.background.paper, 0.96), backdropFilter: 'blur(14px)' }}>
        <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            clickable
            size="small"
            color={live ? 'error' : 'default'}
            variant={live ? 'filled' : 'outlined'}
            icon={live ? <FiberManualRecordRounded /> : <PauseCircleOutlineRounded />}
            label={live ? t('meetings.transcript.live') : t('meetings.transcript.paused')}
            onClick={() => setLive((current) => !current)}
          />
          <Divider orientation="vertical" flexItem />
          {meeting.participants.map((participant) => {
            const selected = speakerIds.has(participant.id);
            return <Chip key={participant.id} clickable size="small" color={selected ? 'primary' : 'default'} variant={selected ? 'filled' : 'outlined'} avatar={<Avatar>{participant.name.slice(0, 1)}</Avatar>} label={participant.name} onClick={() => setSpeakerIds((current) => { const next = new Set(current); if (next.has(participant.id)) next.delete(participant.id); else next.add(participant.id); return next; })} />;
          })}
          <Divider orientation="vertical" flexItem />
          <Chip clickable size="small" color={filter === 'errors' ? 'error' : 'default'} variant={filter === 'errors' ? 'filled' : 'outlined'} icon={<ErrorOutlineRounded />} label={t('meetings.transcript.errorsOnly')} onClick={() => setFilter((current) => current === 'errors' ? 'all' : 'errors')} />
          <Chip clickable size="small" color={filter === 'motions' ? 'secondary' : 'default'} variant={filter === 'motions' ? 'filled' : 'outlined'} icon={<HowToVoteRounded />} label={t('meetings.transcript.motionsOnly')} onClick={() => setFilter((current) => current === 'motions' ? 'all' : 'motions')} />
          {!noFilters && <Tooltip title={t('meetings.transcript.clearFilters')}><Chip clickable size="small" variant="outlined" icon={<FilterAltOffRounded />} label={t('meetings.transcript.clear')} onClick={() => { setSpeakerIds(new Set()); setFilter('all'); }} /></Tooltip>}
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>{t('meetings.transcript.shown', { count: rows.filter((row) => row.kind === 'event').length })}</Typography>
        </Stack>
      </Paper>

      {live && newest && (
        <Box role="status" aria-live="polite" aria-atomic="true" sx={{ position: 'absolute', width: 1, height: 1, p: 0, m: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>
          {eventAnnouncement(newest.event)}
        </Box>
      )}

      {!rows.length ? (
        <Stack alignItems="center" justifyContent="center" spacing={1.2} sx={{ py: 9, px: 3, textAlign: 'center' }}>
          <Avatar sx={{ width: 52, height: 52, bgcolor: alpha(theme.palette.primary.main, 0.12), color: 'primary.light' }}><ForumRounded /></Avatar>
          <Typography variant="h6" fontWeight={720}>{noFilters ? t('meetings.transcript.waitingTitle') : t('meetings.transcript.noMatches')}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420 }}>{noFilters ? t('meetings.transcript.waiting') : t('meetings.transcript.noMatchesHelp')}</Typography>
        </Stack>
      ) : (
        <VariableSizeList<RowData>
          ref={listRef}
          height={listHeight}
          width="100%"
          itemCount={rows.length}
          itemData={rowData}
          itemKey={(index, data) => data.rows[index].id}
          itemSize={rowHeight}
          overscanCount={4}
        >
          {TranscriptListRow}
        </VariableSizeList>
      )}
    </Box>
  );
}
