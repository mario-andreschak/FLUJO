import type { RawExecutionEvent } from '@/shared/types/execution/events';
let workspace = 'one';
const sequences = new Map<string, number>();
const appendMock = jest.fn();
jest.mock('@/utils/workspace', () => ({
  getCurrentWorkspace: () => workspace,
  workspaceCacheKey: (id: string) => `${workspace}\u0000${id}`,
  bindToCurrentWorkspace: (callback: unknown) => callback,
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendFromBus: (event: unknown) => appendMock(event),
  allocateSeq: (id: string) => { const key = `${workspace}\u0000${id}`; const seq = sequences.get(key) ?? 0; sequences.set(key, seq + 1); return seq; },
}));
import { ExecutionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { eventJsonFits, snapshotEventPayload } from '@/backend/execution/flow/engine/eventPayload';

const delta = (text = 'x'.repeat(300)): RawExecutionEvent => ({ type: 'model:delta', messageId: 'draft', delta: text });
beforeEach(() => { workspace = 'one'; sequences.clear(); appendMock.mockClear(); });

it('caps aggregate bytes across conversations and workspace firehoses', () => {
  const bus = new ExecutionEventBus({ maxEventWireBytes: 1024, maxConversationBytes: 2048, maxWorkspaceBytes: 3072, maxTotalBytes: 4096, maxChannels: 4, maxWorkspaces: 2 });
  for (let index = 0; index < 80; index++) {
    workspace = String(index % 3);
    bus.emit(`private-conversation-${index}`, delta());
    expect(bus.diagnostics().retainedBytes).toBeLessThanOrEqual(4096);
    expect(bus.diagnostics().channels).toBeLessThanOrEqual(4);
    expect(bus.diagnostics().workspaces).toBeLessThanOrEqual(2);
  }
  expect(bus.diagnostics().evictedEntries).toBeGreaterThan(0);
  expect(JSON.stringify(bus.diagnostics())).not.toContain('private-conversation');
  expect(appendMock).toHaveBeenCalledTimes(80);
});

it('retains immutable JSON instead of a mutable transcript/tool/media graph', () => {
  const bus = new ExecutionEventBus();
  const message = { id: 'm', role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,original' } }] };
  const raw = { type: 'message', message } as RawExecutionEvent;
  const event = bus.emit('immutable', raw);
  message.content[0].image_url.url = 'mutated';
  const first = bus.getBufferedSince('immutable', 0);
  expect(JSON.stringify(first)).toContain('base64,original');
  (first[0] as { timestamp: number }).timestamp = 0;
  expect(bus.getBufferedSince('immutable', 0)[0].timestamp).toBe(event.timestamp);
  expect(appendMock).toHaveBeenCalledWith(event);
});

it('omits an oversized projection while preserving the canonical event and explicit gap floor', () => {
  const bus = new ExecutionEventBus({ maxEventWireBytes: 512 });
  bus.emit('gap', delta('small'));
  const oversized = bus.emit('gap', delta('large'.repeat(1000)));
  bus.emit('gap', delta('after'));
  expect(bus.getBufferedSince('gap', 0).map(event => event.seq)).toEqual([0, 2]);
  expect(bus.replayWindow('gap')).toEqual({ firstSeq: 2, nextSeq: 3 });
  expect(bus.globalReplayWindow()).toMatchObject({ firstSeq: 2, nextSeq: 3 });
  expect(appendMock).toHaveBeenCalledWith(oversized);
  expect(bus.diagnostics().droppedOversized).toBe(1);
});

it('keeps the legacy event-count ceilings as well as byte ceilings', () => {
  const bus = new ExecutionEventBus({ maxConversationEvents: 2, maxWorkspaceEvents: 3 });
  for (let index = 0; index < 8; index++) bus.emit('count', delta('tiny'));
  expect(bus.getBufferedSince('count', 0).map(event => event.seq)).toEqual([6, 7]);
  expect(bus.getGlobalBufferedSince(0).map(entry => entry.globalSeq)).toEqual([5, 6, 7]);
});

it('does not evict subscribed channels to manufacture capacity', () => {
  const bus = new ExecutionEventBus({ maxChannels: 1 });
  const listener = jest.fn();
  const unsubscribe = bus.subscribe('owned', listener);
  try {
    bus.emit('other', delta());
    expect(() => bus.subscribe('other', jest.fn())).toThrow('capacity');
    bus.emit('owned', delta('still owned'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(appendMock).toHaveBeenCalledTimes(2);
    expect(bus.diagnostics().channels).toBe(1);
  } finally { unsubscribe(); }
});

it('caps workspace metadata without removing subscribed firehoses', () => {
  const bus = new ExecutionEventBus({ maxWorkspaces: 1 });
  const unsubscribe = bus.subscribeGlobal(jest.fn());
  const firstEpoch = bus.globalReplayWindow().epoch;
  workspace = 'two';
  bus.emit('other-workspace', delta());
  expect(() => bus.subscribeGlobal(jest.fn())).toThrow('capacity');
  expect(bus.diagnostics().workspaces).toBe(1);
  workspace = 'one';
  unsubscribe();
  workspace = 'two';
  expect(bus.globalReplayWindow().epoch).not.toBe(firstEpoch);
  workspace = 'one';
  expect(bus.globalReplayWindow().epoch).not.toBe(firstEpoch);
});

it('reschedules terminal cleanup when the final listener disconnects', () => {
  jest.useFakeTimers();
  try {
    const bus = new ExecutionEventBus({ channelTtlMs: 5 });
    const unsubscribe = bus.subscribe('done', jest.fn());
    bus.emit('done', { type: 'run:done', status: 'completed' });
    jest.advanceTimersByTime(6);
    expect(bus.diagnostics().channels).toBe(1);
    unsubscribe();
    jest.advanceTimersByTime(6);
    expect(bus.diagnostics().channels).toBe(0);
    expect(bus.getBufferedSince('done', 0)).toEqual([]);
  } finally { jest.useRealTimers(); }
});

it('preflights large strings, cycles, accessors, toJSON and opaque instances without invoking them', () => {
  const getter = jest.fn(() => 'hidden');
  const toJSON = jest.fn(() => ({ huge: 'x'.repeat(10000) }));
  const object = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  const custom = Object.defineProperty({}, 'toJSON', { value: toJSON });
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const value of [{ text: 'x'.repeat(100000) }, object, custom, cyclic, new Date(), Array(100001)]) {
    expect(snapshotEventPayload(value, 512)).toBeUndefined();
  }
  expect(getter).not.toHaveBeenCalled();
  expect(toJSON).not.toHaveBeenCalled();
});

it('accounts UTF-8, JSON escapes and unpaired surrogates before serializing', () => {
  const event = { text: '😀é\u0000\n"\\\ud800' };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  expect(eventJsonFits(event, bytes - 1)).toBe(false);
  const snapshot = snapshotEventPayload(event, bytes + 8)!;
  expect(snapshot.wireBytes).toBe(bytes);
  expect(snapshot.retainedBytes).toBeGreaterThanOrEqual(snapshot.json.length * 2);
  expect(Object.isFrozen(snapshot)).toBe(true);
});
