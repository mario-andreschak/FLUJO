'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  alpha,
  Box,
  Button,
  ButtonBase,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import CalendarMonthRoundedIcon from '@mui/icons-material/CalendarMonthRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import TodayRoundedIcon from '@mui/icons-material/TodayRounded';
import SensorsRoundedIcon from '@mui/icons-material/SensorsRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import RepeatRoundedIcon from '@mui/icons-material/RepeatRounded';
import PauseCircleOutlineRoundedIcon from '@mui/icons-material/PauseCircleOutlineRounded';
import type { AutomationMapResponse } from '@/shared/types/waves/automationMap';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { Translator } from '@/frontend/i18n/core';
import DayViewMiniMonth from './DayViewMiniMonth';
import {
  addCalendarDays,
  buildDaySchedule,
  isSameCalendarDay,
  layoutDayItems,
  minuteOfDay,
  normalizeCalendarDay,
  type DayAlwaysListeningItem,
  type DayOccurrence,
  type DayRecurrenceAggregate,
} from './dayViewCalendar';

const HOUR_HEIGHT = 68;
const DAY_GRID_HEIGHT = HOUR_HEIGHT * 24;
const TIME_GUTTER = 68;

const PACKAGE_COLOR_KEYS = [
  'primary',
  'secondary',
  'info',
  'success',
  'warning',
] as const;

type DayDisplayItem = DayOccurrence | DayRecurrenceAggregate | DayAlwaysListeningItem;

