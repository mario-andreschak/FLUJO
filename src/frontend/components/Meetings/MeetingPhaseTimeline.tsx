"use client";

import { Box, Chip, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { CheckRounded } from '@mui/icons-material';
import type { MeetingEvent, MeetingPhase, MeetingRecord } from '@/shared/types/meeting';
import type { TranslationKey } from '@/frontend/i18n';
import { useI18n } from '@/frontend/contexts/I18nContext';

const labels: Record<Exclude<MeetingPhase, 'draft' | 'completed'>, TranslationKey> = {
  opening: 'meetings.phase.opening',
  discussion: 'meetings.phase.discussion',
  ballot: 'meetings.phase.ballot',
  breakout: 'meetings.phase.breakout',
  closing: 'meetings.phase.closing',
};

export function meetingPhaseSteps(meeting: MeetingRecord, events: MeetingEvent[]) {
  const hasBallot = meeting.policy.moderatorMode === 'facilitated'
    || meeting.phase === 'ballot'
    || meeting.motions.length > 0
    || events.some((event) => event.type === 'motion:opened');
  const hasBreakout = meeting.phase === 'breakout'
    || events.some((event) => event.type.startsWith('breakout:'));
  const hasClosing = meeting.policy.moderatorMode !== 'none'
    || meeting.phase === 'closing'
    || events.some((event) => event.type === 'meeting:closing');
  return [
    'opening',
    'discussion',
    ...(hasBallot ? ['ballot'] as const : []),
    ...(hasBreakout ? ['breakout'] as const : []),
    ...(hasClosing ? ['closing'] as const : []),
  ] satisfies Array<Exclude<MeetingPhase, 'draft' | 'completed'>>;
}

interface MeetingPhaseTimelineProps {
  meeting: MeetingRecord;
  events: MeetingEvent[];
}

export default function MeetingPhaseTimeline({ meeting, events }: MeetingPhaseTimelineProps) {
  const { t } = useI18n();
  const theme = useTheme();
  const steps = meetingPhaseSteps(meeting, events);
  const activeIndex = steps.indexOf(meeting.phase as (typeof steps)[number]);
  const finished = meeting.status === 'completed';
  const observed = new Set<MeetingPhase>();
  for (const event of events) {
    if (event.type === 'round:started') observed.add(event.round.phase);
    if (event.type === 'breakout:started') observed.add('breakout');
    if (event.type === 'meeting:closing') observed.add('closing');
  }

  return (
    <Box aria-label={t('meetings.timeline.label')} sx={{ px: { xs: 2, sm: 2.5 }, pb: 2.25 }}>
      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.8 }}>
        {t('meetings.timeline.label')}
      </Typography>
      <Stack direction="row" alignItems="center" sx={{ overflowX: 'auto', pb: 0.25 }}>
        {steps.map((phase, index) => {
          const active = meeting.phase === phase;
          const complete = finished || index < activeIndex || (!active && observed.has(phase));
          return (
            <Stack key={phase} direction="row" alignItems="center" sx={{ flex: index === steps.length - 1 ? '0 0 auto' : '1 0 auto' }}>
              <Chip
                size="small"
                icon={complete ? <CheckRounded /> : undefined}
                color={active ? 'primary' : complete ? 'success' : 'default'}
                variant={active || complete ? 'filled' : 'outlined'}
                label={t(labels[phase])}
                aria-current={active ? 'step' : undefined}
                sx={{
                  fontWeight: active ? 780 : 650,
                  boxShadow: active ? `0 0 0 4px ${alpha(theme.palette.primary.main, 0.12)}` : undefined,
                }}
              />
              {index < steps.length - 1 && (
                <Box
                  aria-hidden
                  sx={{
                    minWidth: 18,
                    height: 2,
                    flex: 1,
                    mx: 0.75,
                    bgcolor: complete ? 'success.main' : alpha(theme.palette.text.primary, 0.14),
                  }}
                />
              )}
            </Stack>
          );
        })}
      </Stack>
    </Box>
  );
}
