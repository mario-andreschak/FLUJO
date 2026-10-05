import type { ExecutionEvent, RawExecutionEvent } from '@/shared/types/execution/events';

jest.mock('@/utils/workspace', () => {
  const actual = jest.requireActual('@/utils/workspace');
  let workspace = 'alpha';
  return {
    ...actual,
    getCurrentWorkspace: () => workspace,
    workspaceCacheKey: (...parts: string[]) => [workspace, ...parts].join('\0'),
    bindToCurrentWorkspace: <T extends (...args: never[]) => unknown>(fn: T): T => fn,
    setWorkspace: (value: string) => { workspace = value; },
  };
});
jest.mock('@/backend/execution/flow/conversationLog', () => {
  const sequences = new Map<string, number>();
  return {
    allocateSeq: jest.fn((id: string) => {
      const { workspaceCacheKey } = jest.requireMock('@/utils/workspace');
      const key = workspaceCacheKey(id);
      const next = sequences.get(key) ?? 0;
      sequences.set(key, next + 1);
      return next;
    }),
    appendFromBus: jest.fn(),
  };
});
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

type Bus = typeof import('@/backend/execution/flow/engine/ExecutionEventBus').executionEventBus;
const workspaceBudget = 4 * 1024 * 1024;
const processBudget = 16 * 1024 * 1024;
const ttl = 5 * 60 * 1000;
const globalBus = globalThis as unknown as { __flujoExecutionEventBus?: Bus };
let bus: Bus;
let setWorkspace: (workspace: string) => void;
let appendFromBus: jest.Mock;
const delta = (value: string): RawExecutionEvent => ({ type: 'model:delta', messageId: 'draft', delta: value });
const retainedBytes = () => bus.getGlobalBufferedSince(0)
  .reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);

beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  delete globalBus.__flujoExecutionEventBus;
  ({ executionEventBus: bus } = jest.requireActual('@/backend/execution/flow/engine/ExecutionEventBus'));
  ({ setWorkspace } = jest.requireMock('@/utils/workspace'));
  ({ appendFromBus } = jest.requireMock('@/backend/execution/flow/conversationLog'));
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete globalBus.__flujoExecutionEventBus;
});

it('bounds a single oversized global replay payload after terminal channel cleanup', () => {
  const listener = jest.fn();
  bus.subscribeGlobal(listener);
  const large = bus.emit('terminal-large', delta('x'.repeat(workspaceBudget + 1)));
  const done = bus.emit('terminal-large', { type: 'run:done', status: 'completed' });
  jest.advanceTimersByTime(ttl);
  expect(bus.getBufferedSince('terminal-large', 0)).toEqual([]);
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0)).toEqual([{ globalSeq: 1, event: done }]);
  expect(bus.currentGlobalSeq()).toBe(2);
  expect(listener.mock.calls[0][0].event).toBe(large);
  expect(listener.mock.calls[1][0].event).toBe(done);
  expect(appendFromBus.mock.calls.map(args => args[0])).toEqual([large, done]);
});

it('bounds global replay bytes below the old event-count limit and keeps a contiguous suffix', () => {
  for (let index = 0; index < 8; index++) {
    bus.emit('medium', delta(`${index}:${'x'.repeat(700 * 1024)}`));
  }
  const cached = bus.getGlobalBufferedSince(0);
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(cached.length).toBeGreaterThan(0);
  expect(cached.length).toBeLessThan(8);
  expect(cached.map(entry => entry.globalSeq)).toEqual(
    Array.from({ length: cached.length }, (_, index) => 8 - cached.length + index),
  );
  expect(bus.currentGlobalSeq()).toBe(8);
  expect(bus.getGlobalBufferedSince(7).map(entry => entry.globalSeq)).toEqual([7]);
  // This slice does not clip per-conversation/fast-completion replay.
  expect(bus.getBufferedSince('medium', 0)).toHaveLength(8);
});

it('bounds UTF-8 and escaped payload bytes rather than JS string length', () => {
  const content = '漢🙂\u0000'.repeat(180_000);
  bus.emit('unicode', delta(content));
  bus.emit('unicode', delta(content));
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0).map(entry => entry.globalSeq)).toEqual([1]);
  const cached = bus.getGlobalBufferedSince(0)[0].event;
  expect(cached.type === 'model:delta' && cached.delta === content).toBe(true);
});

