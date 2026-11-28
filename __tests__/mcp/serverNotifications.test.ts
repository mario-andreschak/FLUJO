/**
 * The handlers for messages an MCP server sends on its own
 * (`serverNotifications.ts`, #661): every kind of message reaches its handler
 * on a classic client and on a newer-protocol client, and a replaced client's
 * late messages change nothing.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  newerClientNotifications,
  registerServerNotifications,
  type ServerNotificationsHost,
} from '@/backend/services/mcp/serverNotifications';
import { CLAUDE_CHANNEL_METHOD, subscribeInboundEvents, type McpInboundEvent } from '@/backend/services/mcp/inboundEvents';
import { MCP_EVENT_NOTIFICATIONS, openMcpEventStream } from '@/backend/services/mcp/serverEventStream';
import { cachedMcpList } from '@/backend/services/mcp/listCache';

const SERVER = 'notify-test';
const SUB = 'io.modelcontextprotocol/subscriptionId';

type Schema = { safeParse(value: unknown): { success: boolean; data?: unknown } };
type Handler = (notification: unknown) => unknown;
type Deliver = (method: string, params?: unknown) => void;

/**
 * A client that is never connected. It keeps the handlers it is given and
 * hands a message to every handler whose schema accepts it, as the SDK does.
 * It serves only the `events/stream` request.
 */
function fakeClient() {
  const handlers: Array<{ schema: Schema; handler: Handler }> = [];
  let streamRequested: () => void = () => undefined;
  const streamOpening = new Promise<void>((resolve) => { streamRequested = resolve; });
  const client = Object.assign(new Client({ name: 'flujo-test', version: '1.0.0' }), {
    setNotificationHandler: (schema: Schema, handler: Handler) => { handlers.push({ schema, handler }); },
    getServerCapabilities: () => ({ tools: { listChanged: true }, experimental: { 'claude/channel': {} } }),
    request: (request: { method: string }, _schema: unknown, options?: { signal?: AbortSignal }) => {
      if (request.method !== 'events/stream') return Promise.reject(new Error(`${request.method} is not served`));
      streamRequested();
      return new Promise((resolve) => options?.signal?.addEventListener('abort', () => resolve({})));
    },
  });
  /** How many handlers took the message. */
  const notify = (method: string, params?: unknown): number => {
    const message = params === undefined ? { method } : { method, params };
    let taken = 0;
    for (const { schema, handler } of handlers) {
      const parsed = schema.safeParse(message);
      if (!parsed.success) continue;
      taken += 1;
      handler(parsed.data);
    }
    return taken;
  };
  return { client, notify, streamOpening };
}

type FakeClient = ReturnType<typeof fakeClient>;

/** The service as the handlers see it: `live` is the server's current client, `registered` the one in the client map. */
function fakeHost(live: () => Client | undefined, registered: () => Client | undefined = live) {
  return {
    onResourceListChanged: jest.fn(),
    onResourceUpdated: jest.fn(),
    getClient: (name: string) => (name === SERVER ? live() : undefined),
    clients: () => {
      const client = registered();
      return new Map<string, Client>(client ? [[SERVER, client]] : []);
    },
  } satisfies ServerNotificationsHost;
}

function listenForChannel() {
  const received: McpInboundEvent[] = [];
  const stop = subscribeInboundEvents(SERVER, (event) => { received.push(event); });
  return { received, stop };
}

/** Opens a push stream on the fake client and sends it each `notifications/events/*` message through `deliver`. */
async function streamThrough(fake: FakeClient, deliver: Deliver) {
  const seen: string[] = [];
  const opening = openMcpEventStream(fake.client, { name: 'message.received', cursor: null, openTimeoutMs: 1_000 }, {
    onActive: () => seen.push('active'),
    onEvent: (event) => seen.push(`event ${event.eventId}`),
    onHeartbeat: (cursor) => seen.push(`heartbeat ${cursor}`),
    onError: (error) => seen.push(`error ${error.message}`),
  });
  await fake.streamOpening;
  const meta = { _meta: { [SUB]: 1 } };
  deliver('notifications/events/active', { cursor: 'c0', ...meta });
  const stream = await opening;
  deliver('notifications/events/event', { eventId: 'e1', name: 'message.received', ...meta });
  deliver('notifications/events/heartbeat', { cursor: 'c1', ...meta });
  deliver('notifications/events/error', { error: { message: 'slow' }, ...meta });
  deliver('notifications/events/terminated', { error: { message: 'gone' }, ...meta });
  await expect(stream.ended).resolves.toEqual({ kind: 'terminated', error: { message: 'gone' } });
  expect(seen).toEqual(['active', 'event e1', 'heartbeat c1', 'error slow']);
}

async function expectToolListsDropped(notified: Client, registered: Client, announce: () => void) {
  let loads = 0;
  const list = (client: Client) => cachedMcpList<{ tools: string[]; error?: string }>(client, 'tools', 'all', async () => {
    loads += 1;
    return { tools: [] };
  });
  await list(notified);
  await list(registered);
  await list(notified);
  await list(registered);
  expect(loads).toBe(2);
  announce();
  await list(notified);
  await list(registered);
  expect(loads).toBe(4);
}

