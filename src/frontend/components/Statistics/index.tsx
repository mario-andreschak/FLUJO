'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Card,
  CardContent,
  Chip,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import CloseIcon from '@mui/icons-material/Close';
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import Spinner from '@/frontend/components/shared/Spinner';
import PageHeader from '@/frontend/components/shared/PageHeader';
import {
  createDefaultStatisticsFilters,
  statisticsService,
  StatisticsDashboardFilters,
} from '@/frontend/services/statistics';
import {
  StatisticsCacheOutcome,
  StatisticsComparisonMetric,
  StatisticsComparisonResponse,
  StatisticsContentCategory,
  StatisticsDailyBucket,
  StatisticsDetailKind,
  StatisticsDetailRow,
  StatisticsErrorClass,
  StatisticsPhase,
  StatisticsRankingRow,
  StatisticsRunSource,
  StatisticsSortDirection,
  StatisticsSortField,
  StatisticsStatusFilter,
  StatisticsSubflowMode,
} from '@/shared/types/statistics';
import { useI18n } from '@/frontend/contexts/I18nContext';
import type { TranslationKey } from '@/frontend/i18n/messages';

const RUN_SOURCES: StatisticsRunSource[] = [
  'chat',
  'api',
  'schedule',
  'trigger',
  'subflow',
  'mcp',
  'internal',
  'meeting',
  'internal-tool',
];
const STATUSES: StatisticsStatusFilter[] = [
  'completed',
  'error',
  'capped',
  'cancelled',
  'paused',
  'skipped',
];
const SUBFLOW_MODES: StatisticsSubflowMode[] = ['inline', 'detached', 'graph', 'fanout', 'unknown'];
const CACHE_OUTCOMES: StatisticsCacheOutcome[] = [
  'hit',
  'miss',
  'write',
  'mixed',
  'unsupported',
  'unknown',
];
const CONTENT_CATEGORIES: StatisticsContentCategory[] = [
  'json',
  'text',
  'image',
  'audio',
  'video',
  'binary',
  'multipart',
  'empty',
  'unknown',
];
const DETAIL_LIMIT = 50;

type ArrayFilterKey = Exclude<keyof StatisticsDashboardFilters, 'range' | 'sort'>;
type TabKey =
  | 'overview'
  | 'flows'
  | 'executions'
  | 'models'
  | 'providers'
  | 'nodes'
  | 'tools'
  | 'subflows'
  | 'compare';
type RankingMode = 'runs' | 'providers' | 'tools' | 'subflows';

const IDENTIFIER_FILTERS: Array<{ field: ArrayFilterKey; labelKey: TranslationKey }> = [
  { field: 'flowIds', labelKey: 'statistics.filter.flowIds' },
  { field: 'plannedExecutionIds', labelKey: 'statistics.filter.executionIds' },
  { field: 'modelIds', labelKey: 'statistics.filter.modelIds' },
  { field: 'providerIds', labelKey: 'statistics.filter.providerIds' },
  { field: 'credentialIds', labelKey: 'statistics.filter.credentialIds' },
  { field: 'nodeIds', labelKey: 'statistics.filter.nodeIds' },
  { field: 'toolIds', labelKey: 'statistics.filter.toolIds' },
  { field: 'subflowIds', labelKey: 'statistics.filter.subflowIds' },
  { field: 'revisionIds', labelKey: 'statistics.filter.revisionIds' },
];

const SORT_FIELDS: Array<{ field: StatisticsSortField; labelKey: TranslationKey }> = [
  { field: 'activity', labelKey: 'statistics.sort.activity' },
  { field: 'runs', labelKey: 'statistics.sort.runs' },
  { field: 'errors', labelKey: 'statistics.sort.errors' },
  { field: 'failureRate', labelKey: 'statistics.sort.failureRate' },
  { field: 'providerAttempts', labelKey: 'statistics.sort.providerAttempts' },
  { field: 'providerErrors', labelKey: 'statistics.sort.providerErrors' },
  { field: 'nodeVisits', labelKey: 'statistics.sort.nodeVisits' },
  { field: 'toolCalls', labelKey: 'statistics.sort.toolCalls' },
  { field: 'toolFailures', labelKey: 'statistics.sort.toolFailures' },
  { field: 'subflowCalls', labelKey: 'statistics.sort.subflowCalls' },
  { field: 'tokens', labelKey: 'statistics.sort.tokens' },
  { field: 'duration', labelKey: 'statistics.sort.duration' },
  { field: 'cacheHitRate', labelKey: 'statistics.sort.cacheHitRate' },
  { field: 'requestBytes', labelKey: 'statistics.sort.requestBytes' },
  { field: 'responseBytes', labelKey: 'statistics.sort.responseBytes' },
  { field: 'id', labelKey: 'statistics.sort.id' },
];

const COMPARISON_METRIC_LABELS: Record<StatisticsComparisonMetric, TranslationKey> = {
  runs: 'statistics.metric.runs',
  failureRate: 'statistics.metric.failureRate',
  runDurationP95Ms: 'statistics.metric.runDurationP95Ms',
  totalTokens: 'statistics.metric.totalTokens',
  toolCalls: 'statistics.metric.toolCalls',
  toolFailureRate: 'statistics.metric.toolFailureRate',
  providerErrorRate: 'statistics.metric.providerErrorRate',
  cacheHitRate: 'statistics.metric.cacheHitRate',
  subflowFailureRate: 'statistics.metric.subflowFailureRate',
};

const RATE_METRICS = new Set<StatisticsComparisonMetric>([
  'failureRate',
  'toolFailureRate',
  'providerErrorRate',
  'cacheHitRate',
  'subflowFailureRate',
]);

function formatDuration(
  milliseconds: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
  daysLabel: (value: number) => string,
): string {
  if (milliseconds < 1_000) return `${formatNumber(Math.round(milliseconds))} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${formatNumber(seconds, { maximumFractionDigits: seconds < 10 ? 1 : 0 })} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${formatNumber(minutes, { maximumFractionDigits: minutes < 10 ? 1 : 0 })} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${formatNumber(hours, { maximumFractionDigits: hours < 10 ? 1 : 0 })} h`;
  return daysLabel(hours / 24);
}

