jest.mock('node:v8', () => ({ getHeapStatistics: () => ({ heap_size_limit: 8 * 1024 ** 3, used_heap_size: 128 * 1024 ** 2 }) }));
import { runInNewContext } from 'node:vm';
import { runWithWorkspace } from '@/utils/workspace';
import * as runAdmission from '@/backend/execution/flow/runAdmission';
import { findPromptRefs } from '@/utils/shared/promptRefs';
import {
  assertSubflowLaneCount, estimateSubflowData, getSubflowPreparationDiagnostics, mapSubflowPreparation,
  preflightSubflowItems, preflightSubflowJson, preflightSubflowReferences, reserveSubflowSpawn, reserveSubflowPlan,
  resolveBoundedSubflowTokens, subflowWorkerLimit, SubflowPreparationPressureError,
  SUBFLOW_PREPARATION_LIMITS as LIMITS, withSubflowPreparationBudget,
} from '@/backend/execution/flow/subflowPreparationBudget';

const MiB = 1024 ** 2;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => {
  expect(getSubflowPreparationDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  jest.restoreAllMocks();
});

it('preflights JSON strings, escaped quotes, Unicode and nested values without decoding', () => {
  const input = JSON.stringify(['comma,bracket]', 'quote"slash\\', '😀\ud800\u0000', { values: [1, true, null] }]);
  const parse = jest.spyOn(JSON, 'parse');
  try {
    preflightSubflowItems(input, 'json-array');
    expect(parse).not.toHaveBeenCalled();
    expect(() => preflightSubflowJson('['.repeat(65) + '0' + ']'.repeat(65))).toThrow(SubflowPreparationPressureError);
    expect(() => preflightSubflowItems('[0,'.repeat(1) + '0,'.repeat(4096) + '0]', 'json-array')).toThrow(SubflowPreparationPressureError);
    expect(() => preflightSubflowJson(`{"values":[${'0,'.repeat(100_001)}0]}`)).toThrow(SubflowPreparationPressureError);
  } finally { parse.mockRestore(); }
});

it('checks text bytes and nonblank line cardinality before split allocation', () => {
  preflightSubflowItems(' \r\n\u2003\nfirst\r\nsecond\n', 'lines');
  preflightSubflowItems('x\n'.repeat(LIMITS.lanes), 'lines');
  expect(() => preflightSubflowItems('x\n'.repeat(LIMITS.lanes + 1), 'lines')).toThrow(SubflowPreparationPressureError);
  expect(() => preflightSubflowItems('x'.repeat(LIMITS.sourceBytes / 2 + 1), 'lines')).toThrow(SubflowPreparationPressureError);
  expect(() => preflightSubflowItems('\n'.repeat(LIMITS.values), 'lines')).toThrow(SubflowPreparationPressureError);
});

it('preserves forty authored jobs and refuses invalid worker requests rather than clamping', () => {
  expect(() => assertSubflowLaneCount(40)).not.toThrow();
  expect(subflowWorkerLimit(16)).toBe(16);
  for (const value of [17, Infinity, NaN, 0, 1.5]) expect(() => subflowWorkerLimit(value)).toThrow(SubflowPreparationPressureError);
});

it('accounts for JSON escapes and repeated durable aliases independently of string backing sharing', () => {
  const text = '\u0001\\"😀\ud800';
  const shared = { content: text };
  const once = estimateSubflowData(shared);
  const twice = estimateSubflowData({ first: shared, second: shared });
  expect(once.json).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(shared)));
  expect(twice.json).toBeGreaterThanOrEqual(once.json * 2);
  const getter = jest.fn(() => 'private');
  expect(() => estimateSubflowData(Object.defineProperty({}, 'value', { enumerable: true, get: getter }))).toThrow(SubflowPreparationPressureError);
  const ownKeys = jest.fn(() => []);
  expect(() => estimateSubflowData(new Proxy({}, { ownKeys }))).toThrow(SubflowPreparationPressureError);
  expect(ownKeys).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
  expect(() => estimateSubflowData(runInNewContext('({ values: ["plain foreign data"] })'))).not.toThrow();
});

it('admits the declared two-MiB history with eight tasks, and refuses a thousand duplicated inputs', async () => {
  const input = { messages: [{ role: 'user', content: 'H'.repeat(MiB) }] };
  await withSubflowPreparationBudget(async budget => {
    reserveSubflowSpawn(budget, input, 8, true);
    reserveSubflowPlan(budget, input, Array.from({ length: 8 }, () => ({ input })), 4);
    expect(getSubflowPreparationDiagnostics().reservedBytes).toBeLessThan(LIMITS.planBytes);
    expect(() => reserveSubflowSpawn(budget, input, 1000, true)).toThrow(SubflowPreparationPressureError);
  });
});

