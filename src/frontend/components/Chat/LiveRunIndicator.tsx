"use client";

import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Typography } from '@mui/material';

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
}

/**
 * The "Running… N tokens · Ns elapsed" indicator with its own 1-second tick.
 *
 * The tick lives HERE, not in the Chat container: when it sat in Chat, every
 * second re-rendered the entire component tree — including every message
 * bubble with its markdown parse — for the whole duration of a run. Mounted
 * only while the viewed conversation is running, so the interval's lifecycle
 * is simply this component's lifecycle.
 */
const LiveRunIndicator: React.FC<LiveRunIndicatorProps> = ({ liveStats, onStop, stopDisabled }) => {
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const elapsed = liveStats ? Math.max(0, Math.round((nowTick - liveStats.startedAt) / 1000)) : 0;
  const sinceLast = liveStats ? Math.round((nowTick - liveStats.lastEventAt) / 1000) : 0;
  const stuck = !!liveStats && sinceLast >= 20;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', my: 2, gap: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <CircularProgress size={20} color={stuck ? 'warning' : 'primary'} />
        <Typography variant="body2" color="textSecondary">
          {liveStats?.activeNode ? `Running: ${liveStats.activeNode}` : 'Working…'}
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
      <Typography variant="caption" color={stuck ? 'warning.main' : 'textSecondary'}>
        {(liveStats?.totalTokens ?? 0).toLocaleString()} tokens · {elapsed}s elapsed
        {stuck ? ` · no activity for ${sinceLast}s — may be stuck` : ''}
      </Typography>
    </Box>
  );
};

export default LiveRunIndicator;
