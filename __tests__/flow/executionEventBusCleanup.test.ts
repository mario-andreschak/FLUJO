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
const ttl = 5 * 60 * 1000;
const start: RawExecutionEvent = { type: 'run:start', flowId: 'flow-cleanup' };
const done: RawExecutionEvent = { type: 'run:done', status: 'completed' };
let bus: Bus;
let setWorkspace: (workspace: string) => void;
let appendFromBus: jest.Mock;
const globalBus = globalThis as unknown as { __flujoExecutionEventBus?: Bus };
// Empty channels have no public sequence or events to inspect. Observe only
// registry presence for that case, without adding a production test-only API.
const channelCount = () => (bus as unknown as { channels: Map<string, unknown> }).channels.size;

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

it('releases a terminal channel after its last subscriber outlives the original timer', () => {
  const unsubscribe = bus.subscribe('terminal', jest.fn());
  const event = bus.emit('terminal', done);
  jest.advanceTimersByTime(ttl * 2);
  expect(bus.getBufferedSince('terminal', 0)).toEqual([event]);
  unsubscribe();
  jest.advanceTimersByTime(ttl - 1);
  expect(bus.currentSeq('terminal')).toBe(1);
  jest.advanceTimersByTime(1);
  expect(bus.getBufferedSince('terminal', 0)).toEqual([]);
  expect(bus.currentSeq('terminal')).toBe(0);
  expect(channelCount()).toBe(0);
  expect(appendFromBus).toHaveBeenCalledTimes(1);
  expect(appendFromBus).toHaveBeenCalledWith(event);
});

it('waits for the final subscriber and preserves delivery to the remaining listener', () => {
  const first = bus.subscribe('two-listeners', jest.fn());
  const listener = jest.fn();
  const second = bus.subscribe('two-listeners', listener);
  const event = bus.emit('two-listeners', done);
  first();
  jest.advanceTimersByTime(ttl * 2);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalledWith(event);
  expect(bus.currentSeq('two-listeners')).toBe(1);
  second();
  jest.advanceTimersByTime(ttl);
  expect(bus.currentSeq('two-listeners')).toBe(0);
});

it('makes unsubscribe idempotent without extending the cleanup deadline', () => {
  const unsubscribe = bus.subscribe('idempotent', jest.fn());
  bus.emit('idempotent', done);
  unsubscribe();
  jest.advanceTimersByTime(ttl - 1);
  unsubscribe();
  jest.advanceTimersByTime(1);
  expect(bus.currentSeq('idempotent')).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

it('cleans an empty channel after its only subscriber disconnects', () => {
  const unsubscribe = bus.subscribe('never-emitted', jest.fn());
  expect(channelCount()).toBe(1);
  unsubscribe();
  jest.advanceTimersByTime(ttl);
  expect(channelCount()).toBe(0);
  expect(appendFromBus).not.toHaveBeenCalled();
});

it('retains a running channel without listeners', () => {
  const unsubscribe = bus.subscribe('running', jest.fn());
  const event = bus.emit('running', start);
  unsubscribe();
  jest.advanceTimersByTime(ttl * 3);
  expect(bus.getBufferedSince('running', 0)).toEqual([event]);
  expect(bus.currentSeq('running')).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
});

it.each<RawExecutionEvent>([
  { type: 'run:paused', reason: 'debug' },
  { type: 'run:awaiting_approval', pendingToolCalls: [] },
])('retains a $type channel without listeners', raw => {
  const unsubscribe = bus.subscribe('paused', jest.fn());
  bus.emit('paused', start);
  const event = bus.emit('paused', raw);
  unsubscribe();
  jest.advanceTimersByTime(ttl * 3);
  expect(bus.getBufferedSince('paused', 1)).toEqual([event]);
  expect(bus.currentSeq('paused')).toBe(2);
  expect(jest.getTimerCount()).toBe(0);
});

it('revokes terminal cleanup when a conversation resumes before its deadline', () => {
  const unsubscribe = bus.subscribe('resumed', jest.fn());
  bus.emit('resumed', done);
  unsubscribe();
  jest.advanceTimersByTime(ttl - 1);
  const resumed = bus.emit('resumed', start);
  jest.advanceTimersByTime(ttl * 3);
  expect(bus.getBufferedSince('resumed', 1)).toEqual([resumed]);
  expect(bus.currentSeq('resumed')).toBe(2);
  expect(jest.getTimerCount()).toBe(0);
});

it('uses the captured workspace when a deferred unsubscribe runs in another context', () => {
  const unsubscribe = bus.subscribe('same-id', jest.fn());
  bus.emit('same-id', done);
  jest.advanceTimersByTime(ttl);
  setWorkspace('beta');
  const beta = bus.emit('same-id', start);
  unsubscribe();
  jest.advanceTimersByTime(ttl);
  expect(bus.getBufferedSince('same-id', 0)).toEqual([beta]);
  setWorkspace('alpha');
  expect(bus.currentSeq('same-id')).toBe(0);
  expect(channelCount()).toBe(1);
});

it('preserves a run resumed synchronously by a terminal listener', () => {
  const unsubscribe = bus.subscribe('nested-resume', event => {
    if (event.type === 'run:done') bus.emit('nested-resume', start);
  });
  bus.emit('nested-resume', done);
  unsubscribe();
  jest.advanceTimersByTime(ttl * 3);
  expect(bus.currentSeq('nested-resume')).toBe(2);
  expect(bus.getBufferedSince('nested-resume', 1)).toMatchObject([{ type: 'run:start', seq: 1 }]);
});

it('keeps a terminal cleanup armed when an earlier event listener finishes the run', () => {
  const unsubscribe = bus.subscribe('nested-done', event => {
    if (event.type !== 'run:start') return;
    bus.emit('nested-done', done);
    unsubscribe();
  });
  bus.emit('nested-done', start);
  jest.advanceTimersByTime(ttl);
  expect(bus.currentSeq('nested-done')).toBe(0);
  expect(channelCount()).toBe(0);
});

it('retains a reconnected terminal channel until that subscriber leaves', () => {
  bus.emit('reconnected', done);
  jest.advanceTimersByTime(ttl - 1);
  const unsubscribe = bus.subscribe('reconnected', jest.fn());
  jest.advanceTimersByTime(ttl * 2);
  expect(bus.currentSeq('reconnected')).toBe(1);
  unsubscribe();
  jest.advanceTimersByTime(ttl);
  expect(bus.currentSeq('reconnected')).toBe(0);
});

it('keeps the authoritative sequence allocation and append tap after channel eviction', () => {
  const first = bus.emit('sequence', done);
  jest.advanceTimersByTime(ttl);
  expect(bus.currentSeq('sequence')).toBe(0);
  const second = bus.emit('sequence', start);
  expect(first.seq).toBe(0);
  expect(second.seq).toBe(1);
  expect(appendFromBus.mock.calls.map(args => args[0] as ExecutionEvent)).toEqual([first, second]);
});