it('refuses replacement multiplication before joining and includes parallel resolver scratch', async () => {
  await withSubflowPreparationBudget(async budget => {
    const resolve = jest.fn(async () => 'X'.repeat(MiB));
    await expect(resolveBoundedSubflowTokens('${var:x}'.repeat(5), /\$\{var:[^}]+\}/g, resolve, budget))
      .rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_TOO_LARGE', status: 413 });
    expect(resolve).toHaveBeenCalledTimes(1);
    const first = budget.scratch(), second = budget.scratch();
    try {
      first.reserve(60 * MiB);
      expect(() => second.reserve(70 * MiB)).toThrow(SubflowPreparationPressureError);
    } finally { first.release(); second.release(); }
  });
});

it('holds process capacity until all already-started failed-batch resolvers drain', async () => {
  const entered = deferred(), finish = deferred();
  let active = 0, started = 0, settled = false;
  const failure = new Error('resolver failed');
  const pending = withSubflowPreparationBudget(async budget => {
    budget.reserve(80 * MiB);
    return mapSubflowPreparation(Array.from({ length: 40 }, (_, index) => index), async index => {
      active++; started++;
      if (started === 4) entered.resolve();
      try {
        if (index === 0) { await entered.promise; throw failure; }
        await finish.promise;
        return index;
      } finally { active--; }
    });
  });
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const rejected = expect(pending).rejects.toBe(failure);
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(started).toBe(4);
    expect(active).toBe(3);
    expect(settled).toBe(false);
    expect(getSubflowPreparationDiagnostics()).toMatchObject({ active: 1, reservedBytes: 80 * MiB });
  } finally { finish.resolve(); await rejected; }
});

it('shares process capacity across workspaces and releases after failure', async () => {
  await withSubflowPreparationBudget(async first => {
    first.reserve(120 * MiB);
    await runWithWorkspace('another-workspace', () => withSubflowPreparationBudget(async second => {
      second.reserve(120 * MiB);
      await expect(withSubflowPreparationBudget(async third => { third.reserve(20 * MiB); }))
        .rejects.toMatchObject({ code: 'SUBFLOW_PREPARATION_MEMORY', status: 503,
          details: { code: 'SUBFLOW_PREPARATION_MEMORY', status: 503, retryAfter: '5' } });
      expect(getSubflowPreparationDiagnostics().reservedBytes).toBe(240 * MiB);
    }));
  });
});

it('includes observed RSS and outstanding flow reservations before admitting preparation', async () => {
  const previous = process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES;
  process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = String(120 * MiB);
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 100 * MiB, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
  const permit = runAdmission.acquireFlowRunAdmission({});
  try {
    expect(runAdmission.getFlowRunAdmissionDiagnostics().reservedBytes).toBe(MiB);
    await withSubflowPreparationBudget(async budget => {
      budget.reserve(19 * MiB);
      expect(() => budget.reserve(20 * MiB)).toThrow(SubflowPreparationPressureError);
      expect(getSubflowPreparationDiagnostics().reservedBytes).toBe(19 * MiB);
      permit.release();
      expect(() => budget.reserve(20 * MiB)).not.toThrow();
    });
  } finally {
    permit.release();
    if (previous === undefined) delete process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES;
    else process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = previous;
  }
});

it('preserves canonical reference grammar and context instead of resolving token substrings', async () => {
  const text = 'email@app @current.flow.name @flows[id].created @file[C%3A%2Fx].updated ${global:@model} @current.flow[id] @flow.unknown';
  await withSubflowPreparationBudget(async budget => {
    preflightSubflowReferences(text);
    const refs = findPromptRefs(text).filter(ref => ref.kind === 'mention' || ref.kind === 'global');
    const resolve = jest.fn(async (token: string) => `[resolved:${token}]`);
    const result = await resolveBoundedSubflowTokens(text, refs, resolve, budget);
    expect(resolve.mock.calls.map(([token]) => token)).toEqual([
      '@current.flow.name', '@flows[id].created', '@file[C%3A%2Fx].updated', '${global:@model}',
    ]);
    expect(result).toContain('email@app');
    expect(result).toContain('@current.flow[id] @flow.unknown');
    expect(() => preflightSubflowReferences('@'.repeat(4097))).toThrow(SubflowPreparationPressureError);
  });
});
