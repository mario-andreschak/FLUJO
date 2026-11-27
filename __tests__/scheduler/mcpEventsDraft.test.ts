/**
 * Adaptations to the current MCP events extension draft
 * (`io.modelcontextprotocol/events`, SEP-3415, Beta; #1401): capability
 * detection, verification challenge, gap and termination notices, event-id
 * dedup, resume cursor, explicit unsubscribe, one-day grants.
 */
import { createHmac } from 'crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  armMcpEvent,
  mcpEventFingerprint,
  mcpEventSubscriptionKey,
  type McpEventDeps,
} from '@/backend/services/scheduler/triggers/mcpEvent';
import {
  listMcpEvents,
  serverSupportsEvents,
  subscribeMcpEvent,
  unsubscribeMcpEvent,
} from '@/backend/services/mcp/serverEvents';
import {
  receiveMcpEvent,
  type McpEventDeliveryDeps,
  type McpEventScheduler,
} from '@/backend/services/scheduler/mcpEventDelivery';
import type {
  McpEventTriggerConfig,
  PlannedExecution,
  PlannedExecutionState,
  RunRecord,
} from '@/shared/types/plannedExecution';

const SECRET = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
const NOW = 1_800_000_000_000;
const trigger: McpEventTriggerConfig = {
  type: 'mcp-event', serverName: 'chat', eventName: 'message.received', arguments: { chat_ids: ['a'] }, secret: SECRET,
};

