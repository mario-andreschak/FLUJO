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
import Spinner from '@/frontend/components/shared/Spinner';
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

const IDENTIFIER_FILTERS: Array<{ field: ArrayFilterKey; label: string }> = [
  { field: 'flowIds', label: 'Flow IDs' },
  { field: 'plannedExecutionIds', label: 'Planned execution IDs' },
  { field: 'modelIds', label: 'Model IDs' },
  { field: 'providerIds', label: 'Provider IDs' },
  { field: 'credentialIds', label: 'Credential IDs' },
];

const integerFormat = new Intl.NumberFormat();
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes < 10 ? 1 : 0)} min`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
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
      helperText="Comma-separated exact IDs"
      inputProps={{ 'aria-label': `${label}, comma-separated` }}
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
        aria-label={`${title} by UTC day`}
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
              <Tooltip title="Filter the dashboard to this UTC day">
                <ButtonBase
                  onClick={() => onSelectDate(bucket.date)}
                  aria-label={`${title}: ${formatValue(value)} on ${bucket.date}. Filter to this day.`}
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
                    {displayDate(bucket.date)}
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
}

function RankingTable({ title, rows, selectedIds, mode, onSelect }: RankingTableProps) {
  const providerMode = mode === 'providers';

  return (
    <Paper component="section" variant="outlined" sx={{ minWidth: 0 }}>
      <Box sx={{ px: 2, pt: 2 }}>
        <Typography component="h3" variant="h6">{title}</Typography>
        <Typography color="text.secondary" variant="body2">
          Select a row to apply it as a dashboard-wide filter.
        </Typography>
      </Box>
      <TableContainer sx={{ mt: 1 }}>
        <Table size="small" aria-label={`${title} ranking`}>
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell align="right">{providerMode ? 'Attempts' : 'Logical runs'}</TableCell>
              <TableCell align="right">{providerMode ? 'Provider failures' : 'Failures'}</TableCell>
              {!providerMode && <TableCell align="right">Skips</TableCell>}
              <TableCell align="right">Tokens</TableCell>
              <TableCell align="right">
                {providerMode ? 'Provider wall-clock' : 'Run wall-clock'}
              </TableCell>
              {providerMode ? (
                <TableCell align="right">Peak context</TableCell>
              ) : (
                <TableCell align="right">Tool failures</TableCell>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={providerMode ? 6 : 7}>
                  <Typography color="text.secondary" align="center" sx={{ py: 2 }}>
                    No ranked items match the current filters.
                  </Typography>
                </TableCell>
              </TableRow>
            ) : rows.map((row) => {
              const label = title === 'Credentials' ? row.id : row.name || row.id;
              return (
                <TableRow
                  key={row.id}
                  hover
                  selected={selectedIds.includes(row.id)}
                  tabIndex={0}
                  aria-label={`Filter by ${title}: ${label}`}
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
                    {title !== 'Credentials' && row.name && (
                      <Typography variant="caption" color="text.secondary">{row.id}</Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {integerFormat.format(providerMode ? row.providerAttempts : row.runs)}
                  </TableCell>
                  <TableCell align="right">
                    {integerFormat.format(providerMode ? row.providerErrors : row.errors)}
                  </TableCell>
                  {!providerMode && (
                    <TableCell align="right">{integerFormat.format(row.schedulerSkips)}</TableCell>
                  )}
                  <TableCell align="right">{compactFormat.format(row.usage.totalTokens)}</TableCell>
                  <TableCell align="right">
                    {formatDuration(
                      providerMode ? row.providerDuration.totalMs : row.runDuration.totalMs,
                    )}
                  </TableCell>
                  {providerMode ? (
                    <TableCell align="right">{formatPercent(row.peakContextUtilization)}</TableCell>
                  ) : (
                    <TableCell align="right">{integerFormat.format(row.toolFailures)}</TableCell>
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
  const [filters, setFilters] = useState<StatisticsDashboardFilters>(
    () => createDefaultStatisticsFilters(),
  );
  const [data, setData] = useState<Awaited<ReturnType<typeof statisticsService.get>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [tab, setTab] = useState<TabKey>('overview');

  const rangeError = !filters.range.from || !filters.range.to
    ? 'Choose both UTC dates.'
    : filters.range.from > filters.range.to
      ? 'The start date must be on or before the end date.'
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
          setError(requestError instanceof Error ? requestError.message : 'Statistics are unavailable.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [filters, refreshVersion, rangeError]);

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
      flowIds: 'Flow',
      plannedExecutionIds: 'Execution',
      sources: 'Source',
      statuses: 'Status',
      modelIds: 'Model',
      providerIds: 'Provider',
      credentialIds: 'Credential',
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
  }, [filters]);

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

  return (
    <Box component="main" sx={{ p: { xs: 2, md: 3 }, overflow: 'auto' }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        gap={2}
        sx={{ mb: 2 }}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography component="h1" variant="h4">Statistics</Typography>
            <Chip label="Experimental" size="small" color="secondary" variant="outlined" />
          </Stack>
          <Typography color="text.secondary">
            Aggregate, redacted execution analytics. Dates use inclusive UTC days.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={reset}
            disabled={loading && !data}
          >
            Reset
          </Button>
          <Button
            variant="contained"
            startIcon={<RefreshIcon />}
            onClick={() => setRefreshVersion((version) => version + 1)}
            disabled={loading || !!rangeError}
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      <Paper component="section" variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography component="h2" variant="h6" sx={{ mb: 1.5 }}>Shared filters</Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <TextField
            label="From (UTC)"
            type="date"
            value={filters.range.from}
            onChange={(event) => setFilters((current) => ({
              ...current,
              range: { ...current.range, from: event.target.value },
            }))}
            size="small"
            fullWidth
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': 'Statistics start date in UTC' }}
          />
          <TextField
            label="To (UTC)"
            type="date"
            value={filters.range.to}
            onChange={(event) => setFilters((current) => ({
              ...current,
              range: { ...current.range, to: event.target.value },
            }))}
            size="small"
            fullWidth
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'aria-label': 'Statistics end date in UTC' }}
          />
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-source-label">Sources</InputLabel>
            <Select
              labelId="statistics-source-label"
              multiple
              label="Sources"
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
                <MenuItem key={source} value={source}>{source}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" fullWidth>
            <InputLabel id="statistics-status-label">Statuses</InputLabel>
            <Select
              labelId="statistics-status-label"
              multiple
              label="Statuses"
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
                <MenuItem key={status} value={status}>{status}</MenuItem>
              ))}
            </Select>
          </FormControl>
          {IDENTIFIER_FILTERS.map(({ field, label }) => (
            <IdentifierFilter
              key={field}
              label={label}
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
          aria-label="Active statistics filters"
          sx={{ mt: activeFilters.length > 0 ? 2 : 1 }}
        >
          {activeFilters.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No dimension filters applied.</Typography>
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

      {loading && <LinearProgress aria-label="Refreshing statistics" sx={{ mb: 2 }} />}
      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={(
            <Button color="inherit" size="small" onClick={() => setRefreshVersion((version) => version + 1)}>
              Retry
            </Button>
          )}
        >
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <Stack alignItems="center" spacing={1.5} sx={{ py: 8 }}>
          <Spinner size="large" />
          <Typography>Loading aggregate statistics…</Typography>
        </Stack>
      ) : !data ? null : !hasData ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Typography component="h2" variant="h6">No telemetry for this selection</Typography>
          <Typography color="text.secondary" sx={{ mt: 1, maxWidth: 620, mx: 'auto' }}>
            Reliable collection begins after experimental statistics are enabled. Runs from before
            collection started are not reconstructed, and no raw conversations or credentials are
            downloaded to build this view.
          </Typography>
        </Paper>
      ) : (
        <>
          <Box
            component="section"
            aria-label="Statistics summary"
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(5, 1fr)' },
              gap: 2,
              mb: 2,
            }}
          >
            <SummaryCard
              label="Logical runs"
              value={integerFormat.format(data.summary.runs)}
              detail={`${integerFormat.format(data.summary.schedulerSkips)} scheduler skips`}
            />
            <SummaryCard
              label="Success rate"
              value={formatPercent(successRate)}
              detail={`${integerFormat.format(data.summary.successes)} completed successfully`}
            />
            <SummaryCard
              label="Tokens"
              value={compactFormat.format(data.summary.usage.totalTokens)}
              detail={`${compactFormat.format(data.summary.usage.inputTokens)} input · ${compactFormat.format(data.summary.usage.outputTokens)} output`}
            />
            <SummaryCard
              label="Run wall-clock time"
              value={formatDuration(data.summary.runDuration.totalMs)}
              detail={`P95 ${formatDuration(data.summary.runDuration.p95Ms)}`}
            />
            <SummaryCard
              label="Failed tool calls"
              value={integerFormat.format(data.summary.toolFailures)}
              detail={`${integerFormat.format(data.summary.toolCalls)} total tool calls`}
            />
          </Box>

          <Paper variant="outlined" sx={{ mb: 2 }}>
            <Tabs
              value={tab}
              onChange={(_, value: TabKey) => setTab(value)}
              variant="scrollable"
              scrollButtons="auto"
              aria-label="Statistics views"
            >
              <Tab value="overview" label="Overview" id="statistics-tab-overview" />
              <Tab value="flows" label="Flows" id="statistics-tab-flows" />
              <Tab value="executions" label="Executions" id="statistics-tab-executions" />
              <Tab value="models" label="Models" id="statistics-tab-models" />
              <Tab value="providers" label="Providers & Keys" id="statistics-tab-providers" />
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
                  title="Executions"
                  description="Logical runs by UTC day. Select a bar to drill into that day."
                  buckets={data.daily}
                  metric={(bucket) => bucket.summary.runs}
                  formatValue={(value) => integerFormat.format(value)}
                  onSelectDate={selectDate}
                />
                <TimeSeries
                  title="Tokens"
                  description="Aggregate token usage by UTC day. Select a bar to drill into that day."
                  buckets={data.daily}
                  metric={(bucket) => bucket.summary.usage.totalTokens}
                  formatValue={(value) => compactFormat.format(value)}
                  onSelectDate={selectDate}
                />
              </Box>
            )}
            {tab === 'flows' && (
              <RankingTable
                title="Flows"
                rows={data.rankings.flows}
                selectedIds={filters.flowIds ?? []}
                mode="runs"
                onSelect={selectRanking('flowIds')}
              />
            )}
            {tab === 'executions' && (
              <RankingTable
                title="Planned executions"
                rows={data.rankings.plannedExecutions}
                selectedIds={filters.plannedExecutionIds ?? []}
                mode="runs"
                onSelect={selectRanking('plannedExecutionIds')}
              />
            )}
            {tab === 'models' && (
              <Box>
                <Alert severity="info" sx={{ mb: 2 }}>
                  Summed active time is not available in the current aggregate contract. The table
                  reports summed provider-attempt wall-clock duration without inferring a new metric.
                </Alert>
                <RankingTable
                  title="Models"
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
                  Summed active time is not available in the current aggregate contract. Credential
                  values below are opaque backend-generated identifiers only.
                </Alert>
                <RankingTable
                  title="Providers"
                  rows={data.rankings.providers}
                  selectedIds={filters.providerIds ?? []}
                  mode="providers"
                  onSelect={selectRanking('providerIds')}
                />
                <RankingTable
                  title="Credentials"
                  rows={data.rankings.credentials}
                  selectedIds={filters.credentialIds ?? []}
                  mode="providers"
                  onSelect={selectRanking('credentialIds')}
                />
              </Stack>
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
