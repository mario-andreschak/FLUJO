"use client";

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AddRounded,
  ArrowBackRounded,
  CloseRounded,
  DescriptionRounded,
  DownloadRounded,
  FiberManualRecordRounded,
  OpenInNewRounded,
  PlayArrowRounded,
  ReplayRounded,
  StopCircleRounded,
  TokenRounded,
} from '@mui/icons-material';
import type { MeetingEvent, MeetingMotion, MeetingRecord } from '@/shared/types/meeting';
import type { TranslationKey } from '@/frontend/i18n';
import { useI18n } from '@/frontend/contexts/I18nContext';
import MeetingStatusChip from './MeetingStatusChip';
import MeetingTranscript from './MeetingTranscript';
import MeetingPhaseTimeline from './MeetingPhaseTimeline';
import MeetingTable from './MeetingTable';
import MeetingControlRail from './MeetingControlRail';
import MeetingMotions from './MeetingMotions';
import BreakoutPanel from './BreakoutPanel';
import { countDiscussionRounds, isTranscriptVisibleEvent } from './meetingTranscriptProjection';
import { magicLinkPath } from '@/frontend/utils/magicLink';
import { withWorkspaceUrl } from '@/frontend/utils/workspaceSelection';

interface MeetingViewProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
  streamConnected: boolean;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onContinue: () => void | Promise<void>;
  onFollowup: () => void;
  onPrivateNote: (content: string) => Promise<void>;
  onSteer: (content: string) => Promise<void>;
  onCreateLog: () => void;
}

