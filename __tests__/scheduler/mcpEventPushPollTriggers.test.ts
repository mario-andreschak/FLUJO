/**
 * Push and poll delivery for the "tool server reports an event" trigger
 * (#1401, #1448 "Push events"): cursors, batching, holding while busy,
 * replay instead of dropping, reconnects, and the shared delivery pipeline.
 */
import type { McpEventOccurrence, McpEventPollResult } from '@/backend/services/mcp/serverEvents';
import type {
  McpEventStream,
  McpEventStreamEnd,
  McpEventStreamHandlers,
} from '@/backend/services/mcp/serverEventStream';
import { armMcpEventStream, type McpEventStreamDeps } from '@/backend/services/scheduler/triggers/mcpEventStream';
import { armMcpEventPoll, type McpEventPollDeps } from '@/backend/services/scheduler/triggers/mcpEventPoll';
import { mcpEventFingerprint, mcpEventSubscriptionKey } from '@/backend/services/scheduler/triggers/mcpEvent';
import {
  deliverMcpEventOccurrences,
  receiveMcpEvent,
  resumeCursor,
  type McpEventDeliveryDeps,
  type McpEventScheduler,
} from '@/backend/services/scheduler/mcpEventDelivery';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
  TriggerFirePayload,
} from '@/shared/types/plannedExecution';

const NOW = 1_800_000_000_000;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

const occurrence = (n: number, cursor: string | null = `pos-${n}`): McpEventOccurrence => ({
  eventId: `evt-${n}`, name: 'message.received', timestamp: '2026-11-27T10:00:00Z', data: { n }, cursor,
});

function fakeStream() {
  let finish!: (end: McpEventStreamEnd) => void;
  const ended = new Promise<McpEventStreamEnd>(resolve => { finish = resolve; });
  const stream: McpEventStream & { finish: typeof finish } = {
    ended,
    close: jest.fn(() => finish({ kind: 'closed' })),
    finish,
  };
  return stream;
}

