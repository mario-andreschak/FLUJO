"use client";

import {
  Avatar,
  AvatarGroup,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import {
  AddRounded,
  ArrowForwardRounded,
  ForumRounded,
  GroupsRounded,
  HistoryRounded,
} from '@mui/icons-material';
import type { MeetingSummary } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import MeetingStatusChip from './MeetingStatusChip';

interface MeetingListProps {
  meetings: MeetingSummary[];
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase();

export default function MeetingList({ meetings, loading, onSelect, onCreate }: MeetingListProps) {
  const { t, formatDate } = useI18n();
  const theme = useTheme();

  if (loading) {
    return <Stack alignItems="center" justifyContent="center" spacing={1.5} sx={{ minHeight: 360 }}><CircularProgress /><Typography color="text.secondary">{t('meetings.list.loading')}</Typography></Stack>;
  }

  if (meetings.length === 0) {
    return (
      <Paper
        variant="outlined"
        sx={{
          position: 'relative',
          overflow: 'hidden',
          minHeight: 430,
          display: 'grid',
          placeItems: 'center',
          px: 3,
          py: 7,
          textAlign: 'center',
          background: `radial-gradient(circle at 50% 25%, ${alpha(theme.palette.primary.main, 0.13)}, transparent 38%), ${alpha(theme.palette.background.paper, 0.76)}`,
        }}
      >
        <Stack alignItems="center" spacing={2} sx={{ position: 'relative', zIndex: 1, maxWidth: 560 }}>
          <Box sx={{ position: 'relative', width: 150, height: 80 }} aria-hidden="true">
            {[-1, 0, 1].map((offset, index) => (
              <Avatar
                key={offset}
                sx={{
                  position: 'absolute',
                  top: index === 1 ? 0 : 20,
                  left: 50 + offset * 37,
                  width: index === 1 ? 58 : 48,
                  height: index === 1 ? 58 : 48,
                  color: index === 1 ? 'primary.contrastText' : 'text.secondary',
                  bgcolor: index === 1 ? 'primary.main' : alpha(theme.palette.text.primary, 0.08),
                  border: `3px solid ${theme.palette.background.paper}`,
                  boxShadow: `0 12px 30px ${alpha(theme.palette.common.black, 0.12)}`,
                }}
              >
                {index === 1 ? <ForumRounded /> : <GroupsRounded fontSize="small" />}
              </Avatar>
            ))}
          </Box>
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 780, letterSpacing: '-0.035em' }}>{t('meetings.empty.title')}</Typography>
            <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 520 }}>{t('meetings.empty.description')}</Typography>
          </Box>
          <Button variant="contained" size="large" startIcon={<AddRounded />} onClick={onCreate}>{t('meetings.new')}</Button>
          <Stack direction="row" flexWrap="wrap" justifyContent="center" gap={1}>
            <Chip size="small" variant="outlined" label={t('meetings.empty.parallel')} />
            <Chip size="small" variant="outlined" label={t('meetings.empty.private')} />
            <Chip size="small" variant="outlined" label={t('meetings.empty.moderated')} />
          </Stack>
        </Stack>
      </Paper>
    );
  }

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 2 }}>
        <HistoryRounded color="action" />
        <Typography variant="h6" sx={{ fontWeight: 730 }}>{t('meetings.list.recent')}</Typography>
        <Chip size="small" label={meetings.length} />
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
        {meetings.map((meeting) => (
          <Card
            key={meeting.id}
            variant="outlined"
            sx={{
              height: '100%',
              transition: 'transform 170ms ease, border-color 170ms ease, box-shadow 170ms ease',
              '&:hover': { transform: 'translateY(-2px)', borderColor: alpha(theme.palette.primary.main, 0.4), boxShadow: `0 14px 40px ${alpha(theme.palette.common.black, 0.09)}` },
            }}
          >
            <CardActionArea onClick={() => onSelect(meeting.id)} sx={{ p: 2.2, height: '100%' }}>
              <Stack spacing={2} sx={{ height: '100%' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                  <MeetingStatusChip status={meeting.status} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(meeting.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </Typography>
                </Stack>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h6" sx={{ fontWeight: 760, letterSpacing: '-0.02em' }}>{meeting.title}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.6 }}>
                    {t('meetings.list.roundSummary', { current: meeting.roundNumber, total: meeting.participantCount })}
                  </Typography>
                </Box>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <AvatarGroup max={5} sx={{ justifyContent: 'flex-end', '& .MuiAvatar-root': { width: 30, height: 30, fontSize: '0.68rem', fontWeight: 750 } }}>
                    {meeting.participantNames.map((name) => <Avatar key={name}>{initials(name)}</Avatar>)}
                  </AvatarGroup>
                  <Stack direction="row" spacing={0.5} alignItems="center" color="primary.light">
                    <Typography variant="caption" fontWeight={750}>{t('meetings.list.open')}</Typography>
                    <ArrowForwardRounded fontSize="small" />
                  </Stack>
                </Stack>
              </Stack>
            </CardActionArea>
          </Card>
        ))}
      </Box>
    </Box>
  );
}