it('preserves the existing 5000-entry count cap and monotonic replay cursor', () => {
  for (let index = 0; index <= 5000; index++) {
    bus.emit('count-limit', { type: 'run:start', flowId: 'small' });
  }
  const cached = bus.getGlobalBufferedSince(0);
  expect(cached).toHaveLength(5000);
  expect(cached[0].globalSeq).toBe(1);
  expect(cached[4999].globalSeq).toBe(5000);
  expect(bus.currentGlobalSeq()).toBe(5001);
  expect(bus.getGlobalBufferedSince(5000).map(entry => entry.globalSeq)).toEqual([5000]);
});

it('detaches global snapshots so a producer mutation cannot regrow cached payloads', () => {
  const message = { id: 'mutable', role: 'assistant' as const, content: 'small' };
  const event = bus.emit('mutated', { type: 'message', message });
  message.content = 'x'.repeat(workspaceBudget + 1);
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0)[0].event).toMatchObject({ message: { content: 'small' } });
  // Publisher/log/per-conversation objects retain their original semantics.
  expect(appendFromBus).toHaveBeenCalledWith(event);
  expect(bus.getBufferedSince('mutated', 0)[0]).toBe(event);
});

it('detaches returned global replay values from later readers', () => {
  bus.emit('reader-mutation', delta('small'));
  const first = bus.getGlobalBufferedSince(0)[0].event;
  if (first.type !== 'model:delta') throw new Error('Expected delta fixture');
  first.delta = 'x'.repeat(workspaceBudget + 1);
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0)[0].event).toMatchObject({ delta: 'small' });
});

it('detaches caches from getter values without invoking new publisher callbacks', () => {
  let content = 'small';
  let reads = 0;
  const message = {
    id: 'getter', role: 'assistant' as const,
    get content() { reads++; return content; },
  };
  bus.emit('getter', { type: 'message', message });
  content = 'x'.repeat(workspaceBudget + 1);
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0)).toEqual([]);
  expect(reads).toBe(0);
});

it('bounds aggregate global replay bytes across independently named workspaces', () => {
  const workspaces = Array.from({ length: 18 }, (_, index) => `space-${index}`);
  for (const workspace of workspaces) {
    setWorkspace(workspace);
    bus.emit('same-id', delta(`${workspace}:${'x'.repeat(1024 * 1024)}`));
    expect(bus.currentGlobalSeq()).toBe(1);
  }
  let allBytes = 0;
  for (const workspace of workspaces) {
    setWorkspace(workspace);
    allBytes += retainedBytes();
    expect(bus.currentGlobalSeq()).toBe(1);
    expect(bus.currentSeq('same-id')).toBe(1);
    expect(bus.getBufferedSince('same-id', 0)).toHaveLength(1);
  }
  expect(allBytes).toBeLessThanOrEqual(processBudget);
  setWorkspace('space-0');
  expect(bus.getGlobalBufferedSince(0)).toEqual([]);
  setWorkspace('space-17');
  expect(bus.getGlobalBufferedSince(0)).toHaveLength(1);
});

it('releases aggregate eviction storage while preserving an empty workspace high-water mark', () => {
  const internals = bus as unknown as {
    firehoses: Map<string, { buffer: unknown[] }>;
    globalReplayEntries: Map<unknown, { buffer: unknown[] }>;
  };
  bus.emit('first', delta('x'.repeat(1024 * 1024)));
  const formerBuffer = internals.firehoses.get('alpha')!.buffer;
  for (let index = 0; index < 18; index++) {
    setWorkspace(`later-${index}`);
    bus.emit('later', delta('y'.repeat(1024 * 1024)));
  }
  setWorkspace('alpha');
  expect(bus.getGlobalBufferedSince(0)).toEqual([]);
  expect(bus.currentGlobalSeq()).toBe(1);
  expect(bus.getGlobalReplayPressure().workspaceUtf8Bytes).toBe(0);
  const emptyWorkspace = internals.firehoses.get('alpha')!;
  expect(emptyWorkspace.buffer).toEqual([]);
  expect(emptyWorkspace.buffer).not.toBe(formerBuffer);
  expect([...internals.globalReplayEntries.values()]).not.toContain(emptyWorkspace);
  const resumed = bus.emit('first', delta('small'));
  expect(bus.getGlobalBufferedSince(0)).toEqual([{ globalSeq: 1, event: resumed }]);
  expect(bus.currentGlobalSeq()).toBe(2);
});

