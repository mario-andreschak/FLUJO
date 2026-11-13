import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

/**
 * Opt-in timing of one flow turn (issue #1404).
 *
 * Off unless FLUJO_TURN_TRACE_FILE names a file when the server starts. Then
 * each traced request appends one JSON line with its named spans and marks,
 * relative to the request start. scripts/flow-turn-benchmark.mjs reads it.
 * When off, every helper calls straight through: no async context, no clock
 * reads and no allocation beyond the call itself.
 */

interface TraceSpan { name: string; start: number; end: number }
interface TraceMark { name: string; at: number }
interface TurnTrace {
  label: string;
  origin: number;
  startedAt: number;
  spans: TraceSpan[];
  marks: TraceMark[];
  holders: number;
  written: boolean;
}

const traceFile = process.env.FLUJO_TURN_TRACE_FILE?.trim() || undefined;
const MAX_ENTRIES = 5_000;

declare global {
  var __flujoTurnTraceStore: AsyncLocalStorage<TurnTrace> | undefined;
}

// Several Next bundles may load this module; they must share one store.
const store = traceFile
  ? (globalThis.__flujoTurnTraceStore ??= new AsyncLocalStorage<TurnTrace>())
  : undefined;

export function isTurnTraceEnabled(): boolean {
  return store !== undefined;
}

function write(trace: TurnTrace): void {
  if (trace.written || !traceFile) return;
  trace.written = true;
  try {
    appendFileSync(traceFile, `${JSON.stringify({
      label: trace.label,
      startedAt: trace.startedAt,
      durationMs: Math.round((performance.now() - trace.origin) * 10) / 10,
      spans: trace.spans,
      marks: trace.marks,
    })}\n`);
  } catch {
    // Diagnostics never affect a turn.
  }
}

function release(trace: TurnTrace): void {
  trace.holders -= 1;
  if (trace.holders <= 0) write(trace);
}

/** Run one request inside a new trace. The trace is written when every holder released it. */
export async function withTurnTrace<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!store) return task();
  const trace: TurnTrace = {
    label, origin: performance.now(), startedAt: Date.now(), spans: [], marks: [], holders: 1, written: false,
  };
  try {
    return await store.run(trace, task);
  } finally {
    release(trace);
  }
}

/**
 * Keep the current trace open for work that outlives the request handler, such
 * as a streamed run. Returns the release function (a no-op when tracing is off).
 */
export function holdTurnTrace(): () => void {
  const trace = store?.getStore();
  if (!trace || trace.written) return () => undefined;
  trace.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release(trace);
  };
}

function record(trace: TurnTrace, name: string, start: number): void {
  if (trace.spans.length >= MAX_ENTRIES) return;
  const end = performance.now() - trace.origin;
  trace.spans.push({ name, start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10 });
}

/** Time an async step under `name`. Calls straight through when tracing is off. */
export function traceSpan<T>(name: string, task: () => Promise<T>): Promise<T> {
  const trace = store?.getStore();
  if (!trace || trace.written) return task();
  const start = performance.now() - trace.origin;
  return task().finally(() => record(trace, name, start));
}

/** Time a synchronous step under `name`. */
export function traceSpanSync<T>(name: string, task: () => T): T {
  const trace = store?.getStore();
  if (!trace || trace.written) return task();
  const start = performance.now() - trace.origin;
  try {
    return task();
  } finally {
    record(trace, name, start);
  }
}

/** Note that the turn reached a point, relative to the request start. */
export function traceMark(name: string): void {
  const trace = store?.getStore();
  if (!trace || trace.written || trace.marks.length >= MAX_ENTRIES) return;
  trace.marks.push({ name, at: Math.round((performance.now() - trace.origin) * 10) / 10 });
}
