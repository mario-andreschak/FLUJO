'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import WavesIcon from '@mui/icons-material/Waves';
import type { WavesResponse } from '@/shared/types/waves/waves';
import { wavesService } from '@/frontend/services/waves';
import { createLogger } from '@/utils/logger';
import WaveCanvas from './WaveCanvas';

const log = createLogger('frontend/components/Waves');

/** How often to refresh the wave graph (picks up live nextRun / config edits). */
const POLL_INTERVAL_MS = 30_000;

/**
 * Waves section (#128): a read-only visualization of how Planned Executions
 * chain together via signals and completion events. Each wave renders on its
 * own canvas; cron/poll roots drift on a timeline, webhook/file-watch roots are
 * pinned left.
 */
export default function WavesManager() {
  const [data, setData] = useState<WavesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const response = await wavesService.list();
    setData(response);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      log.warn('Initial waves load failed', error);
      setLoading(false);
    });
    const t = setInterval(() => {
      refresh().catch((error) => log.warn('Waves refresh failed', error));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress />
      </Box>
    );
  }

  const waves = data?.waves ?? [];
  const orphans = data?.orphans ?? [];

  return (
    <Box sx={{ p: 3, height: '100%', overflow: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <WavesIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          Waves
        </Typography>
        {data?.paused && <Chip label="Scheduler paused" color="warning" size="small" />}
      </Box>
      <Typography variant="body2" sx={{ opacity: 0.75, mb: 2 }}>
        A read-only picture of how your Planned Executions chain together via signals and completion
        events. Each lane reads as a timeline — the clock on the left is “now”, and scheduled runs
        approach from the right. Hover a card to follow its chain; use the window control to zoom the
        timeline out and reveal upcoming runs. Nothing here arms or fires anything.
      </Typography>

      {waves.length === 0 && orphans.length === 0 && (
        <Alert severity="info">
          No planned executions to visualize yet. Create some executions (and link them with
          flow-event triggers or signal nodes) to see waves here.
        </Alert>
      )}

      <Stack spacing={3}>
        {waves.map((wave) => {
          const rootNames = wave.nodes
            .filter((n) => wave.rootExecutionIds.includes(n.executionId))
            .map((n) => n.name);
          return (
            <Paper key={wave.id} variant="outlined" sx={{ p: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  {rootNames.length > 0 ? rootNames.join(', ') : 'Wave'}
                </Typography>
                <Chip label={`${wave.nodes.length} execution(s)`} size="small" variant="outlined" />
                {wave.hasCycle && <Chip label="recursive" color="warning" size="small" />}
              </Box>
              <WaveCanvas wave={wave} />
            </Paper>
          );
        })}
      </Stack>

      {orphans.length > 0 && (
        <>
          <Divider sx={{ my: 3 }} />
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
            Unlinked event triggers
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.75, mb: 1 }}>
            These flow-event triggers reference a source that matches no known producer, so they
            never start from an organic trigger.
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            {orphans.map((o) => (
              <Chip key={o.executionId} label={`${o.name} → ${o.flowName ?? o.flowId}`} size="small" />
            ))}
          </Stack>
        </>
      )}
    </Box>
  );
}