export interface WavesDayViewProps {
  data: AutomationMapResponse;
  /** Controlled selected day. When absent, DayView keeps its own date navigation state. */
  selectedDate?: Date;
  defaultSelectedDate?: Date;
  onSelectedDateChange?: (date: Date) => void;
  /** Used by a parent inspector or to switch back to the Playground view. */
  onSelectExecution?: (executionId: string) => void;
  onSelectWave?: (waveId: string) => void;
  height?: number | string;
  /** Deterministic clock seam for previews/tests. Omit for a live minute hand. */
  now?: number;
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function downstreamLabel(item: DayDisplayItem, t: Translator): string | null {
  if (item.downstream.length === 0) return null;
  const visible = item.downstream.slice(0, 3);
  const remaining = item.downstream.length - visible.length;
  return `${t('flows.guided.then')} ${visible.join(' → ')}${
    remaining > 0 ? ` · ${t('flows.nodeInfo.more', { count: remaining })}` : ''
  }`;
}

function itemStateLabel(item: DayDisplayItem, t: Translator): string | null {
  if (item.state === 'disabled') return t('waves.day.off');
  if (item.state === 'paused') return t('waves.day.paused');
  return null;
}

function activityLabel(item: DayDisplayItem, t: Translator): string {
  if (item.kind === 'always') {
    if (item.triggerType === 'file-watch') return t('waves.kind.fileWatch');
    if (item.triggerType === 'webhook') return t('waves.kind.webhook');
    return t('waves.kind.event');
  }
  return item.activity === 'run' ? t('waves.day.run') : t('waves.day.check');
}

function cadenceLabel(item: DayRecurrenceAggregate, t: Translator): string {
  if (!item.cadenceMs || !Number.isFinite(item.cadenceMs) || item.cadenceMs <= 0) {
    return t('waves.day.frequentSchedule');
  }
  const seconds = Math.max(1, Math.round(item.cadenceMs / 1000));
  if (seconds < 60) {
    return seconds === 1
      ? t('waves.day.everySecond.one', { count: seconds })
      : t('waves.day.everySecond.other', { count: seconds });
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) {
    return minutes === 1
      ? t('waves.day.everyMinute.one', { count: minutes })
      : t('waves.day.everyMinute.other', { count: minutes });
  }
  const hours = Math.max(1, Math.round(minutes / 60));
  return hours === 1
    ? t('waves.day.everyHour.one', { count: hours })
    : t('waves.day.everyHour.other', { count: hours });
}

interface DayItemContentProps {
  item: DayDisplayItem;
  color: string;
  timeLabel?: string;
  compact?: boolean;
  t: Translator;
}

function DayItemContent({ item, color, timeLabel, compact = false, t }: DayItemContentProps) {
  const then = downstreamLabel(item, t);
  const state = itemStateLabel(item, t);
  const isAggregate = item.kind === 'aggregate';
  const activity = activityLabel(item, t);
  return (
    <Box sx={{ display: 'flex', minWidth: 0, gap: 0.85, alignItems: 'stretch' }}>
      <Box sx={{ width: 4, borderRadius: 999, bgcolor: color, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.55, minWidth: 0 }}>
          {timeLabel && (
            <Typography variant="caption" sx={{ fontWeight: 780, color, flexShrink: 0 }}>
              {timeLabel}
            </Typography>
          )}
          <Typography
            variant={compact ? 'caption' : 'body2'}
            noWrap
            title={item.name}
            sx={{ fontWeight: 760, minWidth: 0 }}
          >
            {item.name}
          </Typography>
          <Chip
            size="small"
            variant="outlined"
            label={activity}
            sx={{
              height: 18,
              flexShrink: 0,
              fontSize: 9,
              borderColor: alpha(color, 0.5),
              color,
              '& .MuiChip-label': { px: 0.65 },
            }}
          />
          {state && (
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, fontWeight: 700 }}>
              {state}
            </Typography>
          )}
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          noWrap
          title={`${item.packageName} · ${item.flowName}`}
          sx={{ display: 'block', lineHeight: 1.25 }}
        >
          {item.packageName} · {item.flowName}
        </Typography>
        {isAggregate && (
          <Typography variant="caption" sx={{ display: 'block', color, fontWeight: 700, lineHeight: 1.25 }}>
            {cadenceLabel(item, t)} · {t('waves.day.atLeastToday', { count: item.countAtLeast })}
          </Typography>
        )}
        {then && !compact && (
          <Typography variant="caption" color="text.secondary" noWrap title={then} sx={{ display: 'block' }}>
            {then}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

interface AlwaysListeningRowProps {
  items: readonly DayAlwaysListeningItem[];
  packageColor: (packageName: string) => string;
  onActivate: (item: DayAlwaysListeningItem) => void;
  t: Translator;
}

function AlwaysListeningRow({ items, packageColor, onActivate, t }: AlwaysListeningRowProps) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '132px minmax(0, 1fr)' },
        gap: 1,
        alignItems: 'center',
        px: 1.25,
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, color: 'text.secondary' }}>
        <SensorsRoundedIcon sx={{ fontSize: 17 }} />
        <Typography variant="caption" sx={{ fontWeight: 760 }}>
          {t('waves.day.alwaysListening')}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, overflowX: 'auto', pb: 0.15 }}>
        {items.length === 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
            {t('waves.day.noListeners')}
          </Typography>
        )}
        {items.map((item) => {
          const color = packageColor(item.packageName);
          const then = downstreamLabel(item, t);
          const eventLabel = activityLabel(item, t);
          return (
            <Tooltip key={item.key} title={then ?? `${eventLabel} · ${item.flowName}`} arrow>
              <ButtonBase
                onClick={() => onActivate(item)}
                aria-label={`${item.name}, ${eventLabel}`}
                sx={{
                  minWidth: 176,
                  maxWidth: 232,
                  flexShrink: 0,
                  alignItems: 'stretch',
                  justifyContent: 'stretch',
                  textAlign: 'left',
                  border: 1,
                  borderColor: alpha(color, 0.3),
                  borderRadius: 2,
                  p: 0.75,
                  opacity: item.subdued ? 0.48 : 1,
                  bgcolor: alpha(color, 0.045),
                  '&:hover': { borderColor: color, bgcolor: alpha(color, 0.09) },
                }}
              >
                <DayItemContent item={item} color={color} compact t={t} />
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}

interface ScheduledRhythmsRowProps {
  items: readonly DayRecurrenceAggregate[];
  packageColor: (packageName: string) => string;
  onActivate: (item: DayRecurrenceAggregate) => void;
  t: Translator;
}

function ScheduledRhythmsRow({ items, packageColor, onActivate, t }: ScheduledRhythmsRowProps) {
  if (items.length === 0) return null;
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: '132px minmax(0, 1fr)' },
        gap: 1,
        alignItems: 'center',
        px: 1.25,
        py: 1,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.65, color: 'text.secondary' }}>
        <RepeatRoundedIcon sx={{ fontSize: 17 }} />
        <Typography variant="caption" sx={{ fontWeight: 760 }}>
          {t('waves.day.scheduledRhythms')}
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, overflowX: 'auto', pb: 0.15 }}>
        {items.map((item) => {
          const color = packageColor(item.packageName);
          return (
            <Tooltip
              key={item.key}
              title={downstreamLabel(item, t) ?? `${cadenceLabel(item, t)} · ${item.flowName}`}
              arrow
            >
              <ButtonBase
                onClick={() => onActivate(item)}
                aria-label={`${item.name}, ${cadenceLabel(item, t)}`}
                sx={{
                  minWidth: 210,
                  maxWidth: 280,
                  flexShrink: 0,
                  alignItems: 'stretch',
                  justifyContent: 'stretch',
                  textAlign: 'left',
                  border: 1,
                  borderColor: alpha(color, item.subdued ? 0.24 : 0.38),
                  borderStyle: item.subdued ? 'dashed' : 'solid',
                  borderRadius: 2,
                  p: 0.75,
                  opacity: item.subdued ? 0.48 : 1,
                  bgcolor: alpha(color, 0.055),
                  backgroundImage: `repeating-linear-gradient(135deg, transparent, transparent 8px, ${alpha(color, 0.07)} 8px, ${alpha(color, 0.07)} 16px)`,
                  '&:hover': { borderColor: color, bgcolor: alpha(color, 0.1) },
                }}
              >
                <DayItemContent item={item} color={color} compact t={t} />
              </ButtonBase>
            </Tooltip>
          );
        })}
      </Box>
    </Box>
  );
}

