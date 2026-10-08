import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Statistics from '@/frontend/components/Statistics';
import {
  StatisticsAggregateResponse,
  StatisticsSummary,
} from '@/shared/types/statistics';

const mockFetch = jest.fn();
Object.defineProperty(global, 'fetch', {
  configurable: true,
  writable: true,
  value: mockFetch,
});

const duration = {
  count: 2,
  totalMs: 3_000,
  averageMs: 1_500,
  p50Ms: 1_000,
  p95Ms: 2_000,
};

function summary(overrides: Partial<StatisticsSummary> = {}): StatisticsSummary {
  return {
    runs: 2,
    successes: 1,
    errors: 1,
    capped: 0,
    cancelled: 0,
    paused: 0,
    schedulerSkips: 1,
    providerAttempts: 3,
    providerErrors: 1,
    nodeVisits: 4,
    nodeErrors: 1,
    toolCalls: 5,
    toolFailures: 1,
    usage: {
      inputTokens: 800,
      outputTokens: 400,
      totalTokens: 1_200,
      cachedInputTokens: 100,
      cacheWriteTokens: 0,
    },
    peakContextUtilization: 0.5,
    runDuration: duration,
    providerDuration: duration,
    stepDuration: duration,
    toolDuration: duration,
    subflowCalls: 1,
    subflowFailures: 0,
    subflowIncomplete: 0,
    runsIncomplete: 0,
    subflowDuration: duration,
    subflowWaitDuration: duration,
    cache: { requests: 2, hits: 1, misses: 1, writes: 0, unknown: 1, hitRate: 0.5 },
    toolPayload: {
      request: { count: 1, totalBytes: 512, averageBytes: 512, p50Bytes: 512, p95Bytes: 512 },
      response: { count: 1, totalBytes: 2_048, averageBytes: 2_048, p50Bytes: 2_048, p95Bytes: 2_048 },
    },
    errorClasses: { provider: 1 },
    contentCategories: { json: 2 },
    phases: { provider: duration },
    ...overrides,
  };
}

function fixture(): StatisticsAggregateResponse {
  const totals = summary();
  const flow = { id: 'flow-1', name: 'Demo flow', ...totals };
  const plannedExecution = { id: 'plan-1', name: 'Nightly run', ...totals };
  const model = { id: 'model-1', name: 'Model one', ...totals };
  const provider = { id: 'provider-1', name: 'Provider one', ...totals };
  const credential = { id: 'cred_opaque123', name: 'cred_opaque123', ...totals };

  return {
    range: { from: '2026-07-24', to: '2026-07-30' },
    filters: {},
    summary: totals,
    daily: [
      { date: '2026-07-29', summary: summary({ runs: 1 }) },
      { date: '2026-07-30', summary: summary({ runs: 1 }) },
    ],
    rankings: {
      flows: [flow],
      plannedExecutions: [plannedExecution],
      models: [model],
      providers: [provider],
      credentials: [credential],
      nodes: [],
      tools: [],
      subflows: [],
      revisions: [],
    },
  };
}

function successfulResponse(body: StatisticsAggregateResponse): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

describe('Statistics dashboard', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('renders aggregate KPIs and keeps drill-down filters synchronized', async () => {
    mockFetch.mockImplementation(async () => successfulResponse(fixture()));

    render(<Statistics />);

    const summaryRegion = await screen.findByLabelText('Statistics summary');
    expect(within(summaryRegion).getByText('Logical runs')).toBeInTheDocument();
    const successRateCard = within(summaryRegion).getByLabelText('Success rate');
    const cacheHitRateCard = within(summaryRegion).getByLabelText('Cache hit rate');
    expect(successRateCard).not.toBe(cacheHitRateCard);
    expect(within(successRateCard).getByText('50%')).toBeInTheDocument();
    expect(within(cacheHitRateCard).getByText('50%')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Providers & Keys' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Flows' }));
    fireEvent.click(screen.getByText('Demo flow'));

    await waitFor(() => {
      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]?.[0] as string;
      expect(lastUrl).toContain('flowId=flow-1');
    });
    expect(screen.getByText('Flow: flow-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => {
      const lastUrl = mockFetch.mock.calls[mockFetch.mock.calls.length - 1]?.[0] as string;
      expect(lastUrl).not.toContain('flowId=flow-1');
    });
  });

  it('explains the stable no-telemetry response without implying history exists', async () => {
    const empty = fixture();
    empty.summary = summary({
      runs: 0,
      successes: 0,
      errors: 0,
      schedulerSkips: 0,
      providerAttempts: 0,
      nodeVisits: 0,
      toolCalls: 0,
      subflowCalls: 0,
    });
    empty.daily = [];
    empty.rankings = {
      flows: [],
      plannedExecutions: [],
      models: [],
      providers: [],
      credentials: [],
      nodes: [],
      tools: [],
      subflows: [],
      revisions: [],
    };
    mockFetch.mockResolvedValue(successfulResponse(empty));

    render(<Statistics />);

    expect(await screen.findByRole('heading', { name: 'No telemetry for this selection' })).toBeInTheDocument();
    expect(screen.getByText(/Reliable collection begins after experimental statistics are enabled/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Statistics summary')).not.toBeInTheDocument();
  });

  it('shows retryable API errors', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'statistics_unavailable', message: 'Not available now.' }),
    } as Response);

    render(<Statistics />);

    expect(await screen.findByText('Not available now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
