"use client";

import React from 'react';
import { Chip, Tooltip } from '@mui/material';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { useI18n } from '@/frontend/contexts/I18nContext';

export interface SubflowLaneChipProps {
  result: NonNullable<FlujoChatMessage['subflowResult']>;
}

/** Identifies an assistant message produced by one lane of a parallel subflow. */
const SubflowLaneChip = ({ result }: SubflowLaneChipProps) => {
  const { t } = useI18n();
  const index = result.laneIndex + 1;
  const lane = result.laneTitle
    || result.subflowName
    || t('chat.messages.subflowLaneFallback', { index });

  return (
    <Tooltip
      title={t('chat.messages.subflowLaneTooltip', {
        subflow: result.subflowName || result.subflowId,
        index,
        count: result.laneCount,
      })}
    >
      <Chip
        data-testid="subflow-lane-chip"
        label={t('chat.messages.subflowLane', {
          lane,
          index,
          count: result.laneCount,
        })}
        size="small"
        color={result.status === 'error' ? 'error' : 'success'}
        variant="outlined"
        sx={{ height: 20, fontSize: '0.7rem', mr: 1, maxWidth: 260 }}
      />
    </Tooltip>
  );
};

export default SubflowLaneChip;