interface DesktopTimelineProps {
  date: Date;
  now: number;
  items: readonly DayOccurrence[];
  packageColor: (packageName: string) => string;
  onActivate: (item: DayOccurrence) => void;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  t: Translator;
}

function DesktopTimeline({ date, now, items, packageColor, onActivate, formatDate, t }: DesktopTimelineProps) {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const layout = useMemo(() => layoutDayItems(items), [items]);
  const today = isSameCalendarDay(date, now);
  const currentTop = minuteOfDay(now) / (24 * 60) * DAY_GRID_HEIGHT;
  const dateKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const scrollInputsRef = useRef({ today, now, items });

  useEffect(() => {
    scrollInputsRef.current = { today, now, items };
  }, [items, now, today]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const snapshot = scrollInputsRef.current;
    const targetMinute = snapshot.today
      ? Math.max(0, minuteOfDay(snapshot.now) - 90)
      : snapshot.items.length > 0
        ? Math.max(0, minuteOfDay(snapshot.items[0].at) - 60)
        : 8 * 60;
    element.scrollTop = targetMinute / (24 * 60) * DAY_GRID_HEIGHT;
    // The timeline deliberately recenters only when the selected date changes.
    // Poll refreshes and the live 30-second clock must not steal the user's scroll.
  }, [dateKey]);

  return (
    <Box
      ref={scrollRef}
      role="region"
      aria-label={t('waves.day.timeline')}
      sx={{ position: 'relative', minHeight: 0, flex: 1, overflowY: 'auto', bgcolor: 'background.default' }}
    >
      <Box sx={{ position: 'relative', height: DAY_GRID_HEIGHT, minWidth: 580 }}>
        {Array.from({ length: 25 }, (_, hour) => {
          const top = hour * HOUR_HEIGHT;
          const labelDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.min(hour, 23), 0);
          return (
            <React.Fragment key={hour}>
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  top,
                  left: TIME_GUTTER,
                  right: 0,
                  borderTop: 1,
                  borderColor: hour % 2 === 0 ? 'divider' : alpha(theme.palette.divider, 0.7),
                }}
              />
              {hour < 24 && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    position: 'absolute',
                    top: top - 8,
                    left: 0,
                    width: TIME_GUTTER - 10,
                    pr: 1,
                    textAlign: 'right',
                    fontSize: 10,
                    bgcolor: 'background.default',
                  }}
                >
                  {formatDate(labelDate, { hour: 'numeric' })}
                </Typography>
              )}
              {hour < 24 && (
                <Box
                  aria-hidden
                  sx={{
                    position: 'absolute',
                    top: top + HOUR_HEIGHT / 2,
                    left: TIME_GUTTER,
                    right: 0,
                    borderTop: `1px dashed ${alpha(theme.palette.divider, 0.55)}`,
                  }}
                />
              )}
            </React.Fragment>
          );
        })}

        <Box sx={{ position: 'absolute', inset: `0 0 0 ${TIME_GUTTER}px` }}>
          {layout.map(({ item, lane, laneCount }) => {
            const top = Math.max(1, Math.min(DAY_GRID_HEIGHT - 50, minuteOfDay(item.at) / (24 * 60) * DAY_GRID_HEIGHT));
            const color = packageColor(item.packageName);
            const laneWidth = 100 / laneCount;
            return (
              <Tooltip
                key={item.key}
                title={downstreamLabel(item, t) ?? `${item.packageName} · ${item.flowName}`}
                arrow
              >
                <ButtonBase
                  onClick={() => onActivate(item)}
                  aria-label={`${formatDate(item.at, { hour: 'numeric', minute: '2-digit' })}, ${item.name}, ${item.activity}`}
                  sx={{
                    position: 'absolute',
                    zIndex: 2,
                    top,
                    left: `calc(${lane * laneWidth}% + 8px)`,
                    width: `calc(${laneWidth}% - 12px)`,
                    minHeight: 50,
                    alignItems: 'stretch',
                    justifyContent: 'stretch',
                    textAlign: 'left',
                    p: 0.75,
                    border: 1,
                    borderColor: alpha(color, item.subdued ? 0.24 : 0.42),
                    borderStyle: item.subdued ? 'dashed' : 'solid',
                    borderRadius: 2,
                    opacity: item.subdued ? 0.48 : 1,
                    bgcolor: alpha(color, theme.palette.mode === 'dark' ? 0.17 : 0.08),
                    boxShadow: `0 3px 10px ${alpha(theme.palette.common.black, theme.palette.mode === 'dark' ? 0.18 : 0.06)}`,
                    '&:hover': {
                      zIndex: 4,
                      borderColor: color,
                      bgcolor: alpha(color, theme.palette.mode === 'dark' ? 0.25 : 0.13),
                    },
                    '&:focus-visible': {
                      zIndex: 5,
                      outline: `3px solid ${alpha(color, 0.28)}`,
                      outlineOffset: 1,
                    },
                  }}
                >
                  <DayItemContent
                    item={item}
                    color={color}
                    timeLabel={formatDate(item.at, { hour: 'numeric', minute: '2-digit' })}
                    compact={laneCount > 1}
                    t={t}
                  />
                </ButtonBase>
              </Tooltip>
            );
          })}
        </Box>

        {today && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              zIndex: 6,
              top: currentTop,
              left: TIME_GUTTER - 5,
              right: 0,
              height: 2,
              bgcolor: 'primary.main',
              pointerEvents: 'none',
              '&::before': {
                content: '""',
                position: 'absolute',
                left: -4,
                top: -4,
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: 'primary.main',
              },
            }}
          />
        )}
      </Box>
    </Box>
  );
}

