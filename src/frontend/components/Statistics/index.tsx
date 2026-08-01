'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Card,
  CardContent,
  Chip,
  FormControl,
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
import InsightsRoundedIcon from '@mui/icons-material/InsightsRounded';
import Spinner from '@/frontend/components/shared/Spinner';
import PageHeader from '@/frontend/components/shared/PageHeader';
import {
  createDefaultStatisticsFilters,
  statisticsService,
  StatisticsDashboardFilters,
} from '@/frontend/services/statistics';
import {
  StatisticsDailyBucket,
  StatisticsRankingRow,
  StatisticsRunSource,
  StatisticsStatusFilter,
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

type ArrayFilterKey = Exclude<keyof StatisticsDashboardFilters, 'range'>;
type TabKey = 'overview' | 'flows' | 'executions' | 'models' | 'providers';

const IDENTIFIER_FILTERS: Array<{ field: ArrayFilterKey; labelKey: TranslationKey }> = [
  { field: 'flowIds', labelKey: 'statistics.filter.flowIds' },
  { field: 'plannedExecutionIds', labelKey: 'statistics.filter.executionIds' },
  { field: 'modelIds', labelKey: 'statistics.filter.modelIds' },
  { field: 'providerIds', labelKey: 'statistics.filter.providerIds' },
  { field: 'credentialIds', labelKey: 'statistics.filter.credentialIds' },
];

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
    <Card variant="outlined" sx={{ minWidth: 0 }}>
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
  mode: 'runs' | 'providers';
  onSelect: (row: StatisticsRankingRow) => void;
  credentials?: boolean;
}

function RankingTable({ title, rows, selectedIds, mode, onSelect, credentials = false }: RankingTableProps) {
  const { t, tp, formatNumber } = useI18n();
  const providerMode = mode === 'providers';
  const compact = (value: number) => formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 });
  const duration = (value: number) => formatDuration(value, formatNumber, (days) => tp('statistics.duration.days', days, {
    value: formatNumber(days, { maximumFractionDigits: 1 }),
  }));

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
              <TableCell align="right">{providerMode ? t('statistics.attempts') : t('statistics.logicalRuns')}</TableCell>
              <TableCell align="right">{providerMode ? t('statistics.providerFailures') : t('statistics.failures')}</TableCell>
              {!providerMode && <TableCell align="right">{t('statistics.skips')}</TableCell>}
              <TableCell align="right">{t('statistics.tokens')}</TableCell>
              <TableCell align="right">
                {providerMode ? t('statistics.providerWallClock') : t('statistics.runWallClock')}
              </TableCell>
              {providerMode ? (
                <TableCell align="right">{t('statistics.peakContext')}</TableCell>
              ) : (
                <TableCell align="right">{t('statistics.toolFailures')}</TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={providerMode ? 6 : 7}>
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
                  <TableCell align="right">
                    {formatNumber(providerMode ? row.providerAttempts : row.runs)}
                  </TableCell>
                  <TableCell align="right">
                    {formatNumber(providerMode ? row.providerErrors : row.errors)}
                  </TableCell>
                  {!providerMode && (
                    <TableCell align="right">{formatNumber(row.schedulerSkips)}</TableCell>
                  )}
                  <TableCell align="right">{compact(row.usage.totalTokens)}</TableCell>
                  <TableCell align="right">
                    {duration(
                      providerMode ? row.providerDuration.totalMs : row.runDuration.totalMs,
                    )}
                  </TableCell>
                  {providerMode ? (
                    <TableCell align="right">{formatPercent(row.peakContextUtilization, formatNumber)}</TableCell>
                  ) : (
                    <TableCell align="right">{formatNumber(row.toolFailures)}</TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
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

  const reset = () => setFilters(createDefaultStatisticsFilters());
  const selectDate = (date: string) => {
    setFilters((current) => ({ ...current, range: { from: date, to: date } }));
  };

  const hasData = !!data && (
    data.summary.runs > 0
    || data.summary.schedulerSkips > 0
    || data.summary.providerAttempts > 0
    || data.summary.nodeVisits > 0
    || data.summary.toolCalls > 0
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
          <Box
            component="section"
            aria-label={t('statistics.summaryAria')}
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(5, 1fr)' },
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
            </Tabs>
          </Paper>

          <Box role="tabpanel" aria-labelledby={`statistics-tab-${tab}`}>
            {tab === 'overview' && (
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
          </Box>
        </>
      )}
      </Box>
    </Box>
  );
}