function formatPercent(
  value: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  return formatNumber(value, {
    style: 'percent',
    maximumFractionDigits: value > 0 && value < 0.1 ? 1 : 0,
  });
}

function formatBytes(
  value: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  if (value < 1_024) return `${formatNumber(value)} B`;
  const kilobytes = value / 1_024;
  if (kilobytes < 1_024) return `${formatNumber(kilobytes, { maximumFractionDigits: 1 })} KB`;
  const megabytes = kilobytes / 1_024;
  if (megabytes < 1_024) return `${formatNumber(megabytes, { maximumFractionDigits: 1 })} MB`;
  return `${formatNumber(megabytes / 1_024, { maximumFractionDigits: 2 })} GB`;
}

function parseIdentifiers(value: string): string[] {
  return Array.from(new Set(
    value.split(',').map((item) => item.trim()).filter(Boolean),
  ));
}

interface IdentifierFilterProps {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
}

function IdentifierFilter({ label, values, onChange }: IdentifierFilterProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(values.join(', '));

  useEffect(() => {
    setDraft(values.join(', '));
  }, [values]);

  const commit = () => onChange(parseIdentifiers(draft));

  return (
    <TextField
      label={label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
      size="small"
      fullWidth
      helperText={t('statistics.commaSeparated')}
      inputProps={{ 'aria-label': t('statistics.commaSeparatedAria', { label }) }}
    />
  );
}

interface SummaryCardProps {
  label: string;
  value: string;
  detail: string;
}

function SummaryCard({ label, value, detail }: SummaryCardProps) {
  return (
    <Card variant="outlined" aria-label={label} sx={{ minWidth: 0 }}>
      <CardContent>
        <Typography color="text.secondary" variant="body2">
          {label}
        </Typography>
        <Typography component="p" variant="h5" sx={{ my: 0.5, fontWeight: 650 }}>
          {value}
        </Typography>
        <Typography color="text.secondary" variant="caption">
          {detail}
        </Typography>
      </CardContent>
    </Card>
  );
}

interface TimeSeriesProps {
  title: string;
  description: string;
  buckets: StatisticsDailyBucket[];
  metric: (bucket: StatisticsDailyBucket) => number;
  formatValue: (value: number) => string;
  onSelectDate: (date: string) => void;
}

function TimeSeries({
  title,
  description,
  buckets,
  metric,
  formatValue,
  onSelectDate,
}: TimeSeriesProps) {
  const { t, formatDate } = useI18n();
  const values = buckets.map(metric);
  const maximum = Math.max(...values, 1);

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography component="h3" variant="h6">{title}</Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
        {description}
      </Typography>
      <Box
        component="ul"
        aria-label={t('statistics.byUtcDayAria', { title })}
        sx={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.max(buckets.length, 1)}, minmax(40px, 1fr))`,
          gap: 1,
          listStyle: 'none',
          m: 0,
          p: 0,
          minWidth: Math.max(buckets.length * 48, 280),
        }}
      >
        {buckets.map((bucket, index) => {
          const value = values[index];
          return (
            <Box component="li" key={bucket.date} sx={{ minWidth: 0 }}>
              <Tooltip title={t('statistics.filterDayTooltip')}>
                <ButtonBase
                  onClick={() => onSelectDate(bucket.date)}
                  aria-label={t('statistics.filterDayAria', { title, value: formatValue(value), date: bucket.date })}
                  sx={{
                    width: '100%',
                    height: 180,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    borderRadius: 1,
                    px: 0.5,
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
                  }}
                >
                  <Typography variant="caption" sx={{ mb: 0.5 }}>
                    {formatValue(value)}
                  </Typography>
                  <Box
                    aria-hidden="true"
                    sx={{
                      width: '70%',
                      minHeight: 4,
                      height: `${Math.max(4, (value / maximum) * 125)}px`,
                      maxHeight: 125,
                      bgcolor: 'primary.main',
                      borderRadius: '4px 4px 0 0',
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                    {formatDate(`${bucket.date}T00:00:00Z`, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                  </Typography>
                </ButtonBase>
              </Tooltip>
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
}

interface RankingTableProps {
  title: string;
  rows: StatisticsRankingRow[];
  selectedIds: readonly string[];
  mode: RankingMode;
  onSelect: (row: StatisticsRankingRow) => void;
  credentials?: boolean;
}

function RankingTable({ title, rows, selectedIds, mode, onSelect, credentials = false }: RankingTableProps) {
  const { t, tp, formatNumber } = useI18n();
  const providerMode = mode === 'providers';
  const toolMode = mode === 'tools';
  const subflowMode = mode === 'subflows';
  const runMode = mode === 'runs';
  const compact = (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  const duration = (value: number) => formatDuration(value, formatNumber, (days) => tp('statistics.duration.days', days, {
    value: formatNumber(days, { maximumFractionDigits: 1 }),
  }));

  const headers: string[] = runMode
    ? [
      t('statistics.logicalRuns'),
      t('statistics.failures'),
      t('statistics.skips'),
      t('statistics.tokens'),
      t('statistics.runWallClock'),
      t('statistics.toolFailures'),
    ]
    : providerMode
      ? [
        t('statistics.attempts'),
        t('statistics.providerFailures'),
        t('statistics.tokens'),
        t('statistics.providerWallClock'),
        t('statistics.peakContext'),
      ]
      : toolMode
        ? [
          t('statistics.calls'),
          t('statistics.toolFailures'),
          t('statistics.sort.duration'),
          t('statistics.requestBytes'),
          t('statistics.responseBytes'),
          t('statistics.cacheHitRate'),
        ]
        : [
          t('statistics.subflowCalls'),
          t('statistics.failures'),
          t('statistics.sort.duration'),
          t('statistics.tokens'),
        ];

  const cells = (row: StatisticsRankingRow): string[] => (runMode
    ? [
      formatNumber(row.runs),
      formatNumber(row.errors),
      formatNumber(row.schedulerSkips),
      compact(row.usage.totalTokens),
      duration(row.runDuration.totalMs),
      formatNumber(row.toolFailures),
    ]
    : providerMode
      ? [
        formatNumber(row.providerAttempts),
        formatNumber(row.providerErrors),
        compact(row.usage.totalTokens),
        duration(row.providerDuration.totalMs),
        formatPercent(row.peakContextUtilization, formatNumber),
      ]
      : toolMode
        ? [
          formatNumber(row.toolCalls),
          formatNumber(row.toolFailures),
          duration(row.toolDuration.totalMs),
          formatBytes(row.toolPayload?.request.totalBytes ?? 0, formatNumber),
          formatBytes(row.toolPayload?.response.totalBytes ?? 0, formatNumber),
          formatPercent(row.cache?.hitRate ?? 0, formatNumber),
        ]
        : [
          formatNumber(row.subflowCalls ?? 0),
          formatNumber(row.subflowFailures ?? 0),
          duration(row.subflowDuration?.totalMs ?? 0),
          compact(row.usage.totalTokens),
        ]);

  return (
    <Paper component="section" variant="outlined" sx={{ minWidth: 0 }}>
      <Box sx={{ px: 2, pt: 2 }}>
        <Typography component="h3" variant="h6">{title}</Typography>
        <Typography color="text.secondary" variant="body2">
          {t('statistics.rankingHint')}
        </Typography>
      </Box>
      <TableContainer sx={{ mt: 1 }}>
        <Table size="small" aria-label={t('statistics.rankingAria', { title })}>
          <TableHead>
            <TableRow>
              <TableCell>{t('statistics.name')}</TableCell>
              {headers.map((header) => (
                <TableCell key={header} align="right">{header}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={headers.length + 1}>
                  <Typography color="text.secondary" align="center" sx={{ py: 2 }}>
                    {t('statistics.noRankedItems')}
                  </Typography>
                </TableCell>
              </TableRow>
            ) : rows.map((row) => {
              const label = credentials ? row.id : row.name || row.id;
              return (
                <TableRow
                  key={row.id}
                  hover
                  selected={selectedIds.includes(row.id)}
                  tabIndex={0}
                  aria-label={t('statistics.filterByAria', { title, label })}
                  onClick={() => onSelect(row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelect(row);
                    }
                  }}
                  sx={{
                    cursor: 'pointer',
                    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
                  }}
                >
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>{label}</Typography>
                    {!credentials && row.name && (
                      <Typography variant="caption" color="text.secondary">{row.id}</Typography>
                    )}
                  </TableCell>
                  {cells(row).map((value, index) => (
                    <TableCell key={`${row.id}-${index}`} align="right">{value}</TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

interface BreakdownProps {
  title: string;
  description: string;
  rows: Array<{ label: string; value: string }>;
  emptyLabel: string;
}

/** Compact, non-color breakdown table used for failure classes and categories. */
function Breakdown({ title, description, rows, emptyLabel }: BreakdownProps) {
  return (
    <Paper component="section" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Typography component="h3" variant="h6">{title}</Typography>
      <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
        {description}
      </Typography>
      {rows.length === 0 ? (
        <Typography color="text.secondary" variant="body2">{emptyLabel}</Typography>
      ) : (
        <Table size="small" aria-label={title}>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label}>
                <TableCell>{row.label}</TableCell>
                <TableCell align="right">{row.value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}

export default function Statistics() {
  const { t, tp, formatNumber } = useI18n();
  const [filters, setFilters] = useState<StatisticsDashboardFilters>(
    () => createDefaultStatisticsFilters(),
  );
  const [data, setData] = useState<Awaited<ReturnType<typeof statisticsService.get>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [tab, setTab] = useState<TabKey>('overview');
  const [detailKind, setDetailKind] = useState<StatisticsDetailKind>('runs');
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailRows, setDetailRows] = useState<StatisticsDetailRow[]>([]);
  const [detailCursor, setDetailCursor] = useState<string | undefined>(undefined);
  const [detailTotal, setDetailTotal] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [baselineRevision, setBaselineRevision] = useState('');
  const [candidateRevision, setCandidateRevision] = useState('');
  const [comparison, setComparison] = useState<StatisticsComparisonResponse | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);

  const rangeError = !filters.range.from || !filters.range.to
    ? t('statistics.chooseBothDates')
    : filters.range.from > filters.range.to
      ? t('statistics.invalidRange')
      : null;

  useEffect(() => {
    if (rangeError) {
      setLoading(false);
      setError(rangeError);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);
    statisticsService.get(filters, controller.signal)
      .then((response) => setData(response))
      .catch((requestError: unknown) => {
        if (!controller.signal.aborted) {
          setError(requestError instanceof Error ? requestError.message : t('statistics.unavailable'));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [filters, refreshVersion, rangeError, t]);

  const updateArrayFilter = (field: ArrayFilterKey, values: readonly string[]) => {
    setFilters((current) => ({
      ...current,
      [field]: values.length > 0 ? Array.from(new Set(values)) : undefined,
    } as StatisticsDashboardFilters));
  };

  const removeFilterValue = (field: ArrayFilterKey, value: string) => {
    const current = (filters[field] as readonly string[] | undefined) ?? [];
    updateArrayFilter(field, current.filter((item) => item !== value));
  };

  const activeFilters = useMemo(() => {
    const labels: Array<{ field: ArrayFilterKey; value: string; label: string }> = [];
    const fieldLabels: Record<ArrayFilterKey, string> = {
      flowIds: t('statistics.field.flow'),
      plannedExecutionIds: t('statistics.field.execution'),
      sources: t('statistics.field.source'),
      statuses: t('statistics.field.status'),
      modelIds: t('statistics.field.model'),
      providerIds: t('statistics.field.provider'),
      credentialIds: t('statistics.field.credential'),
      nodeIds: t('statistics.field.node'),
      toolIds: t('statistics.field.tool'),
      subflowIds: t('statistics.field.subflow'),
      subflowModes: t('statistics.field.subflowMode'),
      revisionIds: t('statistics.field.revision'),
      cacheOutcomes: t('statistics.field.cacheOutcome'),
      contentCategories: t('statistics.field.contentCategory'),
      parentRunIds: t('statistics.field.parentRun'),
    };
    (Object.keys(fieldLabels) as ArrayFilterKey[]).forEach((field) => {
      const values = filters[field] as readonly string[] | undefined;
      values?.forEach((value) => labels.push({
        field,
        value,
        label: `${fieldLabels[field]}: ${value}`,
      }));
    });
    return labels;
  }, [filters, t]);

  const selectRanking = (field: ArrayFilterKey) => (row: StatisticsRankingRow) => {
    updateArrayFilter(field, [row.id]);
  };

  const reset = () => {
    setFilters(createDefaultStatisticsFilters());
    setComparison(null);
    setBaselineRevision('');
    setCandidateRevision('');
  };
  const selectDate = (date: string) => {
    setFilters((current) => ({ ...current, range: { from: date, to: date } }));
  };

  const loadDetails = useCallback(async (
    kind: StatisticsDetailKind,
    cursor?: string,
  ): Promise<void> => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await statisticsService.getDetails(filters, {
        kind,
        cursor,
        limit: DETAIL_LIMIT,
      });
      setDetailRows((current) => (cursor ? [...current, ...response.rows] : response.rows));
      setDetailCursor(response.nextCursor);
      setDetailTotal(response.total);
    } catch (requestError: unknown) {
      setDetailError(requestError instanceof Error
        ? requestError.message
        : t('statistics.unavailable'));
    } finally {
      setDetailLoading(false);
    }
  }, [filters, t]);

  const openDetails = (kind: StatisticsDetailKind) => {
    setDetailKind(kind);
    setDetailOpen(true);
    setDetailRows([]);
    setDetailCursor(undefined);
    setDetailTotal(0);
    void loadDetails(kind);
  };

  const runComparison = async () => {
    if (!baselineRevision || !candidateRevision) return;
    setComparisonLoading(true);
    setComparisonError(null);
    try {
      setComparison(await statisticsService.compare(filters, {
        baselineRevisionIds: [baselineRevision],
        candidateRevisionIds: [candidateRevision],
      }));
    } catch (requestError: unknown) {
      setComparison(null);
      setComparisonError(requestError instanceof Error
        ? requestError.message
        : t('statistics.unavailable'));
    } finally {
      setComparisonLoading(false);
    }
  };

  const hasData = !!data && (
    data.summary.runs > 0
    || data.summary.schedulerSkips > 0
    || data.summary.providerAttempts > 0
    || data.summary.nodeVisits > 0
    || data.summary.toolCalls > 0
    || (data.summary.subflowCalls ?? 0) > 0
  );
  const successRate = data && data.summary.runs > 0
    ? data.summary.successes / data.summary.runs
    : 0;
  const compact = (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  const duration = (value: number) => formatDuration(value, formatNumber, (days) => tp('statistics.duration.days', days, {
    value: formatNumber(days, { maximumFractionDigits: 1 }),
  }));
  const sourceLabels: Record<StatisticsRunSource, TranslationKey> = {
    chat: 'statistics.source.chat',
    api: 'statistics.source.api',
    schedule: 'statistics.source.schedule',
    trigger: 'statistics.source.trigger',
    subflow: 'statistics.source.subflow',
    mcp: 'statistics.source.mcp',
    internal: 'statistics.source.internal',
    meeting: 'statistics.source.meeting',
    'internal-tool': 'statistics.source.internalTool',
  };
  const statusLabels: Record<StatisticsStatusFilter, TranslationKey> = {
    completed: 'statistics.status.completed',
    error: 'statistics.status.error',
    capped: 'statistics.status.capped',
    cancelled: 'statistics.status.cancelled',
    paused: 'statistics.status.paused',
    skipped: 'statistics.status.skipped',
  };

  const errorClassRows = Object.entries(data?.summary.errorClasses ?? {})
    .map(([key, count]) => ({ label: key as StatisticsErrorClass, value: count as number }))
    .sort((left, right) => right.value - left.value)
    .map((row) => ({ label: row.label, value: formatNumber(row.value) }));
  const contentCategoryRows = Object.entries(data?.summary.contentCategories ?? {})
    .map(([key, count]) => ({ label: key as StatisticsContentCategory, value: count as number }))
    .sort((left, right) => right.value - left.value)
    .map((row) => ({ label: row.label, value: formatNumber(row.value) }));
  const phaseRows = Object.entries(data?.summary.phases ?? {})
    .map(([key, metrics]) => ({
      phase: key as StatisticsPhase,
      metrics: metrics as { count: number; totalMs: number; averageMs: number; p95Ms: number },
    }))
    .sort((left, right) => right.metrics.totalMs - left.metrics.totalMs);
  const revisionOptions = data?.rankings.revisions ?? [];

  return (
    <Box component="section" sx={{ overflow: 'auto' }}>
      <PageHeader
        eyebrow={t('statistics.header.eyebrow')}
        title={t('statistics.header.title')}
        description={t('statistics.header.description')}
        icon={InsightsRoundedIcon}
        badge={<Chip label={t('statistics.experimental')} size="small" color="secondary" variant="outlined" />}
        actions={(
          <>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={reset}
            disabled={loading && !data}
          >
            {t('statistics.reset')}
          </Button>
          <Button
            variant="contained"
            startIcon={<RefreshIcon />}
            onClick={() => setRefreshVersion((version) => version + 1)}
            disabled={loading || !!rangeError}
          >
            {t('statistics.refresh')}
          </Button>
          </>
        )}
      />

      <Box sx={{ p: { xs: 2, md: 3 }, width: '100%', maxWidth: 1440, mx: 'auto' }}>
      <Paper component="section" variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography component="h2" variant="h6" sx={{ mb: 1.5 }}>{t('statistics.sharedFilters')}</Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <TextField
            label={t('statistics.fromUtc')}
            type="date"
            value={filters.range.from}
            onChange={(event) => setFilters((current) => ({
              ...current,
              range: { ...current.range, from: event.target.value },
            }))}
            size="small"
            fullWidth
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': t('statistics.startDateAria') }}
          />
          <TextField
            label={t('statistics.toUtc')}
            type="date"
            value={filters.range.to}
            onChange={(event) => setFilters((current) => ({
              ...current,
              range: { ...current.range, to: event.target.value },
            }))}
            size="small"
            fullWidth
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': t('statistics.endDateAria') }}
          />
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-source-label">{t('statistics.sources')}</InputLabel>
            <Select
              labelId="statistics-source-label"
              multiple
              label={t('statistics.sources')}
              value={filters.sources ?? []}
              onChange={(event) => updateArrayFilter(
                'sources',
                typeof event.target.value === 'string'
                  ? event.target.value.split(',')
                  : event.target.value,
              )}
              renderValue={(selected) => selected.join(', ')}
            >
              {RUN_SOURCES.map((source) => (
                <MenuItem key={source} value={source}>{t(sourceLabels[source])}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-status-label">{t('statistics.statuses')}</InputLabel>
            <Select
              labelId="statistics-status-label"
              multiple
              label={t('statistics.statuses')}
              value={filters.statuses ?? []}
              onChange={(event) => updateArrayFilter(
                'statuses',
                typeof event.target.value === 'string'
                  ? event.target.value.split(',')
                  : event.target.value,
              )}
              renderValue={(selected) => selected.join(', ')}
            >
              {STATUSES.map((status) => (
                <MenuItem key={status} value={status}>{t(statusLabels[status])}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-subflow-mode-label">{t('statistics.field.subflowMode')}</InputLabel>
            <Select
              labelId="statistics-subflow-mode-label"
              multiple
              label={t('statistics.field.subflowMode')}
              value={filters.subflowModes ?? []}
              onChange={(event) => updateArrayFilter(
                'subflowModes',
                typeof event.target.value === 'string'
                  ? event.target.value.split(',')
                  : event.target.value,
              )}
              renderValue={(selected) => selected.join(', ')}
            >
              {SUBFLOW_MODES.map((mode) => (
                <MenuItem key={mode} value={mode}>{mode}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-cache-outcome-label">{t('statistics.field.cacheOutcome')}</InputLabel>
            <Select
              labelId="statistics-cache-outcome-label"
              multiple
              label={t('statistics.field.cacheOutcome')}
              value={filters.cacheOutcomes ?? []}
              onChange={(event) => updateArrayFilter(
                'cacheOutcomes',
                typeof event.target.value === 'string'
                  ? event.target.value.split(',')
                  : event.target.value,
              )}
              renderValue={(selected) => selected.join(', ')}
            >
              {CACHE_OUTCOMES.map((outcome) => (
                <MenuItem key={outcome} value={outcome}>{outcome}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-content-category-label">{t('statistics.field.contentCategory')}</InputLabel>
            <Select
              labelId="statistics-content-category-label"
              multiple
              label={t('statistics.field.contentCategory')}
              value={filters.contentCategories ?? []}
              onChange={(event) => updateArrayFilter(
                'contentCategories',
                typeof event.target.value === 'string'
                  ? event.target.value.split(',')
                  : event.target.value,
              )}
              renderValue={(selected) => selected.join(', ')}
            >
              {CONTENT_CATEGORIES.map((category) => (
                <MenuItem key={category} value={category}>{category}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-sort-label">{t('statistics.sortField')}</InputLabel>
            <Select
              labelId="statistics-sort-label"
              label={t('statistics.sortField')}
              value={filters.sort?.field ?? 'activity'}
              onChange={(event) => setFilters((current) => ({
                ...current,
                sort: {
                  field: event.target.value as StatisticsSortField,
                  direction: current.sort?.direction ?? 'desc',
                },
              }))}
            >
              {SORT_FIELDS.map(({ field, labelKey }) => (
                <MenuItem key={field} value={field}>{t(labelKey)}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-direction-label">{t('statistics.sortDirection')}</InputLabel>
            <Select
              labelId="statistics-direction-label"
              label={t('statistics.sortDirection')}
              value={filters.sort?.direction ?? 'desc'}
              onChange={(event) => setFilters((current) => ({
                ...current,
                sort: {
                  field: current.sort?.field ?? 'activity',
                  direction: event.target.value as StatisticsSortDirection,
                },
              }))}
            >
              <MenuItem value="desc">{t('statistics.sort.desc')}</MenuItem>
              <MenuItem value="asc">{t('statistics.sort.asc')}</MenuItem>
            </Select>
          </FormControl>
          {IDENTIFIER_FILTERS.map(({ field, labelKey }) => (
            <IdentifierFilter
              key={field}
              label={t(labelKey)}
              values={(filters[field] as readonly string[] | undefined) ?? []}
              onChange={(values) => updateArrayFilter(field, values)}
            />
          ))}
        </Box>
        <Stack
          direction="row"
          flexWrap="wrap"
          gap={1}
          alignItems="center"
          aria-label={t('statistics.activeFiltersAria')}
          sx={{ mt: activeFilters.length > 0 ? 2 : 1 }}
        >
          {activeFilters.length === 0 ? (
            <Typography variant="body2" color="text.secondary">{t('statistics.noDimensionFilters')}</Typography>
          ) : activeFilters.map((filter) => (
            <Chip
              key={`${filter.field}:${filter.value}`}
              label={filter.label}
              onDelete={() => removeFilterValue(filter.field, filter.value)}
              size="small"
            />
          ))}
        </Stack>
      </Paper>

      {loading && <LinearProgress aria-label={t('statistics.refreshingAria')} sx={{ mb: 2 }} />}
      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={(
            <Button color="inherit" size="small" onClick={() => setRefreshVersion((version) => version + 1)}>
              {t('statistics.retry')}
            </Button>
          )}
        >
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <Stack alignItems="center" spacing={1.5} sx={{ py: 8 }}>
          <Spinner size="large" />
          <Typography>{t('statistics.loading')}</Typography>
        </Stack>
      ) : !data ? null : !hasData ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography component="h2" variant="h6">{t('statistics.noTelemetry')}</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 620, mx: 'auto' }}>
            {t('statistics.noTelemetryDescription')}
          </Typography>
        </Paper>
      ) : (
        <>
          {data.truncatedDimensions && data.truncatedDimensions.length > 0 && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {t('statistics.truncatedDimensions', { dimensions: data.truncatedDimensions.join(', ') })}
            </Alert>
          )}
          <Box
            component="section"
            aria-label={t('statistics.summaryAria')}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)', xl: 'repeat(6, 1fr)' },
              gap: 2,
              mb: 2,
            }}
          >
            <SummaryCard
              label={t('statistics.logicalRuns')}
              value={formatNumber(data.summary.runs)}
              detail={t('statistics.schedulerSkips', { count: formatNumber(data.summary.schedulerSkips) })}
            />
            <SummaryCard
              label={t('statistics.successRate')}
              value={formatPercent(successRate, formatNumber)}
              detail={t('statistics.completedSuccessfully', { count: formatNumber(data.summary.successes) })}
            />
            <SummaryCard
              label={t('statistics.tokens')}
              value={compact(data.summary.usage.totalTokens)}
              detail={t('statistics.inputOutputTokens', { input: compact(data.summary.usage.inputTokens), output: compact(data.summary.usage.outputTokens) })}
            />
            <SummaryCard
              label={t('statistics.runWallClock')}
              value={duration(data.summary.runDuration.totalMs)}
              detail={`P95 ${duration(data.summary.runDuration.p95Ms)}`}
            />
            <SummaryCard
              label={t('statistics.failedToolCalls')}
              value={formatNumber(data.summary.toolFailures)}
              detail={t('statistics.totalToolCalls', { count: formatNumber(data.summary.toolCalls) })}
            />
            <SummaryCard
              label={t('statistics.cacheHitRate')}
              value={formatPercent(data.summary.cache?.hitRate ?? 0, formatNumber)}
              detail={t('statistics.cacheDetail', {
                hits: formatNumber(data.summary.cache?.hits ?? 0),
                requests: formatNumber(data.summary.cache?.requests ?? 0),
              })}
            />
          </Box>

          <Paper variant="outlined" sx={{ mb: 2 }}>
            <Tabs
              value={tab}
              onChange={(_, value: TabKey) => setTab(value)}
              variant="scrollable"
              scrollButtons="auto"
              aria-label={t('statistics.viewsAria')}
            >
              <Tab value="overview" label={t('statistics.tab.overview')} id="statistics-tab-overview" />
              <Tab value="flows" label={t('statistics.tab.flows')} id="statistics-tab-flows" />
              <Tab value="executions" label={t('statistics.tab.executions')} id="statistics-tab-executions" />
              <Tab value="models" label={t('statistics.tab.models')} id="statistics-tab-models" />
              <Tab value="providers" label={t('statistics.tab.providers')} id="statistics-tab-providers" />
              <Tab value="nodes" label={t('statistics.tab.nodes')} id="statistics-tab-nodes" />
              <Tab value="tools" label={t('statistics.tab.tools')} id="statistics-tab-tools" />
              <Tab value="subflows" label={t('statistics.tab.subflows')} id="statistics-tab-subflows" />
              <Tab value="compare" label={t('statistics.tab.compare')} id="statistics-tab-compare" />
            </Tabs>
          </Paper>

          <Box role="tabpanel" aria-labelledby={`statistics-tab-${tab}`}>
            {tab === 'overview' && (
              <Stack spacing={2}>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' },
                    gap: 2,
                    overflowX: 'auto',
                  }}
                >
                  <TimeSeries
                    title={t('statistics.executions')}
                    description={t('statistics.executionsDescription')}
                    buckets={data.daily}
                    metric={(bucket) => bucket.summary.runs}
                    formatValue={(value) => formatNumber(value)}
                    onSelectDate={selectDate}
                  />
                  <TimeSeries
                    title={t('statistics.tokens')}
                    description={t('statistics.tokensDescription')}
                    buckets={data.daily}
                    metric={(bucket) => bucket.summary.usage.totalTokens}
                    formatValue={compact}
                    onSelectDate={selectDate}
                  />
                </Box>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button variant="outlined" size="small" onClick={() => openDetails('runs')}>
                    {`${t('statistics.openDetails')}: ${t('statistics.detailKind.runs')}`}
                  </Button>
                  <Button variant="outlined" size="small" onClick={() => openDetails('tools')}>
                    {`${t('statistics.openDetails')}: ${t('statistics.detailKind.tools')}`}
                  </Button>
                  <Button variant="outlined" size="small" onClick={() => openDetails('subflows')}>
                    {`${t('statistics.openDetails')}: ${t('statistics.detailKind.subflows')}`}
                  </Button>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  {t('statistics.incompleteRuns', { count: formatNumber(data.summary.runsIncomplete ?? 0) })}
                  {' · '}
                  {t('statistics.cacheUnknownNote', { count: formatNumber(data.summary.cache?.unknown ?? 0) })}
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' },
                    gap: 2,
                  }}
                >
                  <Breakdown
                    title={t('statistics.errorClasses')}
                    description={t('statistics.errorClassesDescription')}
                    rows={errorClassRows}
                    emptyLabel={t('statistics.noRankedItems')}
                  />
                  <Breakdown
                    title={t('statistics.contentCategories')}
                    description={t('statistics.contentCategoriesDescription')}
                    rows={contentCategoryRows}
                    emptyLabel={t('statistics.noRankedItems')}
                  />
                  <Paper component="section" variant="outlined" sx={{ p: 2, minWidth: 0 }}>
                    <Typography component="h3" variant="h6">{t('statistics.phaseTimings')}</Typography>
                    <Typography color="text.secondary" variant="body2" sx={{ mb: 1 }}>
                      {t('statistics.phaseTimingsDescription')}
                    </Typography>
                    {phaseRows.length === 0 ? (
                      <Typography color="text.secondary" variant="body2">
                        {t('statistics.noRankedItems')}
                      </Typography>
                    ) : (
                      <Table size="small" aria-label={t('statistics.phaseTimings')}>
                        <TableHead>
                          <TableRow>
                            <TableCell>{t('statistics.phase')}</TableCell>
                            <TableCell align="right">{t('statistics.count')}</TableCell>
                            <TableCell align="right">{t('statistics.total')}</TableCell>
                            <TableCell align="right">P95</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {phaseRows.map((row) => (
                            <TableRow key={row.phase}>
                              <TableCell>{row.phase}</TableCell>
                              <TableCell align="right">{formatNumber(row.metrics.count)}</TableCell>
                              <TableCell align="right">{duration(row.metrics.totalMs)}</TableCell>
                              <TableCell align="right">{duration(row.metrics.p95Ms)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </Paper>
                </Box>
              </Stack>
            )}
            {tab === 'flows' && (
              <RankingTable
                title={t('statistics.tab.flows')}
                rows={data.rankings.flows}
                selectedIds={filters.flowIds ?? []}
                mode="runs"
                onSelect={selectRanking('flowIds')}
              />
            )}
            {tab === 'executions' && (
              <RankingTable
                title={t('statistics.plannedExecutions')}
                rows={data.rankings.plannedExecutions}
                selectedIds={filters.plannedExecutionIds ?? []}
                mode="runs"
                onSelect={selectRanking('plannedExecutionIds')}
              />
            )}
            {tab === 'models' && (
              <Box>
                <Alert severity="info" sx={{ mb: 2 }}>
                  {t('statistics.modelMetricNote')}
                </Alert>
                <RankingTable
                  title={t('statistics.tab.models')}
                  rows={data.rankings.models}
                  selectedIds={filters.modelIds ?? []}
                  mode="providers"
                  onSelect={selectRanking('modelIds')}
                />
              </Box>
            )}
            {tab === 'providers' && (
              <Stack spacing={2}>
                <Alert severity="info">
                  {t('statistics.credentialMetricNote')}
                </Alert>
                <RankingTable
                  title={t('statistics.providers')}
                  rows={data.rankings.providers}
                  selectedIds={filters.providerIds ?? []}
                  mode="providers"
                  onSelect={selectRanking('providerIds')}
                />
                <RankingTable
                  title={t('statistics.credentials')}
                  rows={data.rankings.credentials}
                  selectedIds={filters.credentialIds ?? []}
                  mode="providers"
                  onSelect={selectRanking('credentialIds')}
                  credentials
                />
              </Stack>
            )}
            {tab === 'nodes' && (
              <RankingTable
                title={t('statistics.tab.nodes')}
                rows={data.rankings.nodes}
                selectedIds={filters.nodeIds ?? []}
                mode="runs"
                onSelect={selectRanking('nodeIds')}
              />
            )}
            {tab === 'tools' && (
              <Stack spacing={2}>
                <RankingTable
                  title={t('statistics.tab.tools')}
                  rows={data.rankings.tools}
                  selectedIds={filters.toolIds ?? []}
                  mode="tools"
                  onSelect={selectRanking('toolIds')}
                />
                <Button variant="outlined" size="small" onClick={() => openDetails('tools')}>
                  {t('statistics.openDetails')}
                </Button>
              </Stack>
            )}
            {tab === 'subflows' && (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  {t('statistics.subflowIncomplete', {
                    count: formatNumber(data.summary.subflowIncomplete ?? 0),
                  })}
                </Typography>
                <RankingTable
                  title={t('statistics.tab.subflows')}
                  rows={data.rankings.subflows ?? []}
                  selectedIds={filters.subflowIds ?? []}
                  mode="subflows"
                  onSelect={selectRanking('subflowIds')}
                />
                <Button variant="outlined" size="small" onClick={() => openDetails('subflows')}>
                  {t('statistics.openDetails')}
                </Button>
              </Stack>
            )}
            {tab === 'compare' && (
              <Paper component="section" variant="outlined" sx={{ p: 2 }}>
                <Typography component="h3" variant="h6">{t('statistics.compare.title')}</Typography>
                <Typography color="text.secondary" variant="body2" sx={{ mb: 2 }}>
                  {t('statistics.compare.description')}
                </Typography>
                {revisionOptions.length === 0 ? (
                  <Alert severity="info">{t('statistics.compare.noRevisions')}</Alert>
                ) : (
                  <Stack spacing={2}>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' },
                        gap: 2,
                      }}
                    >
                      <FormControl size="small" fullWidth>
                        <InputLabel id="statistics-baseline-label">{t('statistics.compare.baseline')}</InputLabel>
                        <Select
                          labelId="statistics-baseline-label"
                          label={t('statistics.compare.baseline')}
                          value={baselineRevision}
                          onChange={(event) => setBaselineRevision(event.target.value)}
                        >
                          {revisionOptions.map((row) => (
                            <MenuItem key={row.id} value={row.id}>{row.id}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <FormControl size="small" fullWidth>
                        <InputLabel id="statistics-candidate-label">{t('statistics.compare.candidate')}</InputLabel>
                        <Select
                          labelId="statistics-candidate-label"
                          label={t('statistics.compare.candidate')}
                          value={candidateRevision}
                          onChange={(event) => setCandidateRevision(event.target.value)}
                        >
                          {revisionOptions.map((row) => (
                            <MenuItem key={row.id} value={row.id}>{row.id}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <Button
                        variant="contained"
                        onClick={() => void runComparison()}
                        disabled={!baselineRevision || !candidateRevision || comparisonLoading}
                      >
                        {t('statistics.compare.run')}
                      </Button>
                    </Box>
                    {(!baselineRevision || !candidateRevision) && (
                      <Typography variant="body2" color="text.secondary">
                        {t('statistics.compare.selectBoth')}
                      </Typography>
                    )}
                    {comparisonLoading && (
                      <LinearProgress aria-label={t('statistics.refreshingAria')} />
                    )}
                    {comparisonError && <Alert severity="error">{comparisonError}</Alert>}
                    {comparison && (
                      <>
                        {comparison.warnings.map((warning) => (
                          <Alert
                            key={warning}
                            severity={warning === 'observational_comparison' ? 'info' : 'warning'}
                          >
                            {warning === 'observational_comparison'
                              ? t('statistics.compare.warning.observational')
                              : warning === 'insufficient_baseline_samples'
                                ? t('statistics.compare.warning.baseline')
                                : warning === 'insufficient_candidate_samples'
                                  ? t('statistics.compare.warning.candidate')
                                  : t('statistics.compare.warning.ranges')}
                          </Alert>
                        ))}
                        <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
                          <Typography variant="body2">
                            {`${t('statistics.compare.baseline')}: ${t('statistics.compare.samples', {
                              count: formatNumber(comparison.baseline.samples),
                            })}`}
                          </Typography>
                          <Typography variant="body2">
                            {`${t('statistics.compare.candidate')}: ${t('statistics.compare.samples', {
                              count: formatNumber(comparison.candidate.samples),
                            })}`}
                          </Typography>
                        </Stack>
                        <TableContainer>
                          <Table size="small" aria-label={t('statistics.compare.title')}>
                            <TableHead>
                              <TableRow>
                                <TableCell>{t('statistics.compare.metric')}</TableCell>
                                <TableCell align="right">{t('statistics.compare.baseline')}</TableCell>
                                <TableCell align="right">{t('statistics.compare.candidate')}</TableCell>
                                <TableCell align="right">{t('statistics.compare.delta')}</TableCell>
                                <TableCell align="right">{t('statistics.compare.percentDelta')}</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {comparison.deltas.map((delta) => {
                                const isRate = RATE_METRICS.has(delta.metric);
                                const value = (input: number) => (isRate
                                  ? formatPercent(input, formatNumber)
                                  : delta.metric === 'runDurationP95Ms'
                                    ? duration(input)
                                    : formatNumber(input));
                                return (
                                  <TableRow key={delta.metric}>
                                    <TableCell>{t(COMPARISON_METRIC_LABELS[delta.metric])}</TableCell>
                                    <TableCell align="right">{value(delta.baseline)}</TableCell>
                                    <TableCell align="right">{value(delta.candidate)}</TableCell>
                                    <TableCell align="right">
                                      {isRate
                                        ? formatPercent(delta.absoluteDelta, formatNumber)
                                        : formatNumber(delta.absoluteDelta)}
                                    </TableCell>
                                    <TableCell align="right">
                                      {delta.percentDelta === null
                                        ? '—'
                                        : formatPercent(delta.percentDelta, formatNumber)}
                                    </TableCell>
                                  </TableRow>
                                );
                              })}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      </>
                    )}
                  </Stack>
                )}
              </Paper>
            )}
          </Box>
        </>
      )}
      </Box>

      <Drawer
        anchor="right"
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        PaperProps={{ sx: { width: { xs: '100%', md: 720 }, p: 2 } }}
      >
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 1 }}
        >
          <Typography component="h2" variant="h6">
            {`${t('statistics.details')} · ${t(`statistics.detailKind.${detailKind}` as TranslationKey)}`}
          </Typography>
          <IconButton onClick={() => setDetailOpen(false)} aria-label={t('statistics.close')}>
            <CloseIcon />
          </IconButton>
        </Stack>
        <Alert severity="info" sx={{ mb: 2 }}>{t('statistics.metadataOnlyNote')}</Alert>
        {detailLoading && <LinearProgress aria-label={t('statistics.refreshingAria')} sx={{ mb: 2 }} />}
        {detailError && <Alert severity="error" sx={{ mb: 2 }}>{detailError}</Alert>}
        <TableContainer>
          <Table size="small" aria-label={t('statistics.detailsAria')}>
            <TableBody>
              {detailRows.length === 0 && !detailLoading ? (
                <TableRow>
                  <TableCell>
                    <Typography color="text.secondary">{t('statistics.noDetailRows')}</Typography>
                  </TableCell>
                </TableRow>
              ) : detailRows.map((row, index) => (
                <TableRow key={`${row.runId}-${row.timestamp}-${index}`}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600}>
                      {row.kind === 'run'
                        ? `${row.flowName ?? row.flowId ?? row.runId} · ${row.status}`
                        : row.kind === 'tool'
                          ? `${row.toolName ?? row.toolId} · ${row.outcome}`
                          : `${row.subflowName ?? row.subflowId} · ${row.mode} · ${row.outcome}`}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="div">
                      {row.timestamp}
                      {row.kind === 'run' && row.durationMs !== undefined && ` · ${duration(row.durationMs)}`}
                      {row.kind !== 'run' && ` · ${duration(row.durationMs)}`}
                      {row.kind === 'run' && ` · ${t('statistics.sort.toolCalls')}: ${formatNumber(row.toolCalls)}`}
                      {row.kind === 'tool' && row.requestBytes !== undefined
                        && ` · ${t('statistics.requestBytes')}: ${formatBytes(row.requestBytes, formatNumber)}`}
                      {row.kind === 'tool' && row.responseBytes !== undefined
                        && ` · ${t('statistics.responseBytes')}: ${formatBytes(row.responseBytes, formatNumber)}`}
                      {row.kind === 'tool' && row.cacheOutcome && ` · ${row.cacheOutcome}`}
                      {row.kind === 'subflow' && row.waitMs !== undefined && ` · ${duration(row.waitMs)}`}
                      {row.errorClass && ` · ${row.errorClass}`}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
          <Typography variant="body2" color="text.secondary">
            {t('statistics.showingRows', {
              shown: formatNumber(detailRows.length),
              total: formatNumber(detailTotal),
            })}
          </Typography>
          {detailCursor && (
            <Button
              size="small"
              variant="outlined"
              onClick={() => void loadDetails(detailKind, detailCursor)}
              disabled={detailLoading}
            >
              {t('statistics.loadMore')}
            </Button>
          )}
        </Stack>
      </Drawer>
    </Box>
  );
}
