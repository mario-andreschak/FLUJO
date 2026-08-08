'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import ScheduleIcon from '@mui/icons-material/Schedule';
import type { Wave, WavesResponse } from '@/shared/types/waves/waves';
import { wavesService } from '@/frontend/services/waves';
import { createLogger } from '@/utils/logger';
import { useListScrollNav } from '@/frontend/hooks/useListScrollNav';
import { useUiPreference } from '@/frontend/hooks/useUiPreference';
import ScrollNavCluster from '@/frontend/components/shared/ScrollNavCluster';
import WaveCanvas from './WaveCanvas';
import { formatIn } from './waveTimeline';
import { useI18n } from '@/frontend/contexts/I18nContext';

const log = createLogger('frontend/components/Waves');

/** How often to refresh the wave graph (picks up live nextRun / config edits). */
const POLL_INTERVAL_MS = 30_000;

/** Persisted selection so a reload / poll keeps the same wave open (#209). */
const SELECTED_PREF_KEY = 'flujo-ui:waves:selected';

/** Root name(s) for a wave, used as its dashboard/detail title. */
function rootNamesOf(wave: Wave): string[] {
  return wave.nodes
    .filter((n) => wave.rootExecutionIds.includes(n.executionId))
    .map((n) => n.name);
}

function titleOf(wave: Wave, fallback = 'Wave'): string {
  const names = rootNamesOf(wave);
  return names.length > 0 ? names.join(', ') : fallback;
}

/** Whether any root drifts on the time axis (has a cron/poll schedule). */
function isTimeBased(wave: Wave): boolean {
  return wave.nodes.some((n) => n.timing.mode === 'timeline');
}

/** Earliest known upcoming run (ms) among the wave's scheduled roots, if any. */
function nextRunOf(wave: Wave): number | null {
  let earliest: number | null = null;
  for (const n of wave.nodes) {
    if (n.timing.mode === 'timeline' && n.timing.nextRun) {
      const t = Date.parse(n.timing.nextRun);
      if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
    }
  }
  return earliest;
}

interface WaveSummaryCardProps {
  wave: Wave;
  selected: boolean;
  now: number;
  onSelect: () => void;
}

/** Compact overview card for a single wave in the dashboard list (#209). */
function WaveSummaryCard({ wave, selected, now, onSelect }: WaveSummaryCardProps) {
  const { t, tp } = useI18n();
  const timeBased = isTimeBased(wave);
  const nextRun = timeBased ? nextRunOf(wave) : null;
  const title = titleOf(wave, t('waves.fallbackName'));
  return (
    <Paper
      variant="outlined"
      onClick={onSelect}
      sx={{
        p: 1.25,
        cursor: 'pointer',
        borderColor: selected ? 'primary.main' : undefined,
        borderWidth: selected ? 2 : 1,
        bgcolor: selected ? 'action.selected' : 'background.paper',
        transition: 'border-color 120ms ease, background-color 120ms ease',
        '&:hover': { borderColor: 'primary.light' },
      }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600, lineHeight: 1.25 }} noWrap title={title}>
        {title}
      </Typography>
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }}>
        <Chip label={tp('waves.triggerCount', wave.nodes.length)} size="small" variant="outlined" />
        {timeBased && <Chip label={t('waves.timeBased')} size="small" color="info" variant="outlined" />}
        {wave.hasCycle && <Chip label={t('waves.recursive')} color="warning" size="small" />}
      </Stack>
      {timeBased && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.75, opacity: 0.75 }}>
          <ScheduleIcon sx={{ fontSize: 14 }} />
          <Typography variant="caption">
            {t('waves.nextRun', { time: nextRun ? formatIn(nextRun, now, t) : t('waves.notScheduled') })}
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

/**
 * Waves section (#128): a read-only visualization of how Planned Executions
 * chain together via signals and completion events.
 *
 * The surface is a dashboard + detail split (#209): a scrollable list of compact
 * wave summaries on the left, and the selected wave rendered on a large canvas on
 * the right (stacked mini-canvases were too small). Selection persists across
 * reloads and the 30s poll.
 */
