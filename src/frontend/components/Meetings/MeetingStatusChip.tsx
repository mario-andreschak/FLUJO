"use client";

import { Chip } from '@mui/material';
import {
  CheckCircleRounded,
  ErrorOutlineRounded,
  FiberManualRecordRounded,
  PauseCircleOutlineRounded,
  ScheduleRounded,
  StopCircleRounded,
} from '@mui/icons-material';
import type { MeetingStatus } from '@/shared/types/meeting';
import type { TranslationKey } from '@/frontend/i18n';
import { useI18n } from '@/frontend/contexts/I18nContext';

const labels: Record<MeetingStatus, TranslationKey> = {
  draft: 'meetings.status.draft',
  running: 'meetings.status.running',
  paused: 'meetings.status.paused',
  completed: 'meetings.status.completed',
  cancelled: 'meetings.status.cancelled',
  error: 'meetings.status.error',
};

const colors: Record<MeetingStatus, 'default' | 'primary' | 'warning' | 'success' | 'error'> = {
  draft: 'default',
  running: 'primary',
  paused: 'warning',
  completed: 'success',
  cancelled: 'warning',
  error: 'error',
};

const icons: Record<MeetingStatus, React.ReactElement> = {
  draft: <ScheduleRounded />,
  running: <FiberManualRecordRounded />,
  paused: <PauseCircleOutlineRounded />,
  completed: <CheckCircleRounded />,
  cancelled: <StopCircleRounded />,
  error: <ErrorOutlineRounded />,
};

export default function MeetingStatusChip({ status, size = 'small' }: { status: MeetingStatus; size?: 'small' | 'medium' }) {
  const { t } = useI18n();
  return (
    <Chip
      size={size}
      color={colors[status]}
      variant={status === 'draft' ? 'outlined' : 'filled'}
      icon={icons[status]}
      label={t(labels[status])}
      sx={status === 'running' ? {
        '& .MuiChip-icon': {
          fontSize: 10,
          animation: 'meetingPulse 1.6s ease-in-out infinite',
          '@keyframes meetingPulse': { '50%': { opacity: 0.35 } },
        },
      } : undefined}
    />
  );
}