describe('registerServerNotifications on a classic client', () => {
  it('gives every kind of server message exactly one handler', () => {
    const fake = fakeClient();
    registerServerNotifications(fake.client, SERVER, fakeHost(() => fake.client));
    const kinds = [
      'notifications/resources/list_changed',
      'notifications/tools/list_changed',
      CLAUDE_CHANNEL_METHOD,
      ...MCP_EVENT_NOTIFICATIONS,
    ];
    for (const method of kinds) expect([method, fake.notify(method)]).toEqual([method, 1]);
    expect(fake.notify('notifications/resources/updated', { uri: 'file:///a' })).toBe(1);
  });

  it('reports resource list changes and resource updates to the service', () => {
    const fake = fakeClient();
    const host = fakeHost(() => fake.client);
    registerServerNotifications(fake.client, SERVER, host);
    fake.notify('notifications/resources/list_changed');
    fake.notify('notifications/resources/updated', { uri: 'file:///a' });
    expect(host.onResourceListChanged).toHaveBeenCalledWith(SERVER);
    expect(host.onResourceUpdated).toHaveBeenCalledWith(SERVER, 'file:///a');
  });

  it('drops the reused tool lists of the notified client and of the registered one', async () => {
    const fake = fakeClient();
    const registered = fakeClient().client;
    registerServerNotifications(fake.client, SERVER, fakeHost(() => fake.client, () => registered));
    await expectToolListsDropped(fake.client, registered, () => fake.notify('notifications/tools/list_changed'));
  });

  it('passes a Claude channel message on while the client is current, and ignores it once replaced', () => {
    const fake = fakeClient();
    let live: Client = fake.client;
    registerServerNotifications(fake.client, SERVER, fakeHost(() => live));
    const { received, stop } = listenForChannel();
    fake.notify(CLAUDE_CHANNEL_METHOD, { content: 'build failed' });
    live = fakeClient().client;
    fake.notify(CLAUDE_CHANNEL_METHOD, { content: 'late' });
    stop();
    expect(received.map((event) => event.content)).toEqual(['build failed']);
  });

  it('routes every MCP events message to the stream that asked', async () => {
    const fake = fakeClient();
    registerServerNotifications(fake.client, SERVER, fakeHost(() => fake.client));
    await streamThrough(fake, (method, params) => { fake.notify(method, params); });
  });
});

describe('newerClientNotifications for a newer-protocol client', () => {
  it('reports resource changes only while the client is current', () => {
    const fake = fakeClient();
    let live: Client = fake.client;
    const host = fakeHost(() => live);
    const notifications = newerClientNotifications(SERVER, () => fake.client, host);
    notifications.onResourcesChanged();
    notifications.extensionNotifications['notifications/resources/list_changed'](undefined);
    notifications.extensionNotifications['notifications/resources/updated']({ uri: 'file:///a' });
    expect(host.onResourceListChanged).toHaveBeenCalledTimes(2);
    expect(host.onResourceUpdated).toHaveBeenCalledWith(SERVER, 'file:///a');

    live = fakeClient().client;
    notifications.onResourcesChanged();
    notifications.extensionNotifications['notifications/resources/list_changed'](undefined);
    notifications.extensionNotifications['notifications/resources/updated']({ uri: 'file:///b' });
    expect(host.onResourceListChanged).toHaveBeenCalledTimes(2);
    expect(host.onResourceUpdated).toHaveBeenCalledTimes(1);
  });

  it('drops the reused tool lists of the client being built and of the registered one', async () => {
    const fake = fakeClient();
    const registered = fakeClient().client;
    const notifications = newerClientNotifications(SERVER, () => fake.client, fakeHost(() => fake.client, () => registered));
    await expectToolListsDropped(fake.client, registered, notifications.onToolsChanged);
  });

  it('passes a Claude channel message on while the client is current, and ignores it once replaced', () => {
    const fake = fakeClient();
    let live: Client = fake.client;
    const notifications = newerClientNotifications(SERVER, () => fake.client, fakeHost(() => live));
    const { received, stop } = listenForChannel();
    notifications.extensionNotifications[CLAUDE_CHANNEL_METHOD]({ content: 'build failed' });
    live = fakeClient().client;
    notifications.extensionNotifications[CLAUDE_CHANNEL_METHOD]({ content: 'late' });
    stop();
    expect(received.map((event) => event.content)).toEqual(['build failed']);
  });

  it('routes every MCP events message to the stream that asked', async () => {
    const fake = fakeClient();
    const notifications = newerClientNotifications(SERVER, () => fake.client, fakeHost(() => fake.client));
    expect(Object.keys(notifications.extensionNotifications)).toEqual(expect.arrayContaining([...MCP_EVENT_NOTIFICATIONS]));
    await streamThrough(fake, (method, params) => notifications.extensionNotifications[method](params));
  });
});
