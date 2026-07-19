"use client";

import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import { LiveLane, LiveLanes, laneList } from '@/utils/shared/liveLanes';

/** Live execution stats, driven by the SSE event stream while a run is active. */
export interface LiveRunStats {
  totalTokens: number;
  activeNode: string | null;
  startedAt: number;
  lastEventAt: number;
}

interface LiveRunIndicatorProps {
  liveStats: LiveRunStats | null;
  onStop: () => void;
  stopDisabled?: boolean;
  /** The run is parked at a tool-approval prompt: swap the spinner (which would
   *  falsely suggest activity next to the Approve/Reject buttons) for a static
   *  pause icon, and drop the elapsed/stall caption — but keep Stop reachable,
   *  since the run is still alive and holding the conversation. */
  awaitingApproval?: boolean;
  /** Per-lane progress rows for a parallel subflow fan-out (issue #157).
   *  Empty/absent → the exact pre-lane rendering. */
  lanes?: LiveLanes;
  /** Open a lane's persisted sidebar conversation (rows are clickable only
   *  when the lane carries a laneConversationId). */
  onOpenLane?: (conversationId: string) => void;
}

/** One compact progress row per lane: status icon, brief/label, current
 *  activity — clickable through to the lane's own conversation when it is
 *  persisted. The header above stays the parent's (activeNode is never
 *  touched by lane events), so dispatch, join and the post-join synthesis
 *  step all remain visible while the rows tell the per-worker story. */
const LaneRow: React.FC<{ lane: LiveLane; onOpenLane?: (conversationId: string) => void }> = ({ lane, onOpenLane }) => {
  const clickable = !!lane.laneConversationId && !!onOpenLane;
  const pending = lane.status === 'pending';
  return (
    <Box
      onClick={clickable ? () => onOpenLane!(lane.laneConversationId!) : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        ...(clickable && {
          cursor: 'pointer',
          '&:hover': { bgcolor: 'action.hover', textDecoration: 'underline' },
        }),
      }}
    >
      {lane.status === 'running' && <CircularProgress size={14} sx={{ flexShrink: 0 }} />}
      {lane.status === 'completed' && <CheckCircleIcon sx={{ fontSize: 16, flexShrink: 0 }} color="success" />}
      {lane.status === 'error' && <CancelIcon sx={{ fontSize: 16, flexShrink: 0 }} color="error" />}
      {pending && <RadioButtonUncheckedIcon sx={{ fontSize: 16, flexShrink: 0 }} color="disabled" />}
      <Typography
        variant="caption"
        color={pending ? 'text.disabled' : 'textSecondary'}
        sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {lane.label}
        {pending && ' — queued'}
        {lane.status === 'running' && lane.activity && (
          <Typography component="span" variant="caption" color="text.disabled">
            {' · '}{lane.activity}
          </Typography>
        )}
      </Typography>
    </Box>
  );
};

/** Summary caption for the lane block; switches to the warning-colored
 *  partial-failure marker once every lane is terminal and some failed. */
const laneSummary = (rows: LiveLane[]): { text: string; warning: boolean } => {
  const running = rows.filter(l => l.status === 'running').length;
  const queued = rows.filter(l => l.status === 'pending').length;
  const done = rows.filter(l => l.status === 'completed').length;
  const failed = rows.filter(l => l.status === 'error').length;
  if (running === 0 && queued === 0 && failed > 0) {
    return { text: `${failed}/${rows.length} lanes failed — partial results`, warning: true };
  }
  const parts = [
    running > 0 ? `${running} running` : '',
    queued > 0 ? `${queued} queued` : '',
    done > 0 ? `${done} done` : '',
    failed > 0 ? `${failed} failed` : '',
  ].filter(Boolean);
  return { text: `${rows.length} lanes — ${parts.join(', ')}`, warning: failed > 0 };
};

/**
 * The "Running… N tokens · Ns elapsed" indicator with its own 1-second tick.
 *
 * The tick lives HERE, not in the Chat container: when it sat in Chat, every
 * second re-rendered the entire component tree — including every message
 * bubble with its markdown parse — for the whole duration of a run. Mounted
 * only while the viewed conversation is running, so the interval's lifecycle
 * is simply this component's lifecycle.
 */
const LiveRunIndicator: React.FC<LiveRunIndicatorProps> = ({ liveStats, onStop, stopDisabled, awaitingApproval, lanes, onOpenLane }) => {
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = liveStats ? Math.max(0, Math.round((nowTick - liveStats.startedAt) / 1000)) : 0;
  const sinceLast = liveStats ? Math.round((nowTick - liveStats.lastEventAt) / 1000) : 0;
  const stuck = !awaitingApproval && !!liveStats && sinceLast >= 60;

  const laneRows = lanes ? laneList(lanes) : [];
  const summary = laneRows.length > 0 ? laneSummary(laneRows) : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', my: 2, gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {awaitingApproval ? (
          <PauseCircleOutlineIcon fontSize="small" color="warning" />
        ) : (
          <CircularProgress size={20} color={stuck ? 'warning' : 'primary'} />
        )}
        <Typography variant="body2" color="textSecondary">
          {awaitingApproval
            ? 'Waiting for tool approval'
            : liveStats?.activeNode ? `Running: ${liveStats.activeNode}` : 'Working…'}
        </Typography>
        <Button
          variant="outlined"
          color="secondary"
          size="small"
          onClick={onStop}
          disabled={stopDisabled}
        >
          Stop
        </Button>
      </Box>
      {summary && (
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', minWidth: 280, maxWidth: 520 }}>
          <Typography
            variant="caption"
            color={summary.warning ? 'warning.main' : 'textSecondary'}
            sx={{ px: 1, fontWeight: 500 }}
          >
            {summary.text}
          </Typography>
          {laneRows.map(lane => (
            <LaneRow key={lane.laneIndex} lane={lane} onOpenLane={onOpenLane} />
          ))}
        </Box>
      )}
      {!awaitingApproval && (
        <Typography variant="caption" color={stuck ? 'warning.main' : 'textSecondary'}>
          {(liveStats?.totalTokens ?? 0).toLocaleString()} tokens · {elapsed}s elapsed
          {stuck ? ` · no activity for ${sinceLast}s — may be stuck` : ''}
        </Typography>
      )}
    </Box>
  );
};

export default LiveRunIndicator;
