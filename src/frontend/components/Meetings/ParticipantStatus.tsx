"use client";

import {
  Avatar,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AutoAwesomeRounded,
  ErrorOutlineRounded,
  ForumRounded,
  LogoutRounded,
} from '@mui/icons-material';
import type { MeetingParticipant, MeetingParticipantStatus } from '@/shared/types/meeting';
import type { TranslationKey } from '@/frontend/i18n';
import { useI18n } from '@/frontend/contexts/I18nContext';

const statusKeys: Record<MeetingParticipantStatus, TranslationKey> = {
  idle: 'meetings.participant.idle',
  waiting: 'meetings.participant.waiting',
  running: 'meetings.participant.running',
  breakout: 'meetings.participant.breakout',
  left: 'meetings.participant.left',
  error: 'meetings.participant.error',
};

const statusColors: Record<MeetingParticipantStatus, 'default' | 'primary' | 'secondary' | 'warning' | 'error'> = {
  idle: 'default',
  waiting: 'secondary',
  running: 'primary',
  breakout: 'secondary',
  left: 'warning',
  error: 'error',
};

interface ParticipantStatusProps {
  participant: MeetingParticipant;
  compact?: boolean;
  onClick?: () => void;
  selected?: boolean;
  waitingForNames?: string[];
}

export default function ParticipantStatus({ participant, compact = false, onClick, selected = false, waitingForNames = [] }: ParticipantStatusProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const initials = participant.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return (
    <Paper
      variant="outlined"
      component={onClick ? 'button' : 'div'}
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      sx={{
        width: '100%',
        textAlign: 'left',
        color: 'inherit',
        font: 'inherit',
        p: compact ? 1.2 : 1.5,
        borderColor: selected
          ? 'primary.main'
          : participant.status === 'running'
          ? alpha(theme.palette.primary.main, 0.45)
          : participant.status === 'error'
            ? alpha(theme.palette.error.main, 0.45)
            : 'divider',
        bgcolor: participant.status === 'running' ? alpha(theme.palette.primary.main, 0.055) : undefined,
        transition: 'border-color 180ms ease, background-color 180ms ease',
        cursor: onClick ? 'pointer' : 'default',
        '&:hover': onClick ? { bgcolor: alpha(theme.palette.primary.main, 0.075) } : undefined,
        '&:focus-visible': onClick ? { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 } : undefined,
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1.2}>
        <Box sx={{ position: 'relative' }}>
          <Avatar
            sx={{
              width: compact ? 34 : 40,
              height: compact ? 34 : 40,
              fontSize: compact ? '0.72rem' : '0.82rem',
              fontWeight: 800,
              color: participant.status === 'error' ? 'error.light' : 'primary.contrastText',
              background: participant.status === 'error'
                ? alpha(theme.palette.error.main, 0.25)
                : `linear-gradient(145deg, ${theme.palette.primary.main}, ${theme.palette.secondary.main})`,
            }}
          >
            {initials || <ForumRounded fontSize="small" />}
          </Avatar>
          {participant.status === 'running' && (
            <CircularProgress
              size={compact ? 40 : 46}
              thickness={2.5}
              sx={{ position: 'absolute', inset: -3, color: 'primary.light' }}
            />
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={0.7} alignItems="center">
            <Typography variant="body2" fontWeight={720} noWrap>{participant.name}</Typography>
            {participant.role === 'moderator' && (
              <Tooltip title={t('meetings.moderator')}>
                <AutoAwesomeRounded sx={{ color: 'secondary.main', fontSize: 15 }} />
              </Tooltip>
            )}
          </Stack>
          {participant.error ? (
            <Tooltip title={participant.error}>
              <Typography variant="caption" color="error" noWrap>{participant.error}</Typography>
            </Tooltip>
          ) : (
            <Typography variant="caption" color="text.secondary" noWrap>
              {participant.status === 'running'
                ? t('meetings.participant.thinking')
                : participant.status === 'waiting' && waitingForNames.length
                  ? t('meetings.participant.waitingFor', { names: waitingForNames.join(', ') })
                  : t(statusKeys[participant.status])}
            </Typography>
          )}
        </Box>
        <Chip
          size="small"
          color={statusColors[participant.status]}
          variant={participant.status === 'idle' ? 'outlined' : 'filled'}
          label={t(statusKeys[participant.status])}
          icon={participant.status === 'error'
            ? <ErrorOutlineRounded />
            : participant.status === 'left'
              ? <LogoutRounded />
              : undefined}
          sx={{ display: { xs: 'none', sm: 'inline-flex' } }}
        />
      </Stack>
    </Paper>
  );
}
