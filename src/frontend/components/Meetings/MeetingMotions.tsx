"use client";

import { useMemo, useState } from 'react';
import {
  Avatar,
  Box,
  Chip,
  Dialog,
  DialogContent,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { HowToVoteRounded } from '@mui/icons-material';
import type { MeetingMotion, MeetingRecord, MeetingVoteChoice } from '@/shared/types/meeting';
import { useI18n } from '@/frontend/contexts/I18nContext';
import DialogHeaderActions from '@/frontend/components/shared/DialogHeaderActions';

export function summarizeMotion(motion: MeetingMotion): string {
  const source = (motion.proposal || motion.reason || motion.kind).trim();
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [source];
  const summary = sentences.slice(0, 2).join(' ').trim();
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}…` : summary;
}

const voteColors: Record<MeetingVoteChoice, 'success' | 'error' | 'default'> = {
  yes: 'success',
  no: 'error',
  abstain: 'default',
};

interface MeetingMotionsProps {
  meeting: MeetingRecord;
  motions?: MeetingMotion[];
}

export default function MeetingMotions({ meeting, motions = meeting.motions }: MeetingMotionsProps) {
  const { t, formatDate } = useI18n();
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = motions.find((motion) => motion.id === selectedId) ?? null;
  const tally = useMemo(() => {
    if (!selected) return null;
    return (['yes', 'no', 'abstain'] as const).reduce<Record<MeetingVoteChoice, number>>((result, choice) => {
      result[choice] = selected.votes.filter((vote) => vote.choice === choice).length;
      return result;
    }, { yes: 0, no: 0, abstain: 0 });
  }, [selected]);

  if (!motions.length) return null;
  return (
    <>
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction="row" spacing={0.8} alignItems="center" sx={{ mb: 1.2 }}>
          <HowToVoteRounded color="secondary" fontSize="small" />
          <Typography variant="subtitle2" fontWeight={750}>{t('meetings.motions')}</Typography>
          <Chip size="small" variant="outlined" label={motions.length} sx={{ ml: 'auto' }} />
        </Stack>
        <Stack spacing={1}>
          {motions.slice().reverse().slice(0, 4).map((motion) => (
            <Paper
              key={motion.id}
              component="button"
              type="button"
              variant="outlined"
              onClick={() => setSelectedId(motion.id)}
              sx={{
                p: 1.2,
                width: '100%',
                textAlign: 'left',
                font: 'inherit',
                color: 'inherit',
                cursor: 'pointer',
                bgcolor: alpha(theme.palette.secondary.main, 0.035),
                '&:hover': { borderColor: 'secondary.main', bgcolor: alpha(theme.palette.secondary.main, 0.075) },
              }}
            >
              <Stack direction="row" justifyContent="space-between" spacing={1} alignItems="flex-start">
                <Typography variant="body2" fontWeight={700} sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {summarizeMotion(motion)}
                </Typography>
                <Chip size="small" color={motion.status === 'accepted' ? 'success' : motion.status === 'open' ? 'secondary' : 'default'} label={motion.status} />
              </Stack>
              <Typography variant="caption" color="text.secondary">{t('meetings.motion.votes', { count: motion.votes.length })}</Typography>
            </Paper>
          ))}
        </Stack>
      </Paper>

      <Dialog open={Boolean(selected)} onClose={() => setSelectedId(null)} fullWidth maxWidth="sm">
        <DialogHeaderActions title={t('meetings.motion.detailTitle')} onClose={() => setSelectedId(null)} showAskFlujo={false} showBugReport={false} />
        {selected && tally && (
          <DialogContent dividers>
            <Stack spacing={2.2}>
              <Box>
                <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Chip size="small" color="secondary" label={selected.kind} />
                  <Chip size="small" variant="outlined" label={selected.status} />
                  <Typography variant="caption" color="text.secondary">
                    {formatDate(selected.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
                  </Typography>
                </Stack>
                <Typography variant="h6" sx={{ mt: 1.25, fontWeight: 760 }}>{selected.proposal || selected.kind}</Typography>
                {selected.reason && <Typography color="text.secondary" sx={{ mt: 0.8, whiteSpace: 'pre-wrap' }}>{selected.reason}</Typography>}
              </Box>
              <Divider />
              <Box>
                <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" fontWeight={750}>{t('meetings.motion.voteBreakdown')}</Typography>
                  <Typography variant="caption" color="text.secondary">{t('meetings.motion.votes', { count: selected.votes.length })}</Typography>
                </Stack>
                <Stack direction="row" spacing={1}>
                  {(['yes', 'no', 'abstain'] as const).map((choice) => (
                    <Chip key={choice} color={voteColors[choice]} variant={tally[choice] ? 'filled' : 'outlined'} label={`${t(`meetings.motion.${choice}`)} · ${tally[choice]}`} />
                  ))}
                </Stack>
                <LinearProgress
                  variant="determinate"
                  value={selected.votes.length ? (tally.yes / selected.votes.length) * 100 : 0}
                  color="success"
                  sx={{ mt: 1.5, height: 7, borderRadius: 4 }}
                />
              </Box>
              <Stack spacing={1}>
                {meeting.participants.map((participant) => {
                  const vote = selected.votes.find((item) => item.participantId === participant.id);
                  return (
                    <Paper key={participant.id} variant="outlined" sx={{ p: 1.2 }}>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Avatar sx={{ width: 30, height: 30, fontSize: '0.65rem' }}>{participant.name.slice(0, 2).toUpperCase()}</Avatar>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={700}>{participant.name}</Typography>
                          {vote?.rationale && <Typography variant="caption" color="text.secondary">{vote.rationale}</Typography>}
                        </Box>
                        <Chip size="small" color={vote ? voteColors[vote.choice] : 'default'} variant={vote ? 'filled' : 'outlined'} label={vote ? t(`meetings.motion.${vote.choice}`) : t('meetings.motion.pending')} />
                      </Stack>
                    </Paper>
                  );
                })}
              </Stack>
            </Stack>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