describe('armMcpEventStream', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  function setup(overrides: Partial<McpEventStreamDeps> = {}) {
    const opened: Array<{ cursor: string | null; handlers: McpEventStreamHandlers; stream: ReturnType<typeof fakeStream> }> = [];
    let saved: string | null = 'pos-saved';
    const deps = {
      open: jest.fn(async (cursor: string | null, handlers: McpEventStreamHandlers) => {
        const stream = fakeStream();
        opened.push({ cursor, handlers, stream });
        handlers.onActive({ cursor: 'pos-active', truncated: false, heartbeatMs: 10_000 });
        return stream;
      }),
      loadCursor: jest.fn(async () => saved),
      saveCursor: jest.fn(async (cursor: string) => { saved = cursor; }),
      deliver: jest.fn(async (): Promise<'accepted' | 'duplicate' | 'busy' | 'gone'> => 'accepted'),
      pin: jest.fn(),
      unpin: jest.fn(),
      onError: jest.fn(),
      onSuccess: jest.fn(),
      random: () => 0,
      ...overrides,
    } satisfies McpEventStreamDeps;
    const armed = armMcpEventStream(deps);
    return { deps, armed, opened, getSaved: () => saved };
  }

  it('pins the server, resumes from the saved cursor and saves the confirmed position while idle', async () => {
    const { deps, opened, armed } = setup();
    await flush();
    expect(deps.pin).toHaveBeenCalled();
    expect(opened[0].cursor).toBe('pos-saved');
    expect(deps.saveCursor).toHaveBeenCalledWith('pos-active');
    expect(deps.onSuccess).toHaveBeenCalled();
    armed.dispose();
    expect(opened[0].stream.close).toHaveBeenCalled();
    expect(deps.unpin).toHaveBeenCalled();
  });

  it('turns a burst into a couple of runs and saves heartbeat positions only when nothing waits', async () => {
    const deliver = jest.fn(async (_batch: McpEventOccurrence[]) => 'accepted' as const);
    const { deps, opened } = setup({ deliver });
    await flush();
    const { handlers } = opened[0];
    for (let i = 1; i <= 100; i++) handlers.onEvent(occurrence(i));
    handlers.onHeartbeat('pos-hb-busy');
    expect(deps.saveCursor).not.toHaveBeenCalledWith('pos-hb-busy');
    await jest.advanceTimersByTimeAsync(300);
    await flush();
    expect(deliver.mock.calls.length).toBe(2);
    expect(deliver.mock.calls.flatMap(([batch]) => batch).map(event => event.eventId)).toHaveLength(100);
    handlers.onHeartbeat('pos-hb-idle');
    expect(deps.saveCursor).toHaveBeenCalledWith('pos-hb-idle');
  });

  it('holds a busy batch and delivers it again exactly as it was', async () => {
    const deliver = jest.fn<Promise<'accepted' | 'busy'>, [McpEventOccurrence[]]>()
      .mockResolvedValueOnce('busy')
      .mockResolvedValue('accepted');
    const { opened } = setup({ deliver });
    await flush();
    opened[0].handlers.onEvent(occurrence(1));
    await jest.advanceTimersByTimeAsync(300);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][0]).toBe(deliver.mock.calls[0][0]);
  });

  it('when full and the server can replay, stops reading and reconnects from the saved cursor once the queue is empty', async () => {
    let release!: () => void;
    const deliver = jest.fn(() => new Promise<'accepted'>((resolve) => { release = () => resolve('accepted'); }));
    const { opened, deps } = setup({ deliver, maxPending: 3, maxBatch: 1 });
    await flush();
    const first = opened[0];
    first.handlers.onEvent(occurrence(1));
    await jest.advanceTimersByTimeAsync(300);
    for (let i = 2; i <= 5; i++) first.handlers.onEvent(occurrence(i));
    expect(first.stream.close).toHaveBeenCalled();
    expect(deps.onError).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
    release();
    await flush();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveLength(2);
    // The batch that was in flight was accepted; events after it come again.
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('without replay, drops the oldest waiting events and says so', async () => {
    const deliver = jest.fn(() => new Promise<'accepted'>(() => undefined));
    const open = jest.fn(async (_cursor: string | null, handlers: McpEventStreamHandlers) => {
      handlers.onActive({ cursor: null, truncated: false });
      return fakeStream();
    });
    const { deps } = setup({ deliver, open, maxPending: 2, maxBatch: 1 });
    await flush();
    const [, handlers] = open.mock.calls[0];
    handlers.onEvent(occurrence(1, null));
    await jest.advanceTimersByTimeAsync(300);
    for (let i = 2; i <= 5; i++) handlers.onEvent(occurrence(i, null));
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('dropped'));
    expect(deps.saveCursor).not.toHaveBeenCalled();
  });

  it('reconnects after three quiet heartbeats, and after a lost connection with a note', async () => {
    const { opened, deps } = setup();
    await flush();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(opened[0].stream.close).toHaveBeenCalled();
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('went quiet'));
    await jest.advanceTimersByTimeAsync(10);
    expect(opened).toHaveLength(2);

    opened[1].stream.finish({ kind: 'failed', message: 'Connection closed' });
    await flush();
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('Connection closed'));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(opened).toHaveLength(3);
    expect(deps.onSuccess).toHaveBeenCalledTimes(3);
  });

  it('keeps trying with growing waits when the server refuses, and heals on success', async () => {
    const open = jest.fn()
      .mockRejectedValueOnce(new Error('MCP error -32023: NotFound'))
      .mockRejectedValueOnce(new Error('MCP error -32023: NotFound'))
      .mockImplementation(async (_cursor: string | null, handlers: McpEventStreamHandlers) => {
        handlers.onActive({ cursor: 'pos-1', truncated: false });
        return fakeStream();
      });
    const { deps } = setup({ open });
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('MCP error -32023: NotFound');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(open).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(open).toHaveBeenCalledTimes(3);
    expect(deps.onSuccess).toHaveBeenCalled();
  });

  it('shows a skipped-events note when the server reports a gap', async () => {
    const open = jest.fn(async (_cursor: string | null, handlers: McpEventStreamHandlers) => {
      handlers.onActive({ cursor: 'pos-new', truncated: true });
      return fakeStream();
    });
    const { deps } = setup({ open });
    await flush();
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('skipped some events'));
    expect(deps.saveCursor).toHaveBeenCalledWith('pos-new');
  });
});