export type WavesManagerHeight = number | string | {
  xs: number | string;
  sm?: number | string;
  md?: number | string;
  lg?: number | string;
  xl?: number | string;
};

interface WavesManagerProps {
  /** Definite height supplied by a full-page route; embedded views keep using their parent height. */
  height?: WavesManagerHeight;
}

export default function WavesManager({ height = '100%' }: WavesManagerProps) {
  const { t, tp } = useI18n();
  const [data, setData] = useState<WavesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useUiPreference<string | null>(SELECTED_PREF_KEY, null);

  // Persist the LIST scroll position + back-to-top (#185); re-restore on new data.
  const { ref: scrollRef, clusterProps: scrollNavProps } = useListScrollNav<HTMLDivElement>(
    'flujo-ui:scroll:waves',
    { deps: [data], groupsEnabled: false },
  );

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

  // Keep summary "next run in Xh" labels fresh without thrashing.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const waves = useMemo(() => data?.waves ?? [], [data]);
  const orphans = data?.orphans ?? [];

  // Resolve the selected wave, falling back to the first when the stored id is
  // gone (deleted execution, config change) or nothing is selected yet.
  const selectedWave = useMemo(() => {
    if (waves.length === 0) return null;
    return waves.find((w) => w.id === selectedId) ?? waves[0];
  }, [waves, selectedId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height, minHeight: 0 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, height, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <WavesIcon color="primary" />
        <Typography variant="h5" sx={{ fontWeight: 600 }}>
          {t('waves.title')}
        </Typography>
        <Chip label={t('waves.experimental')} size="small" color="warning" variant="outlined" />
        {data?.paused && <Chip label={t('waves.schedulerPaused')} color="warning" size="small" />}
      </Box>
      <Typography variant="body2" sx={{ opacity: 0.75, mb: 2 }}>
        {t('waves.description')}
      </Typography>

      {waves.length === 0 && orphans.length === 0 && (
        <Alert severity="info">
          {t('waves.empty')}
        </Alert>
      )}

      {(waves.length > 0 || orphans.length > 0) && (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 2 }}>
          {/* Dashboard: scrollable list of wave summaries + unlinked triggers. */}
          <Box
            ref={scrollRef}
            sx={{ width: 320, flexShrink: 0, overflow: 'auto', pr: 0.5 }}
          >
            <Stack spacing={1}>
              {waves.map((wave) => (
                <WaveSummaryCard
                  key={wave.id}
                  wave={wave}
                  now={now}
                  selected={selectedWave?.id === wave.id}
                  onSelect={() => setSelectedId(wave.id)}
                />
              ))}
            </Stack>

            {orphans.length > 0 && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
                  {t('waves.unlinkedTitle')}
                </Typography>
                <Typography variant="caption" sx={{ display: 'block', opacity: 0.75, mb: 1 }}>
                  {t('waves.unlinkedDescription')}
                </Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {orphans.map((o) => (
                    <Chip key={o.executionId} label={`${o.name} → ${o.flowName ?? o.flowId}`} size="small" />
                  ))}
                </Stack>
              </>
            )}

            <ScrollNavCluster {...scrollNavProps} actions={['top', 'bottom']} />
          </Box>

          {/* Detail: the selected wave on a large canvas. */}
          <Box sx={{ flex: 1, minHeight: 0 }}>
            {selectedWave ? (
              <Paper
                variant="outlined"
                sx={{ p: 1.5, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap title={titleOf(selectedWave, t('waves.fallbackName'))}>
                    {titleOf(selectedWave, t('waves.fallbackName'))}
                  </Typography>
                  <Chip label={tp('waves.triggerCount', selectedWave.nodes.length)} size="small" variant="outlined" />
                  {selectedWave.hasCycle && <Chip label={t('waves.recursive')} color="warning" size="small" />}
                </Box>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                  <WaveCanvas key={selectedWave.id} wave={selectedWave} height="100%" />
                </Box>
              </Paper>
            ) : (
              <Box
                sx={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.6,
                }}
              >
                <Typography variant="body2">{t('waves.selectPrompt')}</Typography>
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}
