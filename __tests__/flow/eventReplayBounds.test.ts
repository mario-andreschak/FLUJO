import { ExecutionEventBus, CONVERSATION_REPLAY_LIMITS } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { appendFromBus } from '@/backend/execution/flow/conversationLog';
import type { RawExecutionEvent } from '@/shared/types/execution/events';

jest.mock('@/utils/workspace', () => {
  let workspace = 'alpha';
  return { getCurrentWorkspace: () => workspace, workspaceCacheKey: (id: string) => workspace + '\0' + id,
    bindToCurrentWorkspace: (fn: unknown) => fn, setWorkspace: (value: string) => { workspace = value; } };
});
jest.mock('@/backend/execution/flow/conversationLog', () => {
  const sequences = new Map<string, number>();
  return { appendFromBus: jest.fn(), allocateSeq: (id: string) => {
    const key = jest.requireMock('@/utils/workspace').workspaceCacheKey(id);
    const seq = sequences.get(key) ?? 0; sequences.set(key, seq + 1); return seq;
  }, resetSequences: () => sequences.clear() };
});
const delta = (text: string): RawExecutionEvent => ({ type: 'model:delta', delta: text, messageId: 'draft' });
const setWorkspace = (value: string) => jest.requireMock('@/utils/workspace').setWorkspace(value);
let bus: ExecutionEventBus;
beforeEach(() => {
  jest.useFakeTimers(); setWorkspace('alpha');
  jest.requireMock('@/backend/execution/flow/conversationLog').resetSequences();
  jest.mocked(appendFromBus).mockClear(); bus = new ExecutionEventBus();
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

it('bounds per-conversation UTF-8 bytes while preserving a monotonic available suffix', () => {
  for (let index = 0; index < 8; index++) bus.emit('c', delta('漢🙂'.repeat(100_000)));
  const buffered = bus.getBufferedSince('c', 0);
  expect(buffered.length).toBeGreaterThan(0);
  expect(buffered.length).toBeLessThan(8);
  expect(buffered.reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0))
    .toBeLessThanOrEqual(CONVERSATION_REPLAY_LIMITS.maxConversationUtf8Bytes);
  expect(buffered.map(event => event.seq)).toEqual(Array.from({ length: buffered.length }, (_, index) => 8 - buffered.length + index));
  expect(bus.replayWindow('c')).toEqual({ firstSeq: buffered[0].seq, nextSeq: 8 });
});

it('detaches both producer and reader mutations while live delivery and persistence retain identity', () => {
  const listener = jest.fn(); bus.subscribe('c', listener);
  const message = { id: 'answer', role: 'assistant' as const, content: 'small', timestamp: 1 };
  const event = bus.emit('c', { type: 'message', message });
  message.content = 'x'.repeat(5 * 1024 * 1024);
  const first = bus.getBufferedSince('c', 0)[0];
  expect(first).toMatchObject({ message: { content: 'small' } });
  if (first.type === 'message') first.message.content = 'reader mutation';
  expect(bus.getBufferedSince('c', 0)[0]).toMatchObject({ message: { content: 'small' } });
  expect(listener).toHaveBeenCalledWith(event);
  expect(listener.mock.calls[0][0]).toBe(event);
  expect(appendFromBus).toHaveBeenCalledWith(event);
});

it('drops an uncacheable prefix without dropping live events or resetting authoritative seq', () => {
  bus.emit('c', delta('before'));
  const listener = jest.fn(); bus.subscribe('c', listener);
  const huge = bus.emit('c', delta('x'.repeat(CONVERSATION_REPLAY_LIMITS.maxConversationUtf8Bytes + 1)));
  expect(bus.replayWindow('c')).toEqual({ firstSeq: 2, nextSeq: 2 });
  const after = bus.emit('c', delta('after'));
  expect(bus.getBufferedSince('c', 0)).toEqual([after]);
  expect(listener.mock.calls[0][0]).toBe(huge);
  expect(appendFromBus).toHaveBeenCalledWith(huge);
  expect(after.seq).toBe(2);
});

it('bounds the combined process ledger across conversation and global caches', () => {
  for (let index = 0; index < 20; index++) {
    setWorkspace('workspace-' + index); bus.emit('c', delta('x'.repeat(1024 * 1024)));
    expect(bus.getConversationReplayPressure().processUtf8Bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(bus.getGlobalReplayPressure().processUtf8Bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(bus.getReplayPressure().processUtf8Bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(bus.getReplayPressure().workspaceUtf8Bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  }
  let actualBytes = 0;
  for (let index = 0; index < 20; index++) {
    setWorkspace('workspace-' + index);
    const conversationBytes = bus.getBufferedSince('c', 0).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
    const globalBytes = bus.getGlobalBufferedSince(0).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
    expect(bus.getReplayPressure().workspaceUtf8Bytes).toBe(conversationBytes + globalBytes);
    actualBytes += conversationBytes + globalBytes;
  }
  expect(actualBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(bus.getReplayPressure().processUtf8Bytes).toBe(actualBytes);
  setWorkspace('workspace-0'); expect(bus.getBufferedSince('c', 0)).toEqual([]);
  setWorkspace('workspace-19'); expect(bus.getBufferedSince('c', 0)).toHaveLength(1);
});

it('bounds channel metadata but never evicts a currently subscribed channel', () => {
  const listener = jest.fn(); const release = bus.subscribe('active', listener);
  for (let index = 0; index < 1100; index++) bus.emit('idle-' + index, delta('small'));
  expect(bus.getConversationReplayPressure().channels).toBe(CONVERSATION_REPLAY_LIMITS.maxChannels);
  const value = bus.emit('active', delta('live'));
  expect(listener.mock.calls[0][0]).toBe(value);
  const conversationBytes = Array.from({ length: 1100 }, (_, index) => bus.getBufferedSince('idle-' + index, 0))
    .flat().concat(bus.getBufferedSince('active', 0)).reduce((bytes, event) => bytes + Buffer.byteLength(JSON.stringify(event)), 0);
  const globalBytes = bus.getGlobalBufferedSince(0).reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry)), 0);
  expect(bus.getReplayPressure().processUtf8Bytes).toBe(conversationBytes + globalBytes);
  release();
});

it('preserves authoritative publication when every channel metadata slot has a listener', () => {
  const releases = Array.from({ length: CONVERSATION_REPLAY_LIMITS.maxChannels }, (_, index) => bus.subscribe('active-' + index, jest.fn()));
  expect(bus.ensureConversationProjection('overflow')).toBe(false);
  const value = bus.emit('overflow', delta('canonical'));
  expect(appendFromBus).toHaveBeenCalledWith(value);
  expect(value.seq).toBe(0);
  expect(bus.getGlobalBufferedSince(0)[0].event).toEqual(value);
  expect(bus.getBufferedSince('overflow', 0)).toEqual([]);
  releases.forEach(release => release());
});

it('caps workspace metadata and changes the epoch when an inactive projection is recreated', () => {
  const epoch = bus.globalReplayWindow().epoch;
  for (let index = 0; index < CONVERSATION_REPLAY_LIMITS.maxWorkspaces; index++) {
    setWorkspace('space-' + index); bus.emit('c', delta('small'));
  }
  expect(bus.getConversationReplayPressure().workspaces).toBe(CONVERSATION_REPLAY_LIMITS.maxWorkspaces);
  setWorkspace('alpha'); expect(bus.globalReplayWindow().epoch).not.toBe(epoch);
});

it('releases terminal cache bytes at idle cleanup while a paused channel keeps its high-water mark', () => {
  bus.emit('terminal', delta('small')); bus.emit('terminal', { type: 'run:done', status: 'completed' });
  bus.emit('paused', { type: 'run:paused', reason: 'debug' });
  jest.advanceTimersByTime(5 * 60 * 1000);
  expect(bus.getBufferedSince('terminal', 0)).toEqual([]);
  expect(bus.getConversationReplayPressure().channels).toBe(1);
  expect(bus.currentSeq('paused')).toBe(1);
  expect(bus.getConversationReplayPressure().processUtf8Bytes).toBe(Buffer.byteLength(JSON.stringify(bus.getBufferedSince('paused', 0)[0])));
  expect(bus.getReplayPressure().processUtf8Bytes).toBe(bus.getConversationReplayPressure().processUtf8Bytes + bus.getGlobalReplayPressure().processUtf8Bytes);
});

it('charges both stored strings to a shared workspace cap below either individual cap', () => {
  bus.emit('c', delta('x'.repeat(3 * 1024 * 1024)));
  const conversationBytes = bus.getBufferedSince('c', 0).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
  const globalBytes = bus.getGlobalBufferedSince(0).reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)), 0);
  expect(globalBytes).toBeGreaterThan(3 * 1024 * 1024);
  expect(conversationBytes + globalBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(bus.getReplayPressure()).toMatchObject({ workspaceUtf8Bytes: conversationBytes + globalBytes, processUtf8Bytes: conversationBytes + globalBytes });
  expect(bus.currentSeq('c')).toBe(1);
});

it('never reserves beyond either shared cap even at the insertion boundary', () => {
  const entries = (bus as unknown as { replayEntries: Map<{ json: string }, { workspace: string }> }).replayEntries;
  const original = entries.set.bind(entries);
  let peak = 0;
  const set = jest.spyOn(entries, 'set').mockImplementation((entry, owner) => {
    const result = original(entry, owner);
    let processBytes = 0; let workspaceBytes = 0;
    for (const [value, retainedOwner] of entries) {
      const bytes = Buffer.byteLength(value.json);
      processBytes += bytes;
      if (retainedOwner.workspace === owner.workspace) workspaceBytes += bytes;
    }
    expect(workspaceBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(processBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    peak = Math.max(peak, processBytes);
    return result;
  });
  try {
    for (let index = 0; index < 20; index++) {
      setWorkspace('space-' + index); bus.emit('c', delta('x'.repeat(1024 * 1024)));
    }
    expect(peak).toBeGreaterThan(15 * 1024 * 1024);
  } finally { set.mockRestore(); }
});

it('releases shared reservations after an uncacheable event while preserving its live and log identity', () => {
  const listener = jest.fn(); bus.subscribe('c', listener);
  bus.emit('c', delta('before'));
  const cycle: Record<string, unknown> = { id: 'cycle', role: 'assistant' }; cycle.content = cycle;
  const value = bus.emit('c', { type: 'message', message: cycle } as unknown as RawExecutionEvent);
  expect(bus.getReplayPressure()).toMatchObject({ workspaceUtf8Bytes: 0, processUtf8Bytes: 0, cachedEntries: 0, cachedWorkspaces: 0 });
  expect(listener.mock.calls[1][0]).toBe(value);
  expect(appendFromBus).toHaveBeenCalledWith(value);
  bus.emit('c', delta('after'));
  const actual = Buffer.byteLength(JSON.stringify(bus.getBufferedSince('c', 0)[0])) + Buffer.byteLength(JSON.stringify(bus.getGlobalBufferedSince(0)[0]));
  expect(bus.getReplayPressure().processUtf8Bytes).toBe(actual);
  expect(bus.getReplayPressure().cachedEntries).toBe(2);
});
