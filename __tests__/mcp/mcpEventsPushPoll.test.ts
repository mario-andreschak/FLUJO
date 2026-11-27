/**
 * MCP events extension (`io.modelcontextprotocol/events`, SEP-3415, Beta;
 * #1401, #1448 "Push events"): push (`events/stream`) and poll
 * (`events/poll`) against the installed SDKs, both client generations, and
 * the Streamable HTTP routing headers.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  Client as BetaClient,
  InMemoryTransport as BetaInMemoryTransport,
} from '@modelcontextprotocol/client';
import { z } from 'zod';
import {
  encodeHeaderValue,
  eventHeaderDeclarations,
  eventRequestHeaders,
  listMcpEvents,
  pollMcpEvent,
  serverSupportsEvents,
} from '@/backend/services/mcp/serverEvents';
import {
  MCP_EVENT_NOTIFICATIONS,
  openMcpEventStream,
  registerMcpEventStreamHandlers,
  routeMcpEventNotification,
  type McpEventStreamHandlers,
} from '@/backend/services/mcp/serverEventStream';
import { registerExtensionNotifications } from '@/backend/services/mcp/betaClient';
import { CLAUDE_CHANNEL_METHOD } from '@/backend/services/mcp/inboundEvents';
import {
  mcpEventDeliveryModes,
  preferredMcpEventDelivery,
} from '@/shared/types/plannedExecution';

jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(async () => ({})), saveItem: jest.fn() }));

const SUB = 'io.modelcontextprotocol/subscriptionId';

interface OpenStream {
  id: string | number;
  name: string;
  arguments?: Record<string, unknown>;
  cursor: string | null;
  heartbeatMs?: number;
  cancelled: boolean;
}

/** A small events server built on the real v1 server SDK. */
function eventsServer() {
  const server = new Server(
    { name: 'events-test', version: '0.0.1' },
    { capabilities: { extensions: { 'io.modelcontextprotocol/events': { listChanged: false } } } },
  );
  const streams: OpenStream[] = [];
  const history = [
    { eventId: 'evt-1', name: 'message.received', timestamp: '2026-11-27T10:00:00Z', data: { text: 'one' } },
    { eventId: 'evt-2', name: 'message.received', timestamp: '2026-11-27T10:00:01Z', data: { text: 'two' } },
    { eventId: 'evt-3', name: 'message.received', timestamp: '2026-11-27T10:00:02Z', data: { text: 'three' } },
  ];
  const polls: Array<Record<string, unknown>> = [];

  server.setRequestHandler(z.object({ method: z.literal('events/list'), params: z.object({}).passthrough().optional() }), async () => ({
    resultType: 'complete',
    events: [
      {
        name: 'message.received',
        description: 'A new chat message',
        delivery: ['webhook', 'push', 'poll'],
        inputSchema: { type: 'object', properties: { chat: { type: 'string', 'x-mcp-header': 'Chat' } } },
      },
      {
        name: 'broken.header',
        delivery: ['poll'],
        inputSchema: { type: 'object', properties: { score: { type: 'number', 'x-mcp-header': 'Score' } } },
      },
    ],
  }));

  server.setRequestHandler(z.object({ method: z.literal('events/poll'), params: z.object({}).passthrough() }), async (request) => {
    const params = request.params as { name: string; cursor: string | null; maxEvents?: number };
    polls.push(params);
    if (params.cursor === null) return { resultType: 'complete', events: [], cursor: 'pos-0', hasMore: false, nextPollMs: 5000 };
    const start = Number(params.cursor.replace('pos-', ''));
    const max = params.maxEvents ?? 50;
    const batch = history.slice(start, start + max);
    const end = start + batch.length;
    return {
      resultType: 'complete',
      events: [...batch, { name: 'message.received' }],
      cursor: `pos-${end}`,
      truncated: false,
      hasMore: end < history.length,
      nextPollMs: 5000,
    };
  });

  server.setRequestHandler(z.object({ method: z.literal('events/stream'), params: z.object({}).passthrough() }), async (request, extra) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown>; cursor: string | null; heartbeatMs?: number };
    if (params.name === 'missing.event') throw Object.assign(new Error('NotFound'), { code: -32023 });
    const stream: OpenStream = { id: extra.requestId, ...params, cancelled: false };
    streams.push(stream);
    await server.notification({
      method: 'notifications/events/active',
      params: { cursor: 'pos-0', truncated: false, heartbeatMs: 15000, _meta: { [SUB]: extra.requestId } },
    });
    await new Promise<void>((resolve) => {
      if (extra.signal.aborted) resolve();
      extra.signal.addEventListener('abort', () => resolve());
    });
    stream.cancelled = true;
    return { resultType: 'complete', _meta: { [SUB]: extra.requestId } };
  });

  const send = (stream: OpenStream, method: string, params: Record<string, unknown>) =>
    server.notification({ method, params: { ...params, _meta: { [SUB]: stream.id } } });

  return { server, streams, polls, history, send };
}

