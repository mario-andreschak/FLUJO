"use client";

import { Avatar, Badge, Box, Chip, Paper, Stack, Tooltip, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { AutoAwesomeRounded } from '@mui/icons-material';
import type { MeetingParticipant } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import { meetingParticipantSourceLabel } from './meetingParticipantPresentation';

const seats = [
  { left: '50%', top: '2%', transform: 'translate(-50%, 0)' },
  { left: '82%', top: '18%', transform: 'translate(-50%, 0)' },
  { left: '92%', top: '61%', transform: 'translate(-50%, -50%)' },
  { left: '69%', top: '91%', transform: 'translate(-50%, -100%)' },
  { left: '31%', top: '91%', transform: 'translate(-50%, -100%)' },
  { left: '8%', top: '61%', transform: 'translate(-50%, -50%)' },
  { left: '18%', top: '18%', transform: 'translate(-50%, 0)' },
] as const;

interface MeetingTableProps {
  participants: MeetingParticipant[];
  onParticipantClick?: (participantId: string) => void;
}

export default function MeetingTable({ participants, onParticipantClick }: MeetingTableProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const visible = participants.slice(0, 7);
  const overflow = participants.slice(7);

  return (
    <Paper
      variant="outlined"
      sx={{
        mb: 2,
        height: { xs: 285, sm: 340 },
        position: 'relative',
        overflow: 'hidden',
        background: `radial-gradient(circle at 50% 50%, ${alpha(theme.palette.primary.main, 0.08)}, transparent 62%)`,
      }}
    >
      <Box
        aria-label={t('meetings.table.label')}
        sx={{
          position: 'absolute',
          left: '24%',
          right: '24%',
          top: '24%',
          bottom: '24%',
          borderRadius: '48%',
          border: `1px solid ${alpha(theme.palette.primary.main, 0.28)}`,
          background: `linear-gradient(145deg, ${alpha(theme.palette.background.paper, 0.95)}, ${alpha(theme.palette.primary.dark, 0.12)})`,
          boxShadow: `inset 0 0 0 8px ${alpha(theme.palette.primary.main, 0.025)}, 0 18px 60px ${alpha(theme.palette.common.black, 0.13)}`,
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
                width: { xs: 78, sm: 112 },
                p: 0,
                border: 0,
                color: 'inherit',
                bgcolor: 'transparent',
                cursor: participant ? 'pointer' : 'default',
                font: 'inherit',
              }}
            >
              <Badge
                color={participant?.status === 'error' ? 'error' : participant?.status === 'running' ? 'success' : 'default'}
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
                    border: `3px solid ${theme.palette.background.paper}`,
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
                      bgcolor: alpha(theme.palette.background.paper, 0.92),
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
