"use client";

import { Avatar, Badge, Box, Chip, CircularProgress, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { AutoAwesomeRounded } from '@mui/icons-material';
import type { MeetingParticipant } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { meetingParticipantSourceLabel } from './meetingParticipantPresentation';

const seats = [
  { left: '50%', top: '14%', transform: 'translate(-50%, -50%)' },
  { left: '82%', top: '28%', transform: 'translate(-50%, -50%)' },
  { left: '91%', top: '64%', transform: 'translate(-50%, -50%)' },
  { left: '69%', top: '84%', transform: 'translate(-50%, -50%)' },
  { left: '31%', top: '84%', transform: 'translate(-50%, -50%)' },
  { left: '9%', top: '64%', transform: 'translate(-50%, -50%)' },
  { left: '18%', top: '28%', transform: 'translate(-50%, -50%)' },
] as const;

interface MeetingTableProps {
  participants: MeetingParticipant[];
  onParticipantClick?: (participantId: string) => void;
}

export default function MeetingTable({ participants, onParticipantClick }: MeetingTableProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const roomSurface = theme.palette.mode === 'dark' ? '#151a2b' : '#f3f6fb';
  const tableSurface = theme.palette.mode === 'dark' ? '#222a42' : '#e7edf7';
  const visible = participants.slice(0, 7);
  const overflow = participants.slice(7);
  const thinkingNames = participants
    .filter((participant) => participant.status === 'running')
    .map((participant) => participant.name);

  return (
    <Paper
      variant="outlined"
      sx={{
        mb: 2,
        height: { xs: 310, sm: 360 },
        position: 'relative',
        overflow: 'hidden',
        borderColor: alpha(theme.palette.primary.main, 0.3),
        bgcolor: roomSurface,
        backgroundImage: `radial-gradient(circle at 50% 48%, ${alpha(theme.palette.primary.main, 0.16)}, transparent 62%)`,
        boxShadow: `0 16px 48px ${alpha(theme.palette.common.black, 0.16)}`,
      }}
    >
      <Box
        aria-label={t('meetings.table.label')}
        sx={{
          position: 'absolute',
          left: '20%',
          right: '20%',
          top: '27%',
          bottom: '22%',
          borderRadius: '48%',
          border: `2px solid ${alpha(theme.palette.primary.main, 0.38)}`,
          bgcolor: tableSurface,
          backgroundImage: `linear-gradient(145deg, ${alpha(theme.palette.common.white, theme.palette.mode === 'dark' ? 0.04 : 0.45)}, ${alpha(theme.palette.primary.dark, 0.14)})`,
          boxShadow: `inset 0 0 0 8px ${alpha(theme.palette.primary.main, 0.045)}, 0 18px 60px ${alpha(theme.palette.common.black, 0.2)}`,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          px: 2,
        }}
      >
        <Box>
          <Typography variant="overline" color="primary.main">{t('meetings.table.room')}</Typography>
          <Typography variant="h6" fontWeight={790}>{t('meetings.table.agents', { count: participants.length })}</Typography>
          <Typography variant="caption" color="text.secondary">{t('meetings.table.help')}</Typography>
        </Box>
      </Box>

      {seats.map((position, index) => {
        const participant = visible[index];
        const initials = participant?.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
        const extraLabel = index === 6 && overflow.length
          ? t('meetings.table.overflow', { count: overflow.length })
          : null;
        const sourceLabel = participant
          ? meetingParticipantSourceLabel(participant, t)
          : null;
        const statusLabel = participant?.status === 'running'
          ? t('meetings.participant.thinking')
          : participant?.status === 'waiting'
            ? thinkingNames.length
              ? t('meetings.participant.waitingFor', { names: thinkingNames.join(', ') })
              : t('meetings.participant.waiting')
            : null;
        const title = participant
          ? `${participant.name} · ${sourceLabel}${overflow.length && index === 6 ? ` · ${overflow.map((item) => item.name).join(', ')}` : ''}`
          : t('meetings.table.emptySeat');
        return (
          <Tooltip key={index} title={title} arrow>
            <Stack
              component={participant ? 'button' : 'div'}
              type={participant ? 'button' : undefined}
              onClick={participant ? () => onParticipantClick?.(participant.id) : undefined}
              spacing={0.45}
              alignItems="center"
              sx={{
                position: 'absolute',
                ...position,
                width: { xs: 82, sm: 132 },
                minHeight: { xs: 76, sm: 92 },
                p: 0,
                border: 0,
                color: 'inherit',
                bgcolor: 'transparent',
                cursor: participant ? 'pointer' : 'default',
                font: 'inherit',
              }}
            >
              <Badge
                color={participant?.status === 'error' ? 'error' : participant?.status === 'running' ? 'success' : participant?.status === 'waiting' ? 'secondary' : 'default'}
                variant="dot"
                overlap="circular"
                invisible={!participant}
              >
                <Avatar
                  sx={{
                    width: { xs: 40, sm: 48 },
                    height: { xs: 40, sm: 48 },
                    fontSize: '0.75rem',
                    fontWeight: 800,
                    bgcolor: participant ? (participant.role === 'moderator' ? 'secondary.main' : 'primary.main') : alpha(theme.palette.text.primary, 0.06),
                    color: participant ? undefined : 'text.disabled',
                    border: `3px solid ${roomSurface}`,
                    boxShadow: `0 6px 18px ${alpha(theme.palette.common.black, 0.2)}`,
                  }}
                >
                  {initials ?? index + 1}
                </Avatar>
              </Badge>
              {participant ? (
                <>
                  <Chip
                    size="small"
                    icon={participant.role === 'moderator' ? <AutoAwesomeRounded /> : undefined}
                    label={extraLabel ?? participant.name}
                    variant="outlined"
                    sx={{
                      maxWidth: '100%',
                      height: 23,
                      bgcolor: roomSurface,
                      '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                    }}
                  />
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    noWrap
                    sx={{ maxWidth: '100%', fontSize: { xs: '0.61rem', sm: '0.7rem' } }}
                  >
                    {sourceLabel}
                  </Typography>
                  {statusLabel && (
                    <Stack direction="row" spacing={0.45} alignItems="center" sx={{ maxWidth: '100%' }}>
                      {participant.status === 'running' && <CircularProgress size={10} thickness={5} />}
                      <Typography
                        variant="caption"
                        color={participant.status === 'running' ? 'primary.main' : 'secondary.main'}
                        noWrap
                        sx={{ maxWidth: '100%', fontWeight: 700, fontSize: { xs: '0.58rem', sm: '0.68rem' } }}
                      >
                        {statusLabel}
                      </Typography>
                    </Stack>
                  )}
                </>
              ) : (
                <Typography variant="caption" color="text.disabled">{t('meetings.table.chair', { count: index + 1 })}</Typography>
              )}
            </Stack>
          </Tooltip>
        );
      })}
    </Paper>
  );
}