async function connectV1() {
  const fake = eventsServer();
  const client = new Client({ name: 'flujo-test', version: '1.0.0' });
  registerMcpEventStreamHandlers(client, 'events-test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([fake.server.connect(serverSide), client.connect(clientSide)]);
  return { ...fake, client };
}

function recorder() {
  const seen: Array<{ kind: string; value: unknown }> = [];
  const handlers: McpEventStreamHandlers = {
    onActive: value => seen.push({ kind: 'active', value }),
    onEvent: value => seen.push({ kind: 'event', value }),
    onHeartbeat: value => seen.push({ kind: 'heartbeat', value }),
    onError: value => seen.push({ kind: 'error', value }),
  };
  return { seen, handlers };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('discovery', () => {
  it('detects the extension, lists events and leaves out an event with a broken header annotation', async () => {
    const { client } = await connectV1();
    expect(serverSupportsEvents(client)).toBe(true);
    const events = await listMcpEvents(client);
    expect(events.map(event => event.name)).toEqual(['message.received']);
    expect(mcpEventDeliveryModes(events[0].delivery)).toEqual(['push', 'poll', 'webhook']);
    expect(preferredMcpEventDelivery(events[0].delivery)).toBe('push');
    await client.close();
  });

  it('prefers push, then poll, then webhook; older drafts that list no modes mean webhook', () => {
    expect(preferredMcpEventDelivery(['webhook', 'poll'])).toBe('poll');
    expect(preferredMcpEventDelivery(['webhook'])).toBe('webhook');
    expect(preferredMcpEventDelivery(undefined)).toBe('webhook');
    expect(mcpEventDeliveryModes(['carrier-pigeon'])).toEqual([]);
  });
});

describe('push delivery (events/stream) with the classic client', () => {
  it('opens a stream, gets events and heartbeats, and cancels it on close', async () => {
    const { client, streams, send } = await connectV1();
    const { seen, handlers } = recorder();
    const stream = await openMcpEventStream(client, {
      name: 'message.received', arguments: { chat: 'family' }, cursor: 'pos-7', heartbeatMs: 15000,
    }, handlers);
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({ name: 'message.received', arguments: { chat: 'family' }, cursor: 'pos-7', heartbeatMs: 15000 });
    expect(seen[0]).toEqual({ kind: 'active', value: { cursor: 'pos-0', truncated: false, heartbeatMs: 15000 } });

    await send(streams[0], 'notifications/events/event', {
      eventId: 'evt-9', name: 'message.received', timestamp: '2026-11-27T10:00:09Z', data: { text: 'hi' }, cursor: 'pos-9',
    });
    await send(streams[0], 'notifications/events/heartbeat', { cursor: 'pos-12' });
    await send(streams[0], 'notifications/events/error', { error: { code: -32603, message: 'UpstreamError' } });
    await settle();
    expect(seen.slice(1)).toEqual([
      { kind: 'event', value: expect.objectContaining({ eventId: 'evt-9', cursor: 'pos-9', data: { text: 'hi' } }) },
      { kind: 'heartbeat', value: 'pos-12' },
      { kind: 'error', value: { code: -32603, message: 'UpstreamError' } },
    ]);

    stream.close();
    await expect(stream.ended).resolves.toEqual({ kind: 'closed' });
    await settle();
    expect(streams[0].cancelled).toBe(true);
    await client.close();
  });

  it('keeps two streams on one connection apart by their subscription id', async () => {
    const { client, streams, send } = await connectV1();
    const first = recorder();
    const second = recorder();
    const [a, b] = await Promise.all([
      openMcpEventStream(client, { name: 'message.received', arguments: { chat: 'a' }, cursor: null }, first.handlers),
      openMcpEventStream(client, { name: 'message.received', arguments: { chat: 'b' }, cursor: null }, second.handlers),
    ]);
    const streamB = streams.find(stream => stream.arguments?.chat === 'b')!;
    await send(streamB, 'notifications/events/event', { eventId: 'only-b', name: 'message.received', timestamp: 't', data: {} });
    await settle();
    expect(first.seen.filter(entry => entry.kind === 'event')).toEqual([]);
    expect(second.seen.filter(entry => entry.kind === 'event')).toEqual([
      { kind: 'event', value: expect.objectContaining({ eventId: 'only-b' }) },
    ]);
    a.close();
    b.close();
    await client.close();
  });

  it('ends the stream on a termination notice and drops malformed events', async () => {
    const { client, streams, send } = await connectV1();
    const { seen, handlers } = recorder();
    const stream = await openMcpEventStream(client, { name: 'message.received', cursor: null }, handlers);
    await send(streams[0], 'notifications/events/event', { name: 'message.received' });
    await send(streams[0], 'notifications/events/event', { eventId: 'x', name: 'another.event', timestamp: 't', data: {} });
    await send(streams[0], 'notifications/events/terminated', {
      error: { code: -32024, message: 'Forbidden', data: { reason: 'Access revoked' } },
    });
    await expect(stream.ended).resolves.toEqual({
      kind: 'terminated', error: { code: -32024, message: 'Forbidden', data: { reason: 'Access revoked' } },
    });
    expect(seen.filter(entry => entry.kind === 'event')).toEqual([]);
    await settle();
    expect(streams[0].cancelled).toBe(true);
    await client.close();
  });

  it('reports a refused subscription as an error and a lost connection as failed', async () => {
    const { client, server } = await connectV1();
    await expect(openMcpEventStream(client, { name: 'missing.event', cursor: null }, recorder().handlers))
      .rejects.toThrow('NotFound');

    const stream = await openMcpEventStream(client, { name: 'message.received', cursor: null }, recorder().handlers);
    await server.close();
    await expect(stream.ended).resolves.toMatchObject({ kind: 'failed' });
  });

  it('gives up on a server that never confirms', async () => {
    const client = new Client({ name: 'flujo-test', version: '1.0.0' });
    const server = new Server({ name: 'silent', version: '0.0.1' }, { capabilities: {} });
    server.setRequestHandler(z.object({ method: z.literal('events/stream'), params: z.object({}).passthrough() }), async (_request, extra) => {
      await new Promise<void>(resolve => extra.signal.addEventListener('abort', () => resolve()));
      return {};
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await expect(openMcpEventStream(client, { name: 'message.received', cursor: null, openTimeoutMs: 50 }, recorder().handlers))
      .rejects.toThrow('did not confirm');
    await client.close();
  });

  it('ignores notifications for streams it does not hold', () => {
    expect(() => routeMcpEventNotification({}, 'notifications/events/event', { _meta: { [SUB]: 99 } })).not.toThrow();
    expect(MCP_EVENT_NOTIFICATIONS).toContain('notifications/events/terminated');
  });
});

describe('push delivery with the newer client', () => {
  it('registers non-core notification handlers with a schema, so building the client does not throw', async () => {
    const fake = eventsServer();
    const client = new BetaClient({ name: 'flujo-test', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
    const channel = jest.fn();
    // The mistake this guards against: without a schema the newer client refuses a non-core method.
    const withoutSchema = client.setNotificationHandler.bind(client) as (method: string, handler: () => void) => void;
    expect(() => withoutSchema(CLAUDE_CHANNEL_METHOD, () => undefined)).toThrow('not a spec notification method');
    const handlers: Record<string, (params: unknown) => void> = { [CLAUDE_CHANNEL_METHOD]: channel };
    for (const method of MCP_EVENT_NOTIFICATIONS) handlers[method] = params => routeMcpEventNotification(client, method, params);
    expect(() => registerExtensionNotifications(client, 'events-test', handlers)).not.toThrow();

    const [clientSide, serverSide] = BetaInMemoryTransport.createLinkedPair();
    await Promise.all([fake.server.connect(serverSide), client.connect(clientSide)]);
    expect(serverSupportsEvents(client as never)).toBe(true);

    const { seen, handlers: streamHandlers } = recorder();
    const stream = await openMcpEventStream(client as never, { name: 'message.received', cursor: null }, streamHandlers);
    await fake.send(fake.streams[0], 'notifications/events/event', {
      eventId: 'beta-1', name: 'message.received', timestamp: 't', data: { text: 'from beta' }, cursor: 'pos-1',
    });
    await fake.server.notification({ method: CLAUDE_CHANNEL_METHOD, params: { content: 'hello' } });
    await settle();
    expect(seen.map(entry => entry.kind)).toEqual(['active', 'event']);
    expect(channel).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
    stream.close();
    await expect(stream.ended).resolves.toEqual({ kind: 'closed' });
    await client.close();
  });
});

describe('poll delivery (events/poll)', () => {
  it('starts from now, then reads pages of events after the cursor and skips malformed ones', async () => {
    const { client, polls } = await connectV1();
    const first = await pollMcpEvent(client, { name: 'message.received', cursor: null });
    expect(first).toEqual({ events: [], malformed: 0, cursor: 'pos-0', truncated: false, hasMore: false, nextPollMs: 5000 });

    const second = await pollMcpEvent(client, { name: 'message.received', arguments: { chat: 'a' }, cursor: 'pos-0', maxEvents: 2 });
    expect(second.events.map(event => event.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(second).toMatchObject({ malformed: 1, cursor: 'pos-2', hasMore: true });
    expect(polls[1]).toMatchObject({ name: 'message.received', arguments: { chat: 'a' }, cursor: 'pos-0', maxEvents: 2 });
    await client.close();
  });
});

describe('Streamable HTTP routing headers', () => {
  it('names the event and mirrors annotated arguments, in Base64 when needed', () => {
    const descriptor = {
      name: 'message.received',
      inputSchema: {
        type: 'object',
        properties: {
          chat: { type: 'string', 'x-mcp-header': 'Chat' },
          urgent: { type: 'boolean', 'x-mcp-header': 'Urgent' },
          nested: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } },
        },
      },
    };
    expect(eventRequestHeaders({ name: 'message.received', arguments: { chat: 'Grüße', urgent: true, nested: { region: 'eu' } } }, descriptor))
      .toEqual({
        'Mcp-Name': 'message.received',
        'Mcp-Param-Chat': `=?base64?${Buffer.from('Grüße').toString('base64')}?=`,
        'Mcp-Param-Urgent': 'true',
        'Mcp-Param-Region': 'eu',
      });
    expect(encodeHeaderValue(' padded')).toMatch(/^=\?base64\?/);
  });

  it('rejects annotations the transport does not allow', () => {
    expect(eventHeaderDeclarations({ type: 'object', properties: { n: { type: 'number', 'x-mcp-header': 'N' } } })).toBeNull();
    expect(eventHeaderDeclarations({ type: 'object', properties: { a: { type: 'array', items: { type: 'string', 'x-mcp-header': 'A' } } } })).toBeNull();
    expect(eventHeaderDeclarations({
      type: 'object',
      properties: { a: { type: 'string', 'x-mcp-header': 'Same' }, b: { type: 'string', 'x-mcp-header': 'same' } },
    })).toBeNull();
    expect(eventHeaderDeclarations({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'Bad Header' } } })).toBeNull();
    expect(eventHeaderDeclarations(undefined)).toEqual([]);
  });
});
