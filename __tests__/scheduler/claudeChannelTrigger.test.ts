/**
 * Claude channel messages (`notifications/claude/channel`) as a second input for
 * the "tool server reports an event" trigger (#1401): the wire format with the
 * real SDK, the bounded hold-and-batch loop, and the shared delivery pipeline.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  parseClaudeChannelNotification,
  receiveClaudeChannelNotification,
  registerClaudeChannelHandler,
  serverDeclaresClaudeChannel,
  subscribeInboundEvents,
  type McpInboundEvent,
} from '@/backend/services/mcp/inboundEvents';
import { armClaudeChannel, type ClaudeChannelDeps } from '@/backend/services/scheduler/triggers/claudeChannel';
import {
  deliverClaudeChannelEvents,
  receiveMcpEvent,
  type McpEventDeliveryDeps,
  type McpEventScheduler,
} from '@/backend/services/scheduler/mcpEventDelivery';
import { mcpEventFingerprint } from '@/backend/services/scheduler/triggers/mcpEvent';
import { runWithWorkspace } from '@/utils/workspace';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
} from '@/shared/types/plannedExecution';

const NOW = 1_800_000_000_000;

function event(id: number | null, overrides: Partial<McpInboundEvent> = {}): McpInboundEvent {
  return {
    serverName: 'chat',
    source: 'claude-channel',
    content: `message ${id}`,
    meta: id === null ? {} : { message_id: String(id) },
    receivedAt: new Date(NOW).toISOString(),
    deliveryId: id === null ? `channel-once:${Math.random()}` : `channel:${id}`,
    ...overrides,
  };
}

describe('parseClaudeChannelNotification', () => {
  it('keeps content and identifier meta keys, like Claude Code', () => {
    const parsed = parseClaudeChannelNotification('chat', {
      content: 'build failed',
      meta: { severity: 'high', run_id: '1234', 'bad-key': 'x', count: 3 },
    }, () => NOW);
    expect(parsed).toEqual({
      serverName: 'chat',
      source: 'claude-channel',
      content: 'build failed',
      meta: { severity: 'high', run_id: '1234' },
      receivedAt: new Date(NOW).toISOString(),
      deliveryId: expect.stringMatching(/^channel-once:/),
    });
  });

  it('recognises a repeat by event_id or message_id', () => {
    expect(parseClaudeChannelNotification('chat', { content: 'a', meta: { event_id: 'e1' } })?.deliveryId).toBe('channel:e1');
    expect(parseClaudeChannelNotification('chat', { content: 'a', meta: { message_id: 'm1' } })?.deliveryId).toBe('channel:m1');
  });

  it('treats two equal messages without an id as two messages', () => {
    const first = parseClaudeChannelNotification('chat', { content: 'yes' });
    const second = parseClaudeChannelNotification('chat', { content: 'yes' });
    expect(first?.deliveryId).not.toBe(second?.deliveryId);
  });

  it.each([
    ['no params', undefined],
    ['no content', { meta: {} }],
    ['content that is not text', { content: 42 }],
    ['an oversized message', { content: 'x'.repeat(256 * 1024 + 1) }],
  ])('drops %s', (_name, params) => {
    expect(parseClaudeChannelNotification('chat', params)).toBeNull();
  });
});

describe('receiving channel messages', () => {
  const declaring = { getServerCapabilities: () => ({ experimental: { 'claude/channel': {} } }) };

  it('hands a message from a current, declaring server to listeners of that server only', () => {
    const chat = jest.fn();
    const other = jest.fn();
    const stopChat = subscribeInboundEvents('chat', chat);
    const stopOther = subscribeInboundEvents('other', other);
    receiveClaudeChannelNotification(declaring, 'chat', { params: { content: 'hi' } }, () => true);
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'chat', content: 'hi' }));
    expect(other).not.toHaveBeenCalled();
    stopChat(); stopOther();
  });

  it('ignores a replaced client and a server that never declared the channel', () => {
    const listener = jest.fn();
    const stop = subscribeInboundEvents('chat', listener);
    receiveClaudeChannelNotification(declaring, 'chat', { params: { content: 'late' } }, () => false);
    receiveClaudeChannelNotification({ getServerCapabilities: () => ({}) }, 'chat', { params: { content: 'x' } }, () => true);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  it('keeps workspaces apart', () => {
    const listener = jest.fn();
    const stop = runWithWorkspace('channel-test-a', () => subscribeInboundEvents('chat', listener));
    runWithWorkspace('channel-test-b', () => receiveClaudeChannelNotification(declaring, 'chat', { params: { content: 'b' } }, () => true));
    expect(listener).not.toHaveBeenCalled();
    runWithWorkspace('channel-test-a', () => receiveClaudeChannelNotification(declaring, 'chat', { params: { content: 'a' } }, () => true));
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('works end to end with the real MCP SDK, exactly as the channels reference sends it', async () => {
    const server = new Server(
      { name: 'webhook', version: '0.0.1' },
      { capabilities: { experimental: { 'claude/channel': {} } } },
    );
    const client = new Client({ name: 'flujo-test', version: '1.0.0' });
    registerClaudeChannelHandler(client, 'webhook', (notification) =>
      receiveClaudeChannelNotification(client, 'webhook', notification, () => true));
    const received = new Promise<McpInboundEvent>(resolve => {
      const stop = subscribeInboundEvents('webhook', (inbound) => { stop(); resolve(inbound); });
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    expect(serverDeclaresClaudeChannel(client)).toBe(true);

    await server.notification({
      method: 'notifications/claude/channel',
      params: { content: 'build failed on main', meta: { severity: 'high', run_id: '1234' } },
    });
    await expect(received).resolves.toMatchObject({
      serverName: 'webhook',
      content: 'build failed on main',
      meta: { severity: 'high', run_id: '1234' },
    });
    await client.close();
  });
});

describe('armClaudeChannel', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

  function setup(overrides: Partial<ClaudeChannelDeps> = {}) {
    let emit: (inbound: McpInboundEvent) => void = () => undefined;
    const stopListening = jest.fn();
    const deps = {
      connect: jest.fn(async () => true),
      pin: jest.fn(),
      unpin: jest.fn(),
      listen: jest.fn((listener: (inbound: McpInboundEvent) => void) => { emit = listener; return stopListening; }),
      deliver: jest.fn(async (): Promise<'accepted' | 'duplicate' | 'busy' | 'gone'> => 'accepted'),
      onError: jest.fn(),
      onSuccess: jest.fn(),
      ...overrides,
    } satisfies ClaudeChannelDeps;
    const armed = armClaudeChannel(deps);
    return { deps, armed, stopListening, emit: (inbound: McpInboundEvent) => emit(inbound) };
  }

  it('keeps the server connected and pinned while armed', async () => {
    const { deps, armed, stopListening } = setup();
    await flush();
    expect(deps.pin).toHaveBeenCalledTimes(1);
    expect(deps.connect).toHaveBeenCalledTimes(1);
    expect(deps.onSuccess).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(deps.connect).toHaveBeenCalledTimes(2);
    armed.dispose();
    await flush();
    expect(deps.unpin).toHaveBeenCalledTimes(1);
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('says so when the server does not send channel messages', async () => {
    const { deps, armed } = setup({ connect: jest.fn(async () => false) });
    await flush();
    expect(deps.onError).toHaveBeenCalledWith('This server does not send Claude channel messages');
    armed.dispose();
  });

  it('turns a burst of 100 messages in one second into a couple of runs, not a flood', async () => {
    const deliver = jest.fn<Promise<'accepted'>, [McpInboundEvent[]]>().mockResolvedValue('accepted');
    const { armed, emit } = setup({ deliver });
    for (let i = 0; i < 100; i++) {
      emit(event(i));
      await jest.advanceTimersByTimeAsync(10);
    }
    await jest.advanceTimersByTimeAsync(1_000);
    const batches = deliver.mock.calls.map(([batch]) => batch);
    expect(batches.length).toBeLessThanOrEqual(5);
    expect(batches.flat().map(inbound => inbound.deliveryId)).toEqual(Array.from({ length: 100 }, (_, i) => `channel:${i}`));
    armed.dispose();
  });

  it('retries a busy batch exactly as it was, and sends later messages after it', async () => {
    const deliver = jest.fn<Promise<'accepted' | 'busy'>, [McpInboundEvent[]]>()
      .mockResolvedValueOnce('busy')
      .mockResolvedValue('accepted');
    const { armed, emit } = setup({ deliver });
    emit(event(1));
    emit(event(2));
    await jest.advanceTimersByTimeAsync(300);
    emit(event(3));
    await jest.advanceTimersByTimeAsync(2_500);
    const ids = deliver.mock.calls.map(([batch]) => batch.map(inbound => inbound.deliveryId));
    expect(ids).toEqual([
      ['channel:1', 'channel:2'],
      ['channel:1', 'channel:2'],
      ['channel:3'],
    ]);
    armed.dispose();
  });

  it('drops a batch that waited too long, says so, and carries on', async () => {
    const deliver = jest.fn<Promise<'accepted' | 'busy'>, [McpInboundEvent[]]>().mockResolvedValue('busy');
    const { deps, armed, emit } = setup({ deliver, maxWaitMs: 10_000, retryDelaysMs: [3_000] });
    emit(event(1));
    await jest.advanceTimersByTimeAsync(15_000);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('were dropped'));
    deliver.mockResolvedValue('accepted');
    emit({ ...event(2), receivedAt: new Date(Date.now()).toISOString() });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(deliver.mock.calls.at(-1)?.[0].map(inbound => inbound.deliveryId)).toEqual(['channel:2']);
    armed.dispose();
  });

  it('holds a bounded number of messages and drops the oldest first', async () => {
    const deliver = jest.fn<Promise<'accepted' | 'busy'>, [McpInboundEvent[]]>().mockResolvedValue('busy');
    const { deps, armed, emit } = setup({ deliver, maxPending: 3, maxBatch: 1 });
    emit(event(1));
    await jest.advanceTimersByTimeAsync(300);
    for (let i = 2; i <= 6; i++) emit(event(i));
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('could not keep up'));
    deliver.mockResolvedValue('accepted');
    await jest.advanceTimersByTimeAsync(10_000);
    const sent = deliver.mock.calls.map(([batch]) => batch[0].deliveryId);
    expect(sent.filter(id => id !== 'channel:1')).toEqual(['channel:4', 'channel:5', 'channel:6']);
    armed.dispose();
  });
});

describe('deliverClaudeChannelEvents', () => {
  const trigger: McpEventTriggerConfig = { type: 'mcp-event', source: 'claude-channel', serverName: 'chat', eventName: '', secret: 's' };
  const execution = (overrides: Partial<PlannedExecution> = {}) => ({
    id: 'exec-c', name: 'Chat', prompt: 'Answer.', flowId: 'f', enabled: true, trigger, createdAt: 'c', updatedAt: 'u', ...overrides,
  } as PlannedExecution);

  function setup(current: PlannedExecution = execution()) {
    let state: PlannedExecutionState = {};
    const scheduler = {
      get: jest.fn(async () => current),
      isPaused: jest.fn(async (): Promise<boolean> => false),
      isRunning: jest.fn((): boolean => false),
      exclusiveGateFor: jest.fn((): 'queue' | 'skip' | 'error' | null => null),
      fire: jest.fn(async () => ({ status: 'completed' } as RunRecord)),
      admitPersonaFire: jest.fn(async () => ({ runId: 'run-p', completion: Promise.resolve() })),
    } satisfies McpEventScheduler;
    const deps: McpEventDeliveryDeps = {
      scheduler,
      loadState: async () => state,
      updateState: async (_id, update) => { state = update(state); },
      now: () => NOW,
    };
    return { scheduler, deps, getState: () => state };
  }

  it('starts one run for a batch, with the messages as untrusted data', async () => {
    const { scheduler, deps, getState } = setup();
    await expect(deliverClaudeChannelEvents(deps, 'exec-c', [event(1), event(2)])).resolves.toBe('accepted');
    expect(scheduler.fire).toHaveBeenCalledTimes(1);
    const payload = (scheduler.fire.mock.calls[0] as unknown[])[1] as { summary: string; context: { messages: unknown[]; channel: unknown } };
    expect(payload.summary).toBe('chat: 2 channel messages');
    expect(payload.context.channel).toEqual({ server: 'chat', delivery: 'no guarantee' });
    expect(payload.context.messages).toEqual([
      { content: 'message 1', meta: { message_id: '1' }, receivedAt: new Date(NOW).toISOString() },
      { content: 'message 2', meta: { message_id: '2' }, receivedAt: new Date(NOW).toISOString() },
    ]);
    expect(getState().seenIds).toEqual(['channel:1', 'channel:2']);
  });

  it('runs a repeated message id only once, sharing the webhook dedup', async () => {
    const { scheduler, deps } = setup();
    await deliverClaudeChannelEvents(deps, 'exec-c', [event(1)]);
    await expect(deliverClaudeChannelEvents(deps, 'exec-c', [event(1)])).resolves.toBe('duplicate');
    await deliverClaudeChannelEvents(deps, 'exec-c', [event(1), event(2)]);
    expect(scheduler.fire).toHaveBeenCalledTimes(2);
    const second = (scheduler.fire.mock.calls[1] as unknown[])[1] as { context: { messages: Array<{ content: string }> } };
    expect(second.context.messages.map(message => message.content)).toEqual(['message 2']);
  });

  it('holds the batch while busy and lets go when the automation changed', async () => {
    const busy = setup();
    busy.scheduler.isRunning.mockReturnValue(true);
    await expect(deliverClaudeChannelEvents(busy.deps, 'exec-c', [event(1)])).resolves.toBe('busy');
    expect(busy.getState().seenIds).toBeUndefined();

    const switched = setup(execution({ trigger: { ...trigger, source: 'events', eventName: 'x' } }));
    await expect(deliverClaudeChannelEvents(switched.deps, 'exec-c', [event(1)])).resolves.toBe('gone');
    const off = setup(execution({ enabled: false }));
    await expect(deliverClaudeChannelEvents(off.deps, 'exec-c', [event(1)])).resolves.toBe('gone');
  });

  it('refuses webhook deliveries for an automation that listens to channel messages', async () => {
    const { deps } = setup();
    const result = await receiveMcpEvent(deps, {
      id: 'exec-c', fingerprint: mcpEventFingerprint(trigger), webhookId: 'w', webhookTimestamp: String(NOW / 1000),
      webhookSignature: 'v1,AAAA', body: '{}',
    });
    expect(result.status).toBe(410);
  });
});
