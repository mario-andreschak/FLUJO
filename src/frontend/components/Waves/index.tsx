'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CalendarViewDayRoundedIcon from '@mui/icons-material/CalendarViewDayRounded';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import HubRoundedIcon from '@mui/icons-material/HubRounded';
import ViewInArRoundedIcon from '@mui/icons-material/ViewInArRounded';
import WavesRoundedIcon from '@mui/icons-material/WavesRounded';
import type { AutomationMapResponse } from '@/shared/types/waves/automationMap';
import { automationMapService } from '@/frontend/services/automationMap';
import { useWorkspaceUiPreference } from '@/frontend/hooks/useUiPreference';
import PageHeader from '@/frontend/components/shared/PageHeader';
import { createLogger } from '@/utils/logger';
import { useI18n } from '@/frontend/contexts/I18nContext';
import PlaygroundCanvas from './PlaygroundCanvas';
import DayView from './DayView';
import FactoryObservatoryPanel from './FactoryObservatoryPanel';
import type { PlaygroundMode } from './playgroundGraph';

const log = createLogger('frontend/components/Waves');
const POLL_INTERVAL_MS = 30_000;
const LOAD_TIMEOUT_MS = 60_000;
const VIEW_PREF_KEY = 'flujo-ui:waves:view';
const MODE_PREF_KEY = 'flujo-ui:waves:playground-mode';
const ACTIVE_WAVE_PREF_KEY = 'flujo-ui:waves:active-wave';
const RECOVERY_ALERT_SX = {
  flexShrink: 0,
  overflowWrap: 'anywhere',
  flexDirection: { xs: 'column', sm: 'row' },
  '& .MuiAlert-message': { minWidth: 0, py: { xs: 0, sm: 1 } },
  '& .MuiAlert-action': { ml: 0, pl: { xs: 0, sm: 2 }, alignSelf: { xs: 'stretch', sm: 'center' } },
} as const;

type WavesView = 'playground' | 'day' | 'factory';

export type WavesManagerHeight = number | string | {
  xs: number | string;
  sm?: number | string;
  md?: number | string;
  lg?: number | string;
  xl?: number | string;
};

interface WavesManagerProps {
  /** Definite height supplied by the full-page route; embedded views inherit their parent. */
  height?: WavesManagerHeight;
}

function packageNamesOf(data: AutomationMapResponse | null): string[] {
  if (!data) return [];
  return [...new Set([
    ...data.packages.map((item) => item.name),
    ...data.flows.flatMap((item) => item.packageNames),
  ])].sort((left, right) => left.localeCompare(right));
}