describe('armMcpEventPoll', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  const result = (overrides: Partial<McpEventPollResult> = {}): McpEventPollResult => ({
    events: [], malformed: 0, cursor: 'pos-0', truncated: false, hasMore: false, nextPollMs: 5_000, ...overrides,
  });

  function setup(polls: McpEventPollResult[], overrides: Partial<McpEventPollDeps> = {}) {
    let saved: string | null = null;
    const deps = {
      poll: jest.fn(async () => polls.shift() ?? result({ cursor: saved })),
      loadCursor: jest.fn(async () => saved),
      saveCursor: jest.fn(async (cursor: string) => { saved = cursor; }),
      deliver: jest.fn(async (): Promise<'accepted' | 'duplicate' | 'busy' | 'gone'> => 'accepted'),
      pin: jest.fn(),
      unpin: jest.fn(),
      onError: jest.fn(),
      onSuccess: jest.fn(),
      ...overrides,
    } satisfies McpEventPollDeps;
    const armed = armMcpEventPoll(deps);
    return { deps, armed };
  }

  it('starts from now, then delivers each batch and saves the cursor only after it was accepted', async () => {
    const { deps, armed } = setup([
      result({ cursor: 'pos-0' }),
      result({ events: [occurrence(1), occurrence(2)], cursor: 'pos-2' }),
    ]);
    await flush();
    expect(deps.pin).toHaveBeenCalled();
    expect(deps.poll).toHaveBeenNthCalledWith(1, null);
    expect(deps.saveCursor).toHaveBeenCalledWith('pos-0');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(deps.poll).toHaveBeenNthCalledWith(2, 'pos-0');
    expect(deps.deliver).toHaveBeenCalledWith([occurrence(1), occurrence(2)]);
    expect(deps.saveCursor).toHaveBeenLastCalledWith('pos-2');
    armed.dispose();
    expect(deps.unpin).toHaveBeenCalled();
  });

  it('keeps a busy batch without polling further, then carries on', async () => {
    const deliver = jest.fn<Promise<'accepted' | 'busy'>, [McpEventOccurrence[]]>()
      .mockResolvedValueOnce('busy')
      .mockResolvedValueOnce('busy')
      .mockResolvedValue('accepted');
    const { deps } = setup([result({ events: [occurrence(1)], cursor: 'pos-1' })], { deliver });
    await flush();
    expect(deps.saveCursor).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deps.poll).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deps.saveCursor).toHaveBeenCalledWith('pos-1');
    expect(deps.poll).toHaveBeenLastCalledWith('pos-1');
  });

  it('drains a backlog at once but never polls faster than once a second otherwise', async () => {
    const { deps } = setup([
      result({ events: [occurrence(1)], cursor: 'pos-1', hasMore: true }),
      result({ events: [occurrence(2)], cursor: 'pos-2', hasMore: false, nextPollMs: 10 }),
      result({ events: [], cursor: 'pos-2', hasMore: true, nextPollMs: 0 }),
    ]);
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.poll).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(999);
    expect(deps.poll).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(deps.poll).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(999);
    expect(deps.poll).toHaveBeenCalledTimes(3);
  });

  it('notes a gap and unreadable events, and retries a failing server', async () => {
    const poll = jest.fn()
      .mockResolvedValueOnce(result({ truncated: true, malformed: 2, cursor: 'pos-9' }))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(result({ cursor: 'pos-9' }));
    const { deps } = setup([], { poll });
    await flush();
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('skipped some events'));
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('2 event(s)'));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(deps.onError).toHaveBeenCalledWith('connection refused');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(poll).toHaveBeenCalledTimes(3);
  });
});

