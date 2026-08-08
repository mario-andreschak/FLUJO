"use client";

import { useState } from 'react';
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
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  ArrowBackRounded,
  FiberManualRecordRounded,
  HowToVoteRounded,
  PlayArrowRounded,
  ReplayRounded,
  StopCircleRounded,
  TokenRounded,
} from '@mui/icons-material';
import type { MeetingEvent, MeetingPhase, MeetingRecord } from '@/shared/types/meeting';
import type { TranslationKey } from '@/frontend/i18n';
import { useI18n } from '@/frontend/contexts/I18nContext';
import MeetingStatusChip from './MeetingStatusChip';
import MeetingTranscript from './MeetingTranscript';
import { countDiscussionRounds, isTranscriptVisibleEvent } from './meetingTranscriptProjection';
import ParticipantStatus from './ParticipantStatus';

const phaseKeys: Record<MeetingPhase, TranslationKey> = {
  draft: 'meetings.phase.draft',
  opening: 'meetings.phase.opening',
  discussion: 'meetings.phase.discussion',
  ballot: 'meetings.phase.ballot',
  breakout: 'meetings.phase.breakout',
  closing: 'meetings.phase.closing',
  completed: 'meetings.phase.completed',
};

interface MeetingViewProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
  streamConnected: boolean;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
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
}: MeetingViewProps) {
  const { t, formatNumber } = useI18n();
  const theme = useTheme();
  const [confirmStop, setConfirmStop] = useState(false);
  const isRunning = meeting.status === 'running';
  const canStart = meeting.status === 'draft' || meeting.status === 'paused';
  const discussionRoundCount = countDiscussionRounds(meeting, events);
  const roundProgress = Math.min(100, (discussionRoundCount / meeting.policy.maxRounds) * 100);

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" sx={{ mb: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
          <Button color="inherit" startIcon={<ArrowBackRounded />} onClick={onBack}>{t('meetings.back')}</Button>
          <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
          <MeetingStatusChip status={meeting.status} />
          {isRunning && (
            <Chip
              size="small"
              variant="outlined"
              color={streamConnected ? 'success' : 'default'}
              icon={streamConnected ? <FiberManualRecordRounded /> : <CircularProgress size={12} />}
              label={streamConnected ? t('meetings.live.connected') : t('meetings.live.reconnecting')}
              sx={streamConnected ? { '& .MuiChip-icon': { fontSize: 9 } } : undefined}
            />
          )}
        </Stack>
        {canStart ? (
          <Button
            variant="contained"
            startIcon={busy
              ? <CircularProgress color="inherit" size={17} />
              : meeting.status === 'draft'
                ? <PlayArrowRounded />
                : <ReplayRounded />}
            disabled={busy}
            onClick={() => void onStart()}
          >
            {meeting.status === 'paused' ? t('meetings.resume') : t('meetings.start')}
          </Button>
        ) : isRunning ? (
          <Button color="error" variant="outlined" startIcon={<StopCircleRounded />} disabled={busy} onClick={() => setConfirmStop(true)}>
            {t('meetings.stop')}
          </Button>
        ) : null}
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {meeting.error && <Alert severity="error" sx={{ mb: 2 }}>{meeting.error}</Alert>}

      <Paper
        variant="outlined"
        sx={{
          mb: 2,
          overflow: 'hidden',
          background: `linear-gradient(120deg, ${alpha(theme.palette.primary.main, 0.08)}, transparent 55%, ${alpha(theme.palette.secondary.main, 0.05)}), ${alpha(theme.palette.background.paper, 0.96)}`,
          backdropFilter: 'blur(16px)',
        }}
      >
        <Box sx={{ p: { xs: 2, sm: 2.5 } }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'flex-start', md: 'center' }}>
            <Box sx={{ minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h5" sx={{ fontWeight: 790, letterSpacing: '-0.03em' }}>{meeting.title}</Typography>
                <Chip size="small" variant="outlined" label={t(phaseKeys[meeting.phase])} />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, maxWidth: 760, whiteSpace: 'pre-wrap' }}>
                {meeting.openingPrompt}
              </Typography>
            </Box>
            <Stack direction="row" spacing={2.5} sx={{ flexShrink: 0 }}>
              <Box>
                <Typography variant="overline" color="text.secondary">{t('meetings.round')}</Typography>
                <Typography variant="h6" fontWeight={780}>{discussionRoundCount}<Typography component="span" color="text.secondary" fontSize="0.8rem"> / {meeting.policy.maxRounds}</Typography></Typography>
              </Box>
              <Box>
                <Typography variant="overline" color="text.secondary">{t('meetings.agents')}</Typography>
                <Typography variant="h6" fontWeight={780}>{meeting.participants.length}</Typography>
              </Box>
            </Stack>
          </Stack>
        </Box>
        {isRunning && <LinearProgress variant="determinate" value={roundProgress} sx={{ height: 3, bgcolor: alpha(theme.palette.primary.main, 0.08) }} />}
      </Paper>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' }, gap: 2, alignItems: 'start' }}>
        <Paper variant="outlined" sx={{ minHeight: 500, p: { xs: 1.5, sm: 2.5 } }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 750 }}>{t('meetings.transcript.title')}</Typography>
            <Chip size="small" variant="outlined" label={t('meetings.transcript.events', { count: events.filter(isTranscriptVisibleEvent).length })} />
          </Stack>
          <MeetingTranscript meeting={meeting} events={events} />
        </Paper>

        <Stack spacing={2} sx={{ position: { lg: 'sticky' }, top: { lg: 'calc(var(--app-bar-height) + 68px)' } }}>
          <Paper variant="outlined" sx={{ p: 1.5 }}>
            <Typography variant="subtitle2" sx={{ px: 0.25, mb: 1.2, fontWeight: 750 }}>{t('meetings.team')}</Typography>
            <Stack spacing={1}>
              {meeting.participants.map((participant) => <ParticipantStatus key={participant.id} participant={participant} compact />)}
            </Stack>
          </Paper>

          {meeting.motions.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={0.8} alignItems="center" sx={{ mb: 1.2 }}>
                <HowToVoteRounded color="secondary" fontSize="small" />
                <Typography variant="subtitle2" fontWeight={750}>{t('meetings.motions')}</Typography>
              </Stack>
              <Stack spacing={1}>
                {meeting.motions.slice().reverse().slice(0, 3).map((motion) => (
                  <Paper key={motion.id} variant="outlined" sx={{ p: 1.2, bgcolor: alpha(theme.palette.secondary.main, 0.035) }}>
                    <Stack direction="row" justifyContent="space-between" spacing={1}>
                      <Typography variant="body2" fontWeight={700}>{motion.proposal || motion.kind}</Typography>
                      <Chip size="small" color={motion.status === 'accepted' ? 'success' : motion.status === 'open' ? 'secondary' : 'default'} label={motion.status} />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">{t('meetings.motion.votes', { count: motion.votes.length })}</Typography>
                  </Paper>
                ))}
              </Stack>
            </Paper>
          )}

          <Paper variant="outlined" sx={{ p: 1.7 }}>
            <Typography variant="subtitle2" fontWeight={750}>{t('meetings.details')}</Typography>
            <Stack spacing={1.1} sx={{ mt: 1.2 }}>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.facilitation')}</Typography><Typography variant="body2" fontWeight={650}>{t(`meetings.facilitation.mode.${meeting.policy.moderatorMode}` as TranslationKey)}</Typography></Stack>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.finishRule')}</Typography><Typography variant="body2" fontWeight={650}>{t(`meetings.facilitation.${meeting.policy.finishThreshold}` as TranslationKey)}</Typography></Stack>
              <Stack direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary">{t('meetings.detail.parallel')}</Typography><Typography variant="body2" fontWeight={650}>{meeting.policy.concurrencyLimit}</Typography></Stack>
              {meeting.usage && (
                <>
                  <Divider />
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Stack direction="row" spacing={0.6} alignItems="center"><TokenRounded fontSize="small" color="action" /><Typography variant="body2" color="text.secondary">{t('meetings.detail.tokens')}</Typography></Stack>
                    <Typography variant="body2" fontWeight={650}>{formatNumber(meeting.usage.totalTokens)}</Typography>
                  </Stack>
                </>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Box>

      <Dialog open={confirmStop} onClose={() => setConfirmStop(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('meetings.stopConfirm.title')}</DialogTitle>
        <DialogContent><Typography color="text.secondary">{t('meetings.stopConfirm.description')}</Typography></DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmStop(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => { setConfirmStop(false); void onStop(); }}>{t('meetings.stop')}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