export default function WavesManager({ height = '100%' }: WavesManagerProps) {
  const { t, tp } = useI18n();
  const [data, setData] = useState<AutomationMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const loadRequest = useRef(0);
  const activeLoad = useRef<{ controller: AbortController; timeout: number } | null>(null);
  const [view, setView] = useWorkspaceUiPreference<WavesView>(VIEW_PREF_KEY, 'day');
  const [mode, setMode] = useWorkspaceUiPreference<PlaygroundMode>(MODE_PREF_KEY, 'simple');
  const [activeWaveId, setActiveWaveId] = useWorkspaceUiPreference<string | null>(ACTIVE_WAVE_PREF_KEY, null);
  const [visiblePackageNames, setVisiblePackageNames] = useState<string[]>([]);
  const [packageMenuAnchor, setPackageMenuAnchor] = useState<HTMLElement | null>(null);
  // Inspecting an item switches views and remounts DayView on return.
  const [selectedDate, setSelectedDate] = useState(() => new Date());

  const refresh = useCallback(async () => {
    // Slow requests get time to finish instead of being superseded every poll.
    if (activeLoad.current) return;
    const request = ++loadRequest.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
    activeLoad.current = { controller, timeout };
    setLoading(true);
    try {
      const response = await automationMapService.load(controller.signal);
      if (request !== loadRequest.current) return;
      setData(response);
      setLoadError(false);
    } catch (error) {
      if (request !== loadRequest.current) return;
      log.warn('Automation map load failed', error);
      setLoadError(true);
    } finally {
      window.clearTimeout(timeout);
      if (request === loadRequest.current) {
        activeLoad.current = null;
        setLoading(false);
      }
    }
  }, []);

  const retryLoad = useCallback(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (view === 'factory') return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh();
      // Wait after completion, including timeouts, so recovery stays usable.
      if (!cancelled) timer = window.setTimeout(() => { void poll(); }, POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // A previous poll or departed view cannot replace this view's details.
      loadRequest.current++;
      if (activeLoad.current) {
        window.clearTimeout(activeLoad.current.timeout);
        activeLoad.current.controller.abort();
        activeLoad.current = null;
      }
    };
  }, [refresh, view]);

  useEffect(() => {
    if (!data || !activeWaveId) return;
    if (!data.waves.some((wave) => wave.id === activeWaveId)) setActiveWaveId(null);
  }, [activeWaveId, data, setActiveWaveId]);

  const packageNames = useMemo(() => packageNamesOf(data), [data]);
  const packageFilter = useMemo(
    () => visiblePackageNames.length === 0 ? undefined : new Set(visiblePackageNames),
    [visiblePackageNames],
  );

  const selectWaveFromDay = useCallback((waveId: string) => {
    setActiveWaveId(waveId);
    setView('playground');
  }, [setActiveWaveId, setView]);

  const selectExecutionFromDay = useCallback((executionId: string) => {
    const waveId = data?.executions.find((execution) => execution.executionId === executionId)?.waveIds[0] ?? null;
    setActiveWaveId(waveId);
    setView('playground');
  }, [data?.executions, setActiveWaveId, setView]);

  const togglePackage = useCallback((packageName: string) => {
    setVisiblePackageNames((current) => {
      if (current.length === 0) return [packageName];
      if (current.includes(packageName)) {
        const next = current.filter((name) => name !== packageName);
        return next;
      }
      return [...current, packageName];
    });
  }, []);

  const headerActions = (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={view}
      onChange={(_, next: WavesView | null) => next && setView(next)}
      aria-label="Waves view"
      sx={{
        bgcolor: 'background.paper',
        '& .MuiToggleButton-root': { minHeight: 44, px: { xs: 1.15, sm: 1.75 }, gap: 0.7, textTransform: 'none', fontWeight: 700 },
      }}
    >
      <ToggleButton value="day" aria-label={t('waves.day')}>
        <CalendarViewDayRoundedIcon sx={{ fontSize: 18 }} />
        {t('waves.day')}
      </ToggleButton>
      <ToggleButton value="playground" aria-label={t('waves.playground')}>
        <HubRoundedIcon sx={{ fontSize: 18 }} />
        {t('waves.playground')}
      </ToggleButton>
      <ToggleButton value="factory" aria-label="FACTORY swarm">
        <HubRoundedIcon sx={{ fontSize: 18 }} />
        FACTORY
      </ToggleButton>
    </ToggleButtonGroup>
  );

  const retryAction = (
    <Button color="inherit" onClick={retryLoad} disabled={loading} sx={{ minHeight: 44, width: { xs: '100%', sm: 'auto' } }}>
      {t('common.tryAgain')}
    </Button>
  );

  return (
    <Box sx={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        compact
        icon={WavesRoundedIcon}
        eyebrowKey="waves.mapEyebrow"
        titleKey="waves.title"
        descriptionKey={view === 'day' ? 'waves.dayDescription' : 'waves.playgroundDescription'}
        badge={data?.paused && view !== 'day' ? <Chip size="small" color="warning" label={t('waves.schedulerPaused')} /> : undefined}
        actions={headerActions}
      />

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1.15,
          px: { xs: 1, sm: 1.5, lg: 2 },
          pt: 1.15,
          pb: { xs: 1, sm: 1.5 },
        }}
      >
        {view !== 'factory' && data && loadError && (
          <Alert severity="warning" icon={false} aria-busy={loading} sx={RECOVERY_ALERT_SX} action={retryAction}>
            {t('waves.staleMap')}
            {loading && <Typography variant="body2" role="status" aria-live="polite">{t('waves.refreshing')}</Typography>}
          </Alert>
        )}
        {view !== 'factory' && loading && !data && (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Stack role="status" aria-live="polite" aria-busy="true" spacing={1.25} alignItems="center">
              <CircularProgress size={34} aria-hidden="true" />
              <Typography variant="body2" color="text.secondary">{t(view === 'day' ? 'waves.loadingDay' : 'waves.buildingMap')}</Typography>
            </Stack>
          </Box>
        )}

        {view !== 'factory' && !loading && !data && loadError && (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 2 }}>
            <Alert
              severity="error"
              sx={{ ...RECOVERY_ALERT_SX, width: '100%', maxWidth: 520 }}
              action={retryAction}
            >
              {t(view === 'day' ? 'waves.loadDayError' : 'waves.loadError')}
            </Alert>
          </Box>
        )}

        {data && view === 'playground' && (
          <>
            <Paper
              variant="outlined"
              sx={{
                minHeight: 42,
                px: 0.75,
                py: 0.55,
                borderRadius: 3,
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 0.75,
              }}
            >
              <ToggleButtonGroup
                exclusive
                size="small"
                value={mode}
                onChange={(_, next: PlaygroundMode | null) => next && setMode(next)}
                aria-label="Playground detail"
                sx={{ '& .MuiToggleButton-root': { py: 0.35, px: 1.25, gap: 0.6, textTransform: 'none', fontWeight: 700 } }}
              >
                <ToggleButton value="simple" aria-label={t('waves.simple')}>
                  <ViewInArRoundedIcon sx={{ fontSize: 17 }} />
                  {t('waves.simple')}
                </ToggleButton>
                <ToggleButton value="expert" aria-label={t('waves.expert')}>
                  <HubRoundedIcon sx={{ fontSize: 17 }} />
                  {t('waves.expert')}
                </ToggleButton>
              </ToggleButtonGroup>

              <Tooltip title={t('waves.packageFilter')}>
                <Chip
                  component="button"
                  clickable
                  size="small"
                  icon={<FilterAltOutlinedIcon />}
                  variant={visiblePackageNames.length > 0 ? 'filled' : 'outlined'}
                  color={visiblePackageNames.length > 0 ? 'primary' : 'default'}
                  label={visiblePackageNames.length === 0
                    ? t('waves.allPackages')
                    : t('waves.packageSelection', { selected: visiblePackageNames.length, total: packageNames.length })}
                  onClick={(event) => setPackageMenuAnchor(event.currentTarget)}
                />
              </Tooltip>
              <Menu
                anchorEl={packageMenuAnchor}
                open={Boolean(packageMenuAnchor)}
                onClose={() => setPackageMenuAnchor(null)}
                slotProps={{ paper: { sx: { minWidth: 230, maxHeight: 360 } } }}
              >
                <MenuItem selected={visiblePackageNames.length === 0} onClick={() => setVisiblePackageNames([])}>
                  <Checkbox size="small" checked={visiblePackageNames.length === 0} />
                  <ListItemText primary={t('waves.allPackages')} />
                </MenuItem>
                {packageNames.map((packageName) => (
                  <MenuItem key={packageName} onClick={() => togglePackage(packageName)}>
                    <Checkbox
                      size="small"
                      checked={visiblePackageNames.length === 0 || visiblePackageNames.includes(packageName)}
                    />
                    <ListItemText primary={packageName} />
                  </MenuItem>
                ))}
              </Menu>

              <Box sx={{ flex: 1 }} />
              <Chip size="small" variant="outlined" label={tp('waves.flowCount', data.flows.length)} />
              <Chip size="small" variant="outlined" label={tp('waves.connectionCount', data.relations.length)} />
              {data.orphanExecutionIds.length > 0 && (
                <Tooltip title={t('waves.unlinkedDescription')}>
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={tp('waves.unlinkedCount', data.orphanExecutionIds.length)}
                  />
                </Tooltip>
              )}
            </Paper>

            <Paper
              variant="outlined"
              data-testid="waves-playground"
              sx={{
                flex: 1,
                minHeight: 0,
                overflow: 'hidden',
                borderRadius: 4,
                bgcolor: 'background.default',
              }}
            >
              <PlaygroundCanvas
                data={data}
                mode={mode}
                activeWaveId={activeWaveId}
                onActiveWaveChange={setActiveWaveId}
                visiblePackageNames={packageFilter}
              />
            </Paper>
          </>
        )}

        {data && view === 'day' && (
          <Box data-testid="waves-day-view" sx={{ flex: 1, minHeight: 0 }}>
            <DayView
              data={data}
              selectedDate={selectedDate}
              onSelectedDateChange={setSelectedDate}
              height="100%"
              onSelectWave={selectWaveFromDay}
              onSelectExecution={selectExecutionFromDay}
            />
          </Box>
        )}
        {view === 'factory' && <FactoryObservatoryPanel />}
      </Box>
    </Box>
  );
}