describe('push and poll events reach runs through the shared pipeline', () => {
  const trigger: McpEventTriggerConfig = {
    type: 'mcp-event', serverName: 'chat', eventName: 'message.received', arguments: { chat: 'a' }, secret: 'whsec_x', delivery: 'push',
  };
  const execution = { id: 'exec-1', name: 'n', flowId: 'f', enabled: true, trigger, createdAt: 'c', updatedAt: 'u' } as PlannedExecution;

  function setup(current: PlannedExecution = execution) {
    let state: PlannedExecutionState = {};
    const fired: TriggerFirePayload[] = [];
    const scheduler = {
      get: jest.fn(async () => current),
      isPaused: jest.fn(async (): Promise<boolean> => false),
      isRunning: jest.fn((): boolean => false),
      exclusiveGateFor: jest.fn((): 'queue' | 'skip' | 'error' | null => null),
      fire: jest.fn(async (_execution: PlannedExecution, payload: TriggerFirePayload) => { fired.push(payload); return { status: 'completed' } as RunRecord; }),
      admitPersonaFire: jest.fn(async () => ({ runId: 'run-p', completion: Promise.resolve() })),
    } satisfies McpEventScheduler;
    const deps: McpEventDeliveryDeps = {
      scheduler,
      loadState: async () => state,
      updateState: async (_id, update) => { state = update(state); },
      now: () => NOW,
    };
    return { deps, scheduler, fired, getState: () => state };
  }

  it('starts one run per batch with the events as untrusted data, and saves the cursor for this subscription', async () => {
    const { deps, fired, getState } = setup();
    await expect(deliverMcpEventOccurrences(deps, 'exec-1', 'push', [occurrence(1)])).resolves.toBe('accepted');
    expect(fired[0]).toMatchObject({ kind: 'mcp-event', summary: 'chat: message.received', context: { event: { eventId: 'evt-1', data: { n: 1 } } } });
    await expect(deliverMcpEventOccurrences(deps, 'exec-1', 'push', [occurrence(1), occurrence(2), occurrence(3)])).resolves.toBe('accepted');
    expect(fired[1]).toMatchObject({ summary: 'chat: 2 message.received events', context: { events: [{ eventId: 'evt-2' }, { eventId: 'evt-3' }] } });
    expect(getState()).toMatchObject({ seenIds: ['evt-1', 'evt-2', 'evt-3'], eventCursor: 'pos-3', eventCursorFor: mcpEventFingerprint(trigger) });
    await expect(deliverMcpEventOccurrences(deps, 'exec-1', 'push', [occurrence(3)])).resolves.toBe('duplicate');
    expect(fired).toHaveLength(2);
  });

  it('says busy while a run is going and gone for an automation that changed mode', async () => {
    const busy = setup();
    busy.scheduler.isRunning.mockReturnValue(true);
    await expect(deliverMcpEventOccurrences(busy.deps, 'exec-1', 'push', [occurrence(1)])).resolves.toBe('busy');
    expect(busy.getState().seenIds).toBeUndefined();

    const changed = setup();
    await expect(deliverMcpEventOccurrences(changed.deps, 'exec-1', 'poll', [occurrence(1)])).resolves.toBe('gone');
  });

  it('refuses webhook deliveries for a push automation and holds no webhook subscription for it', async () => {
    const { deps } = setup();
    const result = await receiveMcpEvent(deps, {
      id: 'exec-1', fingerprint: mcpEventFingerprint(trigger), webhookId: 'w', webhookTimestamp: String(NOW / 1000), webhookSignature: 'v1,x', body: '{}',
    });
    expect(result.status).toBe(410);
    expect(mcpEventSubscriptionKey(trigger)).toBeNull();
    expect(mcpEventSubscriptionKey({ ...trigger, delivery: 'webhook' })).toBe(mcpEventFingerprint(trigger));
    expect(mcpEventSubscriptionKey({ ...trigger, delivery: undefined })).toBe(mcpEventFingerprint(trigger));
  });

  it('never resumes from a cursor that belongs to another subscription', () => {
    expect(resumeCursor({ eventCursor: 'pos-1', eventCursorFor: mcpEventFingerprint(trigger) }, trigger)).toBe('pos-1');
    expect(resumeCursor({ eventCursor: 'pos-1', eventCursorFor: 'other' }, trigger)).toBeNull();
    expect(resumeCursor({ eventCursor: 'pos-1' }, trigger)).toBe('pos-1');
    expect(resumeCursor({}, trigger)).toBeNull();
  });
});