interface MobileAgendaProps {
  items: readonly DayOccurrence[];
  packageColor: (packageName: string) => string;
  onActivate: (item: DayOccurrence) => void;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  t: Translator;
}

function MobileAgenda({ items, packageColor, onActivate, formatDate, t }: MobileAgendaProps) {
  if (items.length === 0) {
    return (
      <Box sx={{ py: 7, px: 2, textAlign: 'center' }}>
        <ScheduleRoundedIcon color="disabled" sx={{ fontSize: 34, mb: 1 }} />
        <Typography variant="body2" color="text.secondary">{t('waves.day.nothingScheduled')}</Typography>
      </Box>
    );
  }
  return (
    <Stack spacing={1} sx={{ p: 1.25, overflowY: 'auto' }}>
      {items.map((item) => {
        const color = packageColor(item.packageName);
        return (
          <ButtonBase
            key={item.key}
            onClick={() => onActivate(item)}
            sx={{
              width: '100%',
              justifyContent: 'stretch',
              textAlign: 'left',
              border: 1,
              borderColor: alpha(color, 0.34),
              borderStyle: item.subdued ? 'dashed' : 'solid',
              borderRadius: 2.5,
              p: 1,
              opacity: item.subdued ? 0.5 : 1,
              bgcolor: alpha(color, 0.055),
            }}
          >
            <DayItemContent
              item={item}
              color={color}
              timeLabel={formatDate(item.at, { hour: 'numeric', minute: '2-digit' })}
              t={t}
            />
          </ButtonBase>
        );
      })}
    </Stack>
  );
}

