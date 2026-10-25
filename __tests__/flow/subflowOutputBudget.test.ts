import {
  assertOutputChars, outputJsonStringBytes, measureOutputData, SubflowOutputBudget,
  getSubflowOutputDiagnostics, SUBFLOW_OUTPUT_LIMITS as LIMITS, mapSubflowOutput,
  holdSubflowOutput, retainConsumedSubflowOutput, withSubflowOutputConsumption,
} from '@/backend/execution/flow/subflowOutputBudget';
import { SubflowPreparationBudget } from '@/backend/execution/flow/subflowPreparationBudget';
import { acquireFlowRunAdmission } from '@/backend/execution/flow/runAdmission';
import { runWithWorkspace } from '@/utils/workspace';

afterEach(() => {
  expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 0, reservedBytes: 0 });
  jest.restoreAllMocks();
});

it('freezes exact derived-text and invocation boundaries without allocating boundary strings', () => {
  expect(() => assertOutputChars(LIMITS.textBytes / 2)).not.toThrow();
  expect(() => assertOutputChars(LIMITS.textBytes / 2 + 1)).toThrow(/64 MiB/);
  const budget = new SubflowOutputBudget();
  try { expect(() => budget.reserve(LIMITS.invocationBytes + 1)).toThrow(/128 MiB/); }
  finally { budget.release(); }
});

it.each(['plain', '\u0000\n\r\t\b\f"\\', '𝄞🦊', '\ud800\udfff\ud800', 'é中'])('counts UTF-8 JSON escaping exactly for %j', text => {
  expect(outputJsonStringBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text)));
});

it('refuses descriptor work without calling getters, proxies, or toJSON', () => {
  const get = jest.fn(() => 'must not execute');
  expect(() => measureOutputData(Object.defineProperty({}, 'text', { enumerable: true, get }))).toThrow(/accessors/);
  const proxy = new Proxy({}, { ownKeys: get, get: get });
  expect(() => measureOutputData(proxy)).toThrow(/proxy/);
  expect(() => measureOutputData({ toJSON: get })).toThrow(/serialization hooks/);
  expect(() => measureOutputData(Object.defineProperty([], Symbol.iterator, { get }))).toThrow(/array hooks/);
  expect(get).not.toHaveBeenCalled();
  expect(() => measureOutputData(new Array(LIMITS.values + 1))).toThrow(/count/);
});

it('counts aliases per serialized occurrence and rejects derived escape amplification', () => {
  const owned = { output: '\u0000'.repeat(2_000_000) };
  const one = measureOutputData(owned);
  const two = measureOutputData([owned, owned]);
  expect(two.json).toBeGreaterThanOrEqual(one.json * 2);
  const budget = new SubflowOutputBudget();
  try { expect(() => budget.reserve(two.json * 6)).toThrow(/128 MiB/); }
  finally { budget.release(); }
  expect(owned.output).toHaveLength(2_000_000);
});

it('includes both outstanding Flow and preparation reservations in headroom checks', () => {
  const previous = process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES;
  const MiB = 1024 ** 2;
  process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = String(120 * MiB);
  jest.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 100 * MiB, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 });
  const preparation = new SubflowPreparationBudget();
  const output = new SubflowOutputBudget();
  const flow = acquireFlowRunAdmission({});
  try {
    preparation.reserve(8 * MiB);
    output.reserve(11 * MiB); // 100 observed + 8 preparation + 1 Flow + 11 output.
    expect(() => output.reserve(12 * MiB)).toThrow(/capacity is busy/);
    expect(getSubflowOutputDiagnostics().rejectedMemory).toBeGreaterThan(0);
  } finally {
    output.release(); preparation.release(); flow.release();
    if (previous === undefined) delete process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES;
    else process.env.FLUJO_RUN_ADMISSION_MAX_RSS_BYTES = previous;
  }
});

it('shares the 256 MiB process cap across workspaces and releases refused reservations', async () => {
  const first = new SubflowOutputBudget(), second = new SubflowOutputBudget(), third = new SubflowOutputBudget();
  try {
    first.reserve(120 * 1024 ** 2);
    await runWithWorkspace('other-output-workspace', async () => {
      second.reserve(120 * 1024 ** 2);
      expect(() => third.reserve(20 * 1024 ** 2)).toThrow(/capacity is busy/);
      expect(getSubflowOutputDiagnostics().reservedBytes).toBe(240 * 1024 ** 2);
    });
  } finally { third.release(); second.release(); first.release(); }
});

it('holds native/inline tool output through awaited consumption and releases on consumer failure', async () => {
  const result = {};
  await expect(withSubflowOutputConsumption(async () => {
    const budget = new SubflowOutputBudget(); budget.reserve(4096);
    holdSubflowOutput(result, budget); retainConsumedSubflowOutput(result);
    await Promise.resolve();
    expect(getSubflowOutputDiagnostics()).toMatchObject({ active: 1, reservedBytes: 4096 });
    throw new Error('consumer failed');
  })).rejects.toThrow('consumer failed');
});

it('starts at most four promotions, preserves order, and drains delayed siblings on failure', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let active = 0, peak = 0, calls = 0, settled = false;
  const failure = new Error('authority lost');
  const task = mapSubflowOutput([0, 1, 2, 3, 4, 5], async index => {
    active++; calls++; peak = Math.max(peak, active);
    try {
      if (index === 0) { await Promise.resolve(); entered(); throw failure; }
      await blocked; return index;
    } finally { active--; }
  });
  void task.then(() => { settled = true; }, () => { settled = true; });
  await started; await Promise.resolve();
  expect(settled).toBe(false); expect(peak).toBe(4); expect(calls).toBe(4);
  finish(); await expect(task).rejects.toBe(failure); expect(active).toBe(0);
  expect(await mapSubflowOutput([3, 2, 1], async value => value)).toEqual([3, 2, 1]);
});
