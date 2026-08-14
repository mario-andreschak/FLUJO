'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { PlaygroundMode } from './playgroundGraph';

const log = createLogger('frontend/components/Waves');
const POLL_INTERVAL_MS = 30_000;
const VIEW_PREF_KEY = 'flujo-ui:waves:view';
const MODE_PREF_KEY = 'flujo-ui:waves:playground-mode';
const ACTIVE_WAVE_PREF_KEY = 'flujo-ui:waves:active-wave';

type WavesView = 'playground' | 'day';

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
  const [view, setView] = useWorkspaceUiPreference<WavesView>(VIEW_PREF_KEY, 'playground');
  const [mode, setMode] = useWorkspaceUiPreference<PlaygroundMode>(MODE_PREF_KEY, 'simple');
  const [activeWaveId, setActiveWaveId] = useWorkspaceUiPreference<string | null>(ACTIVE_WAVE_PREF_KEY, null);
  const [visiblePackageNames, setVisiblePackageNames] = useState<string[]>([]);
  const [packageMenuAnchor, setPackageMenuAnchor] = useState<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const response = await automationMapService.load();
    setData(response);
    setLoadError(false);
    setLoading(false);
  }, []);

  const retryLoad = useCallback(() => {
    setLoading(true);
    refresh().catch((error) => {
      log.warn('Automation map retry failed', error);
      setLoadError(true);
      setLoading(false);
    });
  }, [refresh]);

  useEffect(() => {
    refresh().catch((error) => {
      log.warn('Initial automation map load failed', error);
      setLoadError(true);
      setLoading(false);
    });
    const timer = window.setInterval(() => {
      refresh().catch((error) => {
        log.warn('Automation map refresh failed', error);
        setLoadError(true);
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

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
        '& .MuiToggleButton-root': { px: { xs: 1.15, sm: 1.75 }, gap: 0.7, textTransform: 'none', fontWeight: 700 },
      }}
    >
      <ToggleButton value="playground" aria-label={t('waves.playground')}>
        <HubRoundedIcon sx={{ fontSize: 18 }} />
        {t('waves.playground')}
      </ToggleButton>
      <ToggleButton value="day" aria-label={t('waves.day')}>
        <CalendarViewDayRoundedIcon sx={{ fontSize: 18 }} />
        {t('waves.day')}
      </ToggleButton>
    </ToggleButtonGroup>
  );

  return (
    <Box sx={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <PageHeader
        compact
        icon={WavesRoundedIcon}
        eyebrowKey="waves.mapEyebrow"
        titleKey="waves.title"
        descriptionKey="waves.playgroundDescription"
        badge={data?.paused ? <Chip size="small" color="warning" label={t('waves.schedulerPaused')} /> : undefined}
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
        {loading && (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <Stack spacing={1.25} alignItems="center">
              <CircularProgress size={34} />
              <Typography variant="body2" color="text.secondary">{t('waves.buildingMap')}</Typography>
            </Stack>
          </Box>
        )}

        {!loading && !data && loadError && (
          <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 2 }}>
            <Alert
              severity="error"
              action={<Button color="inherit" size="small" onClick={retryLoad}>{t('common.tryAgain')}</Button>}
            >
              {t('waves.loadError')}
            </Alert>
          </Box>
        )}

        {!loading && data && view === 'playground' && (
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
              {loadError && <Chip size="small" color="warning" variant="outlined" label={t('waves.staleMap')} />}
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

        {!loading && data && view === 'day' && (
          <Box data-testid="waves-day-view" sx={{ flex: 1, minHeight: 0 }}>
            <DayView
              data={data}
              height="100%"
              onSelectWave={selectWaveFromDay}
              onSelectExecution={selectExecutionFromDay}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