function sign(id: string, timestamp: number, body: string): string {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe('webhook deliveries under the current draft', () => {
  const execution = { id: 'exec-1', name: 'n', flowId: 'f', enabled: true, trigger, createdAt: 'c', updatedAt: 'u' } as PlannedExecution;

  function setup() {
    let state: PlannedExecutionState = {};
    const scheduler = {
      get: jest.fn(async () => execution),
      isPaused: jest.fn(async (): Promise<boolean> => false),
      isRunning: jest.fn((): boolean => false),
      exclusiveGateFor: jest.fn((): 'queue' | 'skip' | 'error' | null => null),
      fire: jest.fn(async () => ({ status: 'completed' } as RunRecord)),
      admitPersonaFire: jest.fn(async () => ({ runId: 'run-p', completion: Promise.resolve() })),
    } satisfies McpEventScheduler;
    const onNotice = jest.fn();
    const deps: McpEventDeliveryDeps = {
      scheduler,
      onNotice,
      loadState: async () => state,
      updateState: async (_id, update) => { state = update(state); },
      now: () => NOW,
    };
    const deliver = (webhookId: string, payload: unknown, signature?: string) => {
      const body = JSON.stringify(payload);
      return receiveMcpEvent(deps, {
        id: 'exec-1', fingerprint: mcpEventFingerprint(trigger), webhookId, webhookTimestamp: String(NOW / 1000),
        webhookSignature: signature ?? sign(webhookId, NOW / 1000, body), body,
      });
    };
    return {
      scheduler, onNotice, deliver,
      getState: () => state,
      setState: (next: PlannedExecutionState) => { state = next; },
    };
  }

  it('answers the verification challenge so the server starts delivering', async () => {
    const { scheduler, deliver } = setup();
    const result = await deliver('msg_verification_1', { type: 'verification', challenge: 'nonce-123' });
    expect(result).toEqual({ status: 200, body: { challenge: 'nonce-123' } });
    expect(scheduler.fire).not.toHaveBeenCalled();
  });

  it('only answers a challenge that carries a valid signature', async () => {
    const { deliver } = setup();
    expect((await deliver('msg_verification_2', { type: 'verification', challenge: 'n' }, 'v1,AAAA')).status).toBe(401);
  });

  it('takes a gap notice, resumes after it, and tells the user', async () => {
    const { deliver, onNotice, getState } = setup();
    expect((await deliver('msg_gap_1', { type: 'gap', cursor: 'c-90' })).status).toBe(200);
    expect(getState().eventCursor).toBe('c-90');
    expect(onNotice).toHaveBeenCalledWith('exec-1', expect.stringContaining('skipped'));
  });

  it('takes a termination notice and tells the user', async () => {
    const { deliver, onNotice } = setup();
    const result = await deliver('msg_terminated_1', { type: 'terminated', error: { code: -32024, message: 'revoked' } });
    expect(result.status).toBe(200);
    expect(onNotice).toHaveBeenCalledWith('exec-1', expect.stringContaining('ended the subscription'));
  });

  it('refuses an unknown control message', async () => {
    const { deliver } = setup();
    expect((await deliver('msg_x_1', { type: 'surprise' })).status).toBe(400);
  });

  it('recognises the same event sent again in a new message', async () => {
    const { scheduler, deliver } = setup();
    const event = { eventId: 'evt_A', name: 'message.received', timestamp: 't', data: {}, cursor: 'c-1' };
    expect((await deliver('wh_1', event)).status).toBe(202);
    const replay = await deliver('wh_2', event);
    expect(replay.body.duplicate).toBe(true);
    expect(scheduler.fire).toHaveBeenCalledTimes(1);
  });

  it('still recognises a message remembered by its webhook id before this change', async () => {
    const { scheduler, deliver, setState } = setup();
    setState({ seenIds: ['wh_old'] });
    const result = await deliver('wh_old', { eventId: 'evt_new', name: 'message.received', data: {} });
    expect(result.body.duplicate).toBe(true);
    expect(scheduler.fire).not.toHaveBeenCalled();
  });

  it('saves the cursor of an accepted event, and only then', async () => {
    const { scheduler, deliver, getState } = setup();
    scheduler.isRunning.mockReturnValue(true);
    await deliver('wh_1', { eventId: 'evt_1', name: 'message.received', data: {}, cursor: 'c-1' });
    expect(getState().eventCursor).toBeUndefined();
    scheduler.isRunning.mockReturnValue(false);
    await deliver('wh_1', { eventId: 'evt_1', name: 'message.received', data: {}, cursor: 'c-1' });
    expect(getState().eventCursor).toBe('c-1');
  });
});

describe('retiring an event subscription', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  function deps() {
    return {
      subscribe: jest.fn(async (_ttlMs: number) => ({ refreshBefore: null })),
      unsubscribe: jest.fn(async () => undefined),
      pin: jest.fn(), unpin: jest.fn(), onError: jest.fn(), onSuccess: jest.fn(),
    } satisfies McpEventDeps;
  }

  it('ends the subscription when the automation goes away for good', async () => {
    const d = deps();
    const armed = armMcpEvent(d);
    await flush();
    armed.retire!();
    await flush();
    expect(d.unsubscribe).toHaveBeenCalledTimes(1);
    expect(d.unpin).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(d.subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps the subscription on a plain dispose (pause, shutdown, re-arm)', async () => {
    const d = deps();
    const armed = armMcpEvent(d);
    await flush();
    armed.dispose();
    await flush();
    expect(d.unsubscribe).not.toHaveBeenCalled();
  });

  it('asks for at most a one-day grant', async () => {
    const d = deps();
    const armed = armMcpEvent(d);
    await flush();
    expect(d.subscribe).toHaveBeenCalledWith(86_400_000);
    armed.dispose();
  });

  it('knows which changes need a new subscription', () => {
    expect(mcpEventSubscriptionKey(trigger)).toBe(mcpEventSubscriptionKey({ ...trigger, steerConversationId: 'c1' }));
    expect(mcpEventSubscriptionKey(trigger)).not.toBe(mcpEventSubscriptionKey({ ...trigger, arguments: { chat_ids: ['b'] } }));
    expect(mcpEventSubscriptionKey({ ...trigger, source: 'claude-channel' })).toBeNull();
    expect(mcpEventSubscriptionKey({ type: 'webhook', token: 't' })).toBeNull();
  });
});

describe('events extension requests', () => {
  function fakeClient(capabilities: unknown, responses: unknown[] = []) {
    const request = jest.fn(async (..._args: unknown[]): Promise<never> => (responses.shift() ?? {}) as never);
    const fake: Pick<Client, 'request' | 'getServerCapabilities'> = {
      request,
      getServerCapabilities: () => capabilities as ReturnType<Client['getServerCapabilities']>,
    };
    // Only these two methods are used by the code under test.
    return { client: fake as Client, request };
  }
  const sent = (request: jest.Mock, index = 0) =>
    request.mock.calls[index][0] as { method: string; params: Record<string, unknown> };
  // Requests other than events/list first look up the event once, for the routing headers.
  const sentTo = (request: jest.Mock, method: string) =>
    request.mock.calls.map(([body]) => body as { method: string; params: Record<string, unknown> }).find(body => body.method === method)!;

  it.each([
    ['the current extensions key', { extensions: { 'io.modelcontextprotocol/events': {} } }, true],
    ['an earlier draft (top level)', { events: {} }, true],
    ['an earlier draft (experimental)', { experimental: { events: {} } }, true],
    ['no events at all', { tools: {} }, false],
  ])('detects support from %s', (_name, capabilities, expected) => {
    expect(serverSupportsEvents(fakeClient(capabilities).client)).toBe(expected);
  });

  it('subscribes with the saved cursor and declares itself as an events client', async () => {
    const { client, request } = fakeClient({}, [{ events: [] }, { id: 's1', refreshBefore: null }]);
    await subscribeMcpEvent(client, { name: 'message.received', url: 'http://127.0.0.1/x', secret: SECRET, ttlMs: 1, cursor: 'c-7' });
    expect(sentTo(request, 'events/subscribe')).toMatchObject({
      method: 'events/subscribe',
      params: {
        name: 'message.received',
        cursor: 'c-7',
        delivery: { mode: 'webhook', url: 'http://127.0.0.1/x', secret: SECRET },
        _meta: { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/events': {} } } },
      },
    });
  });

  it('starts from now when nothing was accepted yet', async () => {
    const { client, request } = fakeClient({}, [{ events: [] }, { id: 's1', refreshBefore: null }]);
    await subscribeMcpEvent(client, { name: 'message.received', url: 'http://127.0.0.1/x', secret: SECRET });
    expect(sentTo(request, 'events/subscribe').params.cursor).toBeNull();
  });

  it('reads every page of the event list', async () => {
    const { client, request } = fakeClient({}, [
      { events: [{ name: 'a' }], nextCursor: 'p2' },
      { events: [{ name: 'b' }] },
    ]);
    await expect(listMcpEvents(client)).resolves.toEqual([{ name: 'a' }, { name: 'b' }]);
    expect(sent(request, 1).params.cursor).toBe('p2');
  });

  it('unsubscribes by name, arguments and URL', async () => {
    const { client, request } = fakeClient({}, [{ events: [] }, {}]);
    await unsubscribeMcpEvent(client, { name: 'message.received', arguments: { chat_ids: ['a'] }, url: 'http://127.0.0.1/x' });
    expect(sentTo(request, 'events/unsubscribe')).toMatchObject({
      method: 'events/unsubscribe',
      params: { name: 'message.received', arguments: { chat_ids: ['a'] }, delivery: { url: 'http://127.0.0.1/x' } },
    });
  });
});
