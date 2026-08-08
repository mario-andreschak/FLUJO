import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  _setStatisticsDirForTests,
  appendStatisticsEvent,
  createStatisticsEvent,
  flushStatisticsEvents,
} from '@/backend/services/statistics';
import {
  _clearStatisticsAggregateCacheForTests,
  aggregateStatistics,
  parseStatisticsRequest,
  statisticsPercentile,
} from '@/backend/services/statistics/aggregation';

describe('statistics aggregation', () => {
  let tempDir: string;
  let previousDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-statistics-aggregate-'));
    previousDir = _setStatisticsDirForTests(tempDir);
    _clearStatisticsAggregateCacheForTests();
  });

  afterEach(async () => {
    await flushStatisticsEvents();
    _setStatisticsDirForTests(previousDir);
    _clearStatisticsAggregateCacheForTests();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function seedRun(runId = 'run-1', day = '2026-07-30') {
    const common = { runId, flow: { id: 'flow-1', name: 'Flow One' } };
    await appendStatisticsEvent(createStatisticsEvent({
      ...common,
      type: 'run.started',
      timestamp: `${day}T10:00:00.000Z`,
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'model.attempt',
      runId,
      timestamp: `${day}T10:00:01.000Z`,
      model: { id: 'model-1', name: 'Model One' },
      provider: { id: 'provider-1', name: 'Provider One' },
      credentialId: 'cred_shared',
      node: { id: 'node-1', name: 'Node One' },
      attempt: 1,
      outcome: 'error',
      durationMs: 100,
      errorClass: 'rate_limit',
      usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50, cachedInputTokens: 5, contextWindow: 100 },
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'model.attempt',
      runId,
      timestamp: `${day}T10:00:02.000Z`,
      model: { id: 'model-1', name: 'Model One' },
      provider: { id: 'provider-1', name: 'Provider One' },
      credentialId: 'cred_shared',
      node: { id: 'node-1', name: 'Node One' },
      attempt: 2,
      outcome: 'completed',
      durationMs: 300,
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80, cacheWriteTokens: 7, contextWindow: 100 },
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      ...common,
      type: 'node.visit',
      timestamp: `${day}T10:00:03.000Z`,
      node: { id: 'node-1', name: 'Node One', type: 'model' },
      outcome: 'completed',
      durationMs: 450,
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'tool.invocation',
      runId,
      timestamp: `${day}T10:00:04.000Z`,
      node: { id: 'node-1', name: 'Node One' },
      tool: { id: 'tool-1', name: 'Tool One', kind: 'mcp' },
      outcome: 'error',
      durationMs: 50,
      errorClass: 'provider',
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      ...common,
      type: 'run.finished',
      timestamp: `${day}T10:00:05.000Z`,
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
      outcome: 'completed',
      durationMs: 500,
      usage: { totalTokens: 130 },
    }));
  }

  it('deduplicates logical runs while retaining retry, failure, duration, usage, and context metrics', async () => {
    await seedRun();
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'scheduler.fire',
      runId: 'queued-run-1',
      timestamp: '2026-07-30T09:59:00.000Z',
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
      outcome: 'queued',
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'scheduler.fire',
      runId: 'run-1',
      timestamp: '2026-07-30T09:59:01.000Z',
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
      outcome: 'fired',
      conversationId: 'ephemeral-conversation-1',
    }));
    await appendStatisticsEvent(createStatisticsEvent({
      type: 'scheduler.skip',
      runId: 'skip-1',
      timestamp: '2026-07-31T00:00:00.000Z',
      source: 'schedule',
      plannedExecution: { id: 'plan-1', name: 'Plan One' },
      reason: 'overlap',
    }));
    await fs.appendFile(path.join(tempDir, '2026-07-30.jsonl'), '{"truncated":', 'utf8');

    const response = await aggregateStatistics({
      range: { from: '2026-07-30', to: '2026-07-31' },
      filters: {},
    });

    expect(response.summary).toEqual(expect.objectContaining({
      runs: 1,
      successes: 1,
      schedulerSkips: 1,
      providerAttempts: 2,
      providerErrors: 1,
      nodeVisits: 1,
      toolCalls: 1,
      toolFailures: 1,
      peakContextUtilization: 0.6,
      usage: {
        inputTokens: 100,
        outputTokens: 30,
        totalTokens: 130,
        cachedInputTokens: 5,
        cacheWriteTokens: 7,
      },
    }));
    expect(response.summary.runDuration).toEqual({ count: 1, totalMs: 500, averageMs: 500, p50Ms: 500, p95Ms: 500 });
    expect(response.summary.providerDuration).toEqual({ count: 2, totalMs: 400, averageMs: 200, p50Ms: 100, p95Ms: 300 });
    expect(response.daily).toHaveLength(2);
    expect(response.rankings.models[0]).toEqual(expect.objectContaining({ id: 'model-1', runs: 1, providerAttempts: 2 }));
    expect(response.rankings.plannedExecutions[0]).toEqual(expect.objectContaining({ id: 'plan-1', runs: 1, schedulerSkips: 1 }));
    expect(response.summary.errorClasses).toEqual({ provider: 1, rate_limit: 1 });
    expect(JSON.stringify(response)).not.toMatch(/truncated|eventId|runId|errorClass|rawError/);
  });

  it('applies linked filters consistently and returns stable empty buckets and rankings', async () => {
    await seedRun();

    const matching = await aggregateStatistics({
      range: { from: '2026-07-30', to: '2026-07-31' },
      filters: { modelIds: ['model-1'], providerIds: ['provider-1'], credentialIds: ['cred_shared'] },
    });
    const empty = await aggregateStatistics({
      range: { from: '2026-07-30', to: '2026-07-31' },
      filters: { modelIds: ['missing-model'] },
    });

    expect(matching.summary.runs).toBe(1);
    expect(matching.summary.providerAttempts).toBe(2);
    expect(empty.summary.runs).toBe(0);
    expect(empty.daily.map(bucket => bucket.summary.runs)).toEqual([0, 0]);
    expect(empty.rankings).toEqual({
      flows: [], plannedExecutions: [], models: [], providers: [], credentials: [], nodes: [], tools: [],
      subflows: [], revisions: [],
    });
  });

  it('invalidates a cached response when a selected partition changes', async () => {
    const request = { range: { from: '2026-07-30', to: '2026-07-30' } } as const;
    const empty = await aggregateStatistics(request);
    await seedRun();
    const populated = await aggregateStatistics(request);

    expect(empty.summary.runs).toBe(0);
    expect(populated.summary.runs).toBe(1);
  });

  it('parses canonical filters, defaults to seven UTC days, and rejects unsafe input', () => {
    const parsed = parseStatisticsRequest(
      new URLSearchParams('providerId=p2&providerId=p1&providerId=p1'),
      new Date('2026-07-30T23:59:59.000Z'),
    );
    expect(parsed).toEqual({
      range: { from: '2026-07-24', to: '2026-07-30' },
      filters: { providerIds: ['p1', 'p2'] },
    });
    expect(() => parseStatisticsRequest(new URLSearchParams('from=2026-02-30'))).toThrow('valid UTC calendar date');
    expect(() => parseStatisticsRequest(new URLSearchParams('from=2026-01-01&to=2026-07-30'))).toThrow('limited to 90 days');
    expect(() => parseStatisticsRequest(new URLSearchParams('credentialId=sk-secret'))).toThrow('Invalid credentialId filter');
    expect(() => parseStatisticsRequest(new URLSearchParams('raw=true'))).toThrow('Unknown statistics query parameter');
  });

  it('uses deterministic nearest-rank percentiles', () => {
    expect(statisticsPercentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(statisticsPercentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(statisticsPercentile([], 0.95)).toBe(0);
  });
});