export default function DayView({
  data,
  selectedDate,
  defaultSelectedDate,
  onSelectedDateChange,
  onSelectExecution,
  onSelectWave,
  height = '100%',
  now: suppliedNow,
}: WavesDayViewProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));
  const { t, formatDate } = useI18n();
  const [liveNow, setLiveNow] = useState(() => suppliedNow ?? Date.now());
  const [internalDate, setInternalDate] = useState(() => (
    normalizeCalendarDay(selectedDate ?? defaultSelectedDate ?? liveNow)
  ));
  const [hiddenPackages, setHiddenPackages] = useState<Set<string>>(() => new Set());
  const [mobileMonthOpen, setMobileMonthOpen] = useState(false);
  const selectedDateMs = selectedDate?.getTime();
  const currentDate = useMemo(
    () => normalizeCalendarDay(selectedDateMs ?? internalDate),
    [internalDate, selectedDateMs],
  );

  useEffect(() => {
    if (suppliedNow !== undefined) {
      setLiveNow(suppliedNow);
      return;
    }
    const timer = setInterval(() => setLiveNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [suppliedNow]);

  const setDate = useCallback((next: Date) => {
    const normalized = normalizeCalendarDay(next);
    if (selectedDate === undefined) setInternalDate(normalized);
    onSelectedDateChange?.(normalized);
  }, [onSelectedDateChange, selectedDate]);

  const schedule = useMemo(() => buildDaySchedule({
    data,
    day: currentDate,
  }), [data, currentDate]);

  const visibleTimed = useMemo(
    () => schedule.timed.filter((item) => item.packageNames.some((name) => !hiddenPackages.has(name))),
    [hiddenPackages, schedule.timed],
  );
  const visibleRhythms = useMemo(
    () => schedule.scheduledRhythms.filter((item) => item.packageNames.some((name) => !hiddenPackages.has(name))),
    [hiddenPackages, schedule.scheduledRhythms],
  );
  const visibleAlways = useMemo(
    () => schedule.alwaysListening.filter((item) => item.packageNames.some((name) => !hiddenPackages.has(name))),
    [hiddenPackages, schedule.alwaysListening],
  );

  const packageColor = useCallback((packageName: string): string => {
    const key = PACKAGE_COLOR_KEYS[stableHash(packageName) % PACKAGE_COLOR_KEYS.length];
    return theme.palette[key].main;
  }, [theme]);

  const togglePackage = useCallback((packageName: string) => {
    setHiddenPackages((current) => {
      const next = new Set(current);
      if (next.has(packageName)) next.delete(packageName);
      else next.add(packageName);
      return next;
    });
  }, []);

  const activate = useCallback((item: DayDisplayItem) => {
    if (item.waveId && onSelectWave) {
      onSelectWave(item.waveId);
      return;
    }
    onSelectExecution?.(item.executionId);
  }, [onSelectExecution, onSelectWave]);

  const localTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || t('waves.day.localTime');
    } catch {
      return t('waves.day.localTime');
    }
  }, [t]);

  return (
    <Box sx={{ height, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Paper
        variant="outlined"
        sx={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 0.75,
          px: { xs: 1, sm: 1.25 },
          py: 0.85,
          borderRadius: 3,
        }}
      >
        <Button
          size="small"
          variant="outlined"
          startIcon={<TodayRoundedIcon />}
          onClick={() => setDate(new Date(liveNow))}
        >
          {t('waves.day.today')}
        </Button>
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          <Tooltip title={t('waves.day.previousDay')}>
            <IconButton size="small" aria-label={t('waves.day.previousDay')} onClick={() => setDate(addCalendarDays(currentDate, -1))}>
              <ChevronLeftRoundedIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('waves.day.nextDay')}>
            <IconButton size="small" aria-label={t('waves.day.nextDay')} onClick={() => setDate(addCalendarDays(currentDate, 1))}>
              <ChevronRightRoundedIcon />
            </IconButton>
          </Tooltip>
        </Box>
        <Typography variant="subtitle1" sx={{ minWidth: 0, fontWeight: 780, flex: { xs: '1 1 180px', sm: '0 1 auto' } }}>
          {formatDate(currentDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Chip
          size="small"
          variant="outlined"
          icon={<CalendarMonthRoundedIcon />}
          label={localTimezone}
          sx={{ maxWidth: 220 }}
        />
        <Chip
          size="small"
          color={data.paused ? 'warning' : 'success'}
          variant={data.paused ? 'filled' : 'outlined'}
          icon={data.paused ? <PauseCircleOutlineRoundedIcon /> : <ScheduleRoundedIcon />}
          label={data.paused ? t('waves.schedulerPaused') : t('automations.list.active')}
        />
      </Paper>

      <Box sx={{ display: { xs: 'block', md: 'none' } }}>
        <Paper variant="outlined" sx={{ p: 1, borderRadius: 3 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Button
              size="small"
              startIcon={<CalendarMonthRoundedIcon />}
              onClick={() => setMobileMonthOpen((open) => !open)}
            >
              {mobileMonthOpen ? t('waves.day.hideMonth') : t('waves.day.chooseDate')}
            </Button>
            <Box sx={{ display: 'flex', gap: 0.5, minWidth: 0, overflowX: 'auto', ml: 'auto' }}>
              {schedule.packages.map((packageName) => {
                const color = packageColor(packageName);
                const visible = !hiddenPackages.has(packageName);
                return (
                  <Chip
                    key={packageName}
                    size="small"
                    clickable
                    variant={visible ? 'filled' : 'outlined'}
                    label={packageName}
                    onClick={() => togglePackage(packageName)}
                    sx={{
                      flexShrink: 0,
                      bgcolor: visible ? alpha(color, 0.15) : 'transparent',
                      borderColor: color,
                      color: visible ? color : 'text.disabled',
                    }}
                  />
                );
              })}
            </Box>
          </Box>
          <Collapse in={mobileMonthOpen} unmountOnExit>
            <Box sx={{ maxWidth: 320, mx: 'auto', pt: 1.25 }}>
              <DayViewMiniMonth
                selectedDate={currentDate}
                today={new Date(liveNow)}
                packages={schedule.packages}
                hiddenPackages={hiddenPackages}
                packageColor={packageColor}
                onSelectDate={(date) => {
                  setDate(date);
                  setMobileMonthOpen(false);
                }}
                onTogglePackage={togglePackage}
                showPackageFilters={false}
              />
            </Box>
          </Collapse>
        </Paper>
      </Box>

      <Box sx={{ display: 'flex', gap: 1.25, flex: 1, minHeight: 0 }}>
        <Paper
          variant="outlined"
          sx={{
            display: { xs: 'none', md: 'block' },
            width: 260,
            flexShrink: 0,
            alignSelf: 'stretch',
            overflowY: 'auto',
            p: 1.5,
            borderRadius: 3,
          }}
        >
          <DayViewMiniMonth
            selectedDate={currentDate}
            today={new Date(liveNow)}
            packages={schedule.packages}
            hiddenPackages={hiddenPackages}
            packageColor={packageColor}
            onSelectDate={setDate}
            onTogglePackage={togglePackage}
          />
        </Paper>

        <Paper
          variant="outlined"
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderRadius: 3,
          }}
        >
          <AlwaysListeningRow items={visibleAlways} packageColor={packageColor} onActivate={activate} t={t} />
          <ScheduledRhythmsRow items={visibleRhythms} packageColor={packageColor} onActivate={activate} t={t} />
          {isMobile ? (
            <MobileAgenda
              items={visibleTimed}
              packageColor={packageColor}
              onActivate={activate}
              formatDate={formatDate}
              t={t}
            />
          ) : (
            <DesktopTimeline
              date={currentDate}
              now={liveNow}
              items={visibleTimed}
              packageColor={packageColor}
              onActivate={activate}
              formatDate={formatDate}
              t={t}
            />
          )}
          <Box
            sx={{
              px: 1.25,
              py: 0.65,
              borderTop: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
            }}
          >
            <Typography variant="caption" color="text.secondary">
              {t('waves.day.forecastNote')}
            </Typography>
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}