it('resets an oversized workspace suffix without discarding another workspace replay', () => {
  bus.emit('same-id', delta('alpha'));
  setWorkspace('beta');
  const beta = bus.emit('same-id', delta('beta'));
  setWorkspace('alpha');
  bus.emit('same-id', delta('x'.repeat(workspaceBudget + 1)));
  expect(retainedBytes()).toBeLessThanOrEqual(workspaceBudget);
  expect(bus.getGlobalBufferedSince(0)).toEqual([]);
  expect(bus.currentGlobalSeq()).toBe(2);
  setWorkspace('beta');
  expect(bus.getGlobalBufferedSince(0)).toEqual([{ globalSeq: 0, event: beta }]);
  expect(bus.currentGlobalSeq()).toBe(1);
});

it('resets an uncacheable suffix but preserves live delivery and authoritative allocation', () => {
  const listener = jest.fn();
  bus.subscribeGlobal(listener);
  bus.emit('cycle', delta('before'));
  const message: Record<string, unknown> = { id: 'cycle', role: 'assistant' };
  message.content = message;
  const uncacheable = bus.emit('cycle', { type: 'message', message } as unknown as RawExecutionEvent);
  expect(bus.getGlobalBufferedSince(0)).toEqual([]);
  const after = bus.emit('cycle', delta('after'));
  expect(bus.getGlobalBufferedSince(0)).toEqual([{ globalSeq: 2, event: after }]);
  expect(bus.currentGlobalSeq()).toBe(3);
  expect(bus.currentSeq('cycle')).toBe(3);
  expect(listener.mock.calls[1][0].event).toBe(uncacheable);
  expect(appendFromBus.mock.calls.map(args => (args[0] as ExecutionEvent).seq)).toEqual([0, 1, 2]);
});

it.each<RawExecutionEvent>([
  { type: 'run:paused', reason: 'debug' },
  { type: 'run:awaiting_approval', pendingToolCalls: [] },
])('retains per-conversation $type ownership after global byte pressure', raw => {
  const unsubscribe = bus.subscribe('paused-large', jest.fn());
  bus.emit('paused-large', { type: 'run:start', flowId: 'f' });
  bus.emit('paused-large', delta('x'.repeat(workspaceBudget + 1)));
  const paused = bus.emit('paused-large', raw);
  unsubscribe();
  jest.advanceTimersByTime(ttl * 3);
  expect(bus.getBufferedSince('paused-large', 0)).toHaveLength(3);
  expect(bus.getBufferedSince('paused-large', 2)).toEqual([paused]);
  expect(bus.currentSeq('paused-large')).toBe(3);
  expect(jest.getTimerCount()).toBe(0);
});

it('preserves nested global publication ids, append order and live event objects', () => {
  const received: number[] = [];
  bus.subscribeGlobal(entry => {
    received.push(entry.globalSeq);
    if (entry.globalSeq === 0) bus.emit('nested', delta('inner'));
  });
  const outer = bus.emit('nested', delta('outer'));
  expect(received).toEqual([0, 1]);
  expect(bus.getGlobalBufferedSince(0).map(entry => [entry.globalSeq, entry.event.seq])).toEqual([[0, 0], [1, 1]]);
  expect(appendFromBus.mock.calls.map(args => (args[0] as ExecutionEvent).seq)).toEqual([0, 1]);
  expect(appendFromBus.mock.calls[0][0]).toBe(outer);
});

it('reports cached serialized bytes without creating a cache or claiming heap/RSS', () => {
  expect(bus.getGlobalReplayPressure()).toEqual({
    workspaceUtf8Bytes: 0, processUtf8Bytes: 0, cachedEvents: 0, cachedWorkspaces: 0,
    maxWorkspaceUtf8Bytes: workspaceBudget, maxProcessUtf8Bytes: processBudget,
  });
  const before = bus.getGlobalReplayPressure();
  bus.emit('small', delta('small'));
  expect(bus.getGlobalReplayPressure()).toMatchObject({
    workspaceUtf8Bytes: retainedBytes(), processUtf8Bytes: retainedBytes(), cachedEvents: 1, cachedWorkspaces: 1,
  });
  expect(before.cachedEvents).toBe(0);
});
