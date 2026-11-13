/**
 * Opt-in flow-turn timing (issue #1404). Off by default: every helper must call
 * straight through. On (FLUJO_TURN_TRACE_FILE at module load): spans and marks
 * of one request are written as one JSON line, after the last holder (such as a
 * streamed background run) released the trace.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type TurnTraceModule = typeof import('@/backend/execution/flow/turnTrace');

function loadWithTraceFile(file: string | undefined): TurnTraceModule {
  const previous = process.env.FLUJO_TURN_TRACE_FILE;
  if (file === undefined) delete process.env.FLUJO_TURN_TRACE_FILE;
  else process.env.FLUJO_TURN_TRACE_FILE = file;
  let loaded!: TurnTraceModule;
  try {
    jest.isolateModules(() => { loaded = require('@/backend/execution/flow/turnTrace'); });
  } finally {
    if (previous === undefined) delete process.env.FLUJO_TURN_TRACE_FILE;
    else process.env.FLUJO_TURN_TRACE_FILE = previous;
    delete globalThis.__flujoTurnTraceStore;
  }
  return loaded;
}

describe('turnTrace', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(path.join(os.tmpdir(), 'flujo-turn-trace-')); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('is a pure pass-through when no trace file is configured', async () => {
    const trace = loadWithTraceFile(undefined);
    expect(trace.isTurnTraceEnabled()).toBe(false);
    const pending = Promise.resolve(42);
    // The very same promise comes back: no wrapper, no extra tick.
    expect(trace.traceSpan('step', () => pending)).toBe(pending);
    expect(trace.traceSpanSync('sync', () => 'value')).toBe('value');
    expect(() => trace.traceMark('mark')).not.toThrow();
    expect(trace.holdTurnTrace()).toEqual(expect.any(Function));
    await expect(trace.withTurnTrace('request', async () => 'done')).resolves.toBe('done');
    const rejection = new Error('kept');
    await expect(trace.traceSpan('fails', () => Promise.reject(rejection))).rejects.toBe(rejection);
  });

  it('writes one line per request with spans, marks and outlived holders', async () => {
    const file = path.join(directory, 'trace.jsonl');
    const trace = loadWithTraceFile(file);
    expect(trace.isTurnTraceEnabled()).toBe(true);

    let release!: () => void;
    const result = await trace.withTurnTrace('chat.completions', async () => {
      trace.traceMark('route.handler');
      await trace.traceSpan('persist.snapshot', async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      trace.traceSpanSync('sync.step', () => undefined);
      await expect(trace.traceSpan('fails', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      // A streamed run keeps the trace open after the handler returned.
      release = trace.holdTurnTrace();
      return 'response';
    });
    expect(result).toBe('response');
    expect(existsSync(file)).toBe(false);

    await trace.withTurnTrace('chat.completions', async () => undefined); // an unrelated request
    const background = trace.traceSpan('late.write', async () => undefined);
    await background; // outside any trace: not recorded
    release();
    release(); // idempotent

    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(2);
    const turn = lines.find(line => line.spans.length > 0)!;
    expect(turn.label).toBe('chat.completions');
    expect(turn.marks).toEqual([{ name: 'route.handler', at: expect.any(Number) }]);
    expect(turn.spans.map((span: { name: string }) => span.name)).toEqual(['persist.snapshot', 'sync.step', 'fails']);
    const persist = turn.spans[0];
    expect(persist.end - persist.start).toBeGreaterThanOrEqual(3);
  });
});