export default function MeetingView({
  meeting,
  events,
  streamConnected,
  busy = false,
  error,
  onBack,
  onStart,
  onStop,
  onContinue,
  onFollowup,
  onPrivateNote,
  onSteer,
  onCreateLog,
}: MeetingViewProps) {
  const { t, formatNumber } = useI18n();
  const router = useRouter();
  const theme = useTheme();
  const [confirmStop, setConfirmStop] = useState(false);
  const [selectedParticipantId, setSelectedParticipantId] = useState<string | null>(null);
  const [humanMotions, setHumanMotions] = useState<MeetingMotion[]>([]);
  const isRunning = meeting.status === 'running';
  const canStart = meeting.status === 'draft' || meeting.status === 'paused';
  const terminal = ['completed', 'cancelled', 'error'].includes(meeting.status);
  const discussionRoundCount = countDiscussionRounds(meeting, events);
  const motions = useMemo(() => [...meeting.motions, ...humanMotions.filter((motion) => !meeting.motions.some((item) => item.id === motion.id))], [humanMotions, meeting.motions]);

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Button color="inherit" startIcon={<ArrowBackRounded />} onClick={onBack}>{t('meetings.back')}</Button>
          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
          <MeetingStatusChip status={meeting.status} />
          {isRunning && <Chip size="small" variant="outlined" color={streamConnected ? 'success' : 'default'} icon={streamConnected ? <FiberManualRecordRounded /> : <CircularProgress size={12} />} label={streamConnected ? t('meetings.live.connected') : t('meetings.live.reconnecting')} sx={streamConnected ? { '& .MuiChip-icon': { fontSize: 9 } } : undefined} />}
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap justifyContent="flex-end">
          {canStart ? (
            <Button variant="contained" startIcon={busy ? <CircularProgress color="inherit" size={17} /> : meeting.status === 'draft' ? <PlayArrowRounded /> : <ReplayRounded />} disabled={busy} onClick={() => void onStart()}>
              {meeting.status === 'paused' ? t('meetings.resume') : t('meetings.start')}
            </Button>
          ) : isRunning ? (
            <Button color="error" variant="outlined" startIcon={<StopCircleRounded />} disabled={busy} onClick={() => setConfirmStop(true)}>{t('meetings.stop')}</Button>
          ) : null}
          {terminal && <Button variant="contained" startIcon={busy ? <CircularProgress color="inherit" size={17} /> : <ReplayRounded />} disabled={busy} onClick={() => void onContinue()}>{t('meetings.continue')}</Button>}
          {terminal && <Button variant="outlined" startIcon={<AddRounded />} disabled={busy} onClick={onFollowup}>{t('meetings.followup')}</Button>}
          {events.length > 0 && <Button color="inherit" startIcon={<DownloadRounded />} onClick={onCreateLog}>{t('meetings.createLog')}</Button>}
        </Stack>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {meeting.error && <Alert severity="error" sx={{ mb: 2 }}>{meeting.error}</Alert>}

      <Paper variant="outlined" sx={{ mb: 2, overflow: 'hidden', background: `linear-gradient(120deg, ${alpha(theme.palette.primary.main, 0.08)}, transparent 55%, ${alpha(theme.palette.secondary.main, 0.05)}), ${alpha(theme.palette.background.paper, 0.96)}`, backdropFilter: 'blur(16px)' }}>
        <Box sx={{ p: { xs: 2, sm: 2.5 } }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="h5" sx={{ fontWeight: 790, letterSpacing: '-0.03em' }}>{meeting.title}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{meeting.openingPrompt}</Typography>
              {meeting.openingMedia?.length ? <Chip size="small" icon={<DescriptionRounded />} label={t('meetings.attachments.count', { count: meeting.openingMedia.length })} variant="outlined" sx={{ mt: 1 }} /> : null}
            </Box>
            <Stack direction="row" spacing={2.5} sx={{ flexShrink: 0 }}>
              <Box><Typography variant="overline" color="text.secondary">{t('meetings.round')}</Typography><Typography variant="h6" fontWeight={780}>{discussionRoundCount}<Typography component="span" color="text.secondary" fontSize="0.8rem"> / {meeting.policy.maxRounds}</Typography></Typography></Box>
              <Box><Typography variant="overline" color="text.secondary">{t('meetings.agents')}</Typography><Typography variant="h6" fontWeight={780}>{meeting.participants.length}</Typography></Box>
            </Stack>
          </Stack>
        </Box>
        <MeetingPhaseTimeline meeting={meeting} events={events} />
      </Paper>

      <MeetingTable participants={meeting.participants} onParticipantClick={setSelectedParticipantId} />

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' }, gap: 2, alignItems: 'start' }}>
        <Box sx={{ minWidth: 0 }}>
          <MeetingControlRail meeting={meeting} onPrivateNote={onPrivateNote} onSteer={onSteer} onProposeMotion={(motion) => setHumanMotions((current) => [...current, motion])} />
          <Paper variant="outlined" sx={{ minHeight: 500, p: { xs: 1.25, sm: 2 } }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1.5, px: 0.5 }}>
              <Typography variant="h6" sx={{ fontWeight: 750 }}>{meeting.phase === 'breakout' ? t('meetings.breakout.title') : t('meetings.transcript.title')}</Typography>
              <Chip size="small" variant="outlined" label={t('meetings.transcript.events', { count: events.filter(isTranscriptVisibleEvent).length })} />
            </Stack>
            {meeting.phase === 'breakout' ? <BreakoutPanel meeting={meeting} events={events} /> : <MeetingTranscript meeting={meeting} events={events} />}
          </Paper>
        </Box>

        <Stack spacing={2} sx={{ position: { lg: 'sticky' }, top: { lg: 'calc(var(--app-bar-height) + 68px)' } }}>
          <MeetingMotions meeting={meeting} motions={motions} />
          <Paper variant="outlined" sx={{ p: 1.7 }}>
            <Typography variant="subtitle2" fontWeight={750}>{t('meetings.details')}</Typography>
            <Stack spacing={1.1} sx={{ mt: 1.2 }}>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.facilitation')}</Typography><Typography variant="body2" fontWeight={650}>{t(`meetings.facilitation.mode.${meeting.policy.moderatorMode}` as TranslationKey)}</Typography></Stack>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.finishRule')}</Typography><Typography variant="body2" fontWeight={650}>{t(`meetings.facilitation.${meeting.policy.finishThreshold}` as TranslationKey)}</Typography></Stack>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.parallel')}</Typography><Typography variant="body2" fontWeight={650}>{meeting.policy.concurrencyLimit}</Typography></Stack>
              {meeting.usage && <><Divider /><Stack direction="row" justifyContent="space-between" alignItems="center"><Stack direction="row" spacing={0.6} alignItems="center"><TokenRounded fontSize="small" color="action" /><Typography variant="body2" color="text.secondary">{t('meetings.detail.tokens')}</Typography></Stack><Typography variant="body2" fontWeight={650}>{formatNumber(meeting.usage.totalTokens)}</Typography></Stack></>}
            </Stack>
          </Paper>
        </Stack>
      </Box>

      <Dialog open={confirmStop} onClose={() => setConfirmStop(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('meetings.stopConfirm.title')}</DialogTitle>
        <DialogContent><Typography color="text.secondary">{t('meetings.stopConfirm.description')}</Typography></DialogContent>
        <DialogActions><Button onClick={() => setConfirmStop(false)}>{t('common.cancel')}</Button><Button color="error" variant="contained" onClick={() => { setConfirmStop(false); void onStop(); }}>{t('meetings.stop')}</Button></DialogActions>
      </Dialog>

      {(() => {
        const participant = meeting.participants.find((item) => item.id === selectedParticipantId);
        const chatPath = participant ? magicLinkPath({ kind: 'conversation', id: participant.conversationId }) : null;
        return (
          <Drawer anchor="right" open={Boolean(participant)} onClose={() => setSelectedParticipantId(null)} PaperProps={{ sx: { width: { xs: '100%', md: 'min(920px, 76vw)' }, maxWidth: '100%' } }}>
            {participant && chatPath && <Stack sx={{ height: '100%', minHeight: 0 }}><Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, py: 1 }}><Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="subtitle1" fontWeight={760} noWrap>{participant.name}</Typography><Typography variant="caption" color="text.secondary">FLUJO Chat · meeting run</Typography></Box><Tooltip title={t('meetings.openChat')}><IconButton onClick={() => router.push(chatPath)} aria-label={t('meetings.openChat')}><OpenInNewRounded /></IconButton></Tooltip><IconButton onClick={() => setSelectedParticipantId(null)} aria-label={t('common.close')}><CloseRounded /></IconButton></Stack><Divider /><Box component="iframe" title={`${participant.name} FLUJO Chat`} src={withWorkspaceUrl(chatPath)} sx={{ flex: 1, width: '100%', minHeight: 0, border: 0, bgcolor: 'background.default' }} /></Stack>}
          </Drawer>
        );
      })()}
    </Box>
  );
}
