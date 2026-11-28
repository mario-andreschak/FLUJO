// A real MCP server on the official classic SDK (`@modelcontextprotocol/sdk`), used as
// an outside event source by __tests__/mcp/realEventSource.test.ts (#1401). It runs as
// its own process and sends what a real event server sends:
//   - MCP events extension (`io.modelcontextprotocol/events`): `events/list`,
//     push over `events/stream` (active, events, heartbeats) and `events/poll`;
//   - Claude channel messages (`notifications/claude/channel`);
//   - resource notifications (`notifications/resources/list_changed`, `.../updated`).
// Its event history lives in <stateDir>/history.jsonl (one event per line), so a
// restarted server replays from a cursor (`pos-<n>` = after the first n events).
// Lines added to that file while the server is down count as events that happened
// upstream in the meantime.
//
//   node eventSourceServer.mjs <stateDir>             stdio
//   node eventSourceServer.mjs <stateDir> <httpPort>  Streamable HTTP on 127.0.0.1:<port>/mcp
//
// Once listening it writes <stateDir>/control.json = { pid, port }; `port` serves the
// control requests the test sends (in HTTP mode the same port as /mcp):
//   POST /emit              { data }           record an event and push it to open streams
//   POST /channel           { content, meta }  send a channel message to every connection
//   POST /resources-changed {}                 send resources/list_changed to every connection
//   POST /resource-updated  { uri }            send resources/updated to connections that subscribed
//   POST /hang              {}                 stop reading requests and stop all heartbeats, like a
//                                              deadlocked server that never exits (stdio only)
//   GET  /state             open streams, connections, polls and stream requests seen
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const [stateDir, portArgument] = process.argv.slice(2);
if (!stateDir) throw new Error('usage: eventSourceServer.mjs <stateDir> [httpPort]');
const historyFile = path.join(stateDir, 'history.jsonl');
const EXTENSION = 'io.modelcontextprotocol/events';
const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';
const EVENT_NAME = 'message.received';
const HEARTBEAT_MS = 1_000;
const NOT_FOUND = -32023;

let hung = false;
const streams = new Set();
const connections = new Set();
const streamRequests = [];
const polls = [];

const readHistory = () => existsSync(historyFile)
  ? readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];
const position = cursor => {
  const match = /^pos-(\d+)$/.exec(cursor ?? '');
  return match ? Number(match[1]) : null;
};

/** Sends every event the stream has not had yet, one stream at a time, in order. */
function flush(stream) {
  stream.sending = stream.sending.then(async () => {
    const history = readHistory();
    while (!stream.closed && stream.position < history.length) {
      const event = history[stream.position];
      stream.position += 1;
      await stream.send('notifications/events/event', { ...event, cursor: `pos-${stream.position}` });
    }
  }).catch(() => undefined);
  return stream.sending;
}

function eventServer() {
  const server = new Server(
    { name: 'event-source-fixture', version: '1.0.0' },
    {
      capabilities: {
        resources: { subscribe: true, listChanged: true },
        experimental: { 'claude/channel': {} },
        extensions: { [EXTENSION]: { listChanged: false } },
      },
    },
  );
  const connection = { server, subscriptions: new Set(), standaloneStreams: 0 };

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'inbox://latest', name: 'Latest message', mimeType: 'text/plain' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => ({
    contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: String(readHistory().length) }],
  }));
  server.setRequestHandler(SubscribeRequestSchema, async request => {
    connection.subscriptions.add(request.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async request => {
    connection.subscriptions.delete(request.params.uri);
    return {};
  });

  server.setRequestHandler(z.object({ method: z.literal('events/list'), params: z.object({}).passthrough().optional() }), async () => ({
    events: [{
      name: EVENT_NAME,
      description: 'A new chat message',
      delivery: ['push', 'poll'],
      inputSchema: { type: 'object', properties: { chat: { type: 'string' } } },
    }],
  }));

  server.setRequestHandler(z.object({ method: z.literal('events/poll'), params: z.object({}).passthrough() }), async request => {
    const { name, cursor = null, maxEvents = 50 } = request.params;
    if (name !== EVENT_NAME) throw Object.assign(new Error('NotFound'), { code: NOT_FOUND });
    polls.push({ cursor });
    const history = readHistory();
    const start = cursor === null ? history.length : Math.min(position(cursor) ?? history.length, history.length);
    const batch = history.slice(start, start + maxEvents);
    const end = start + batch.length;
    return {
      events: batch.map((event, index) => ({ ...event, cursor: `pos-${start + index + 1}` })),
      cursor: `pos-${end}`,
      truncated: false,
      hasMore: end < history.length,
      nextPollMs: 1_000,
    };
  });

  server.setRequestHandler(z.object({ method: z.literal('events/stream'), params: z.object({}).passthrough() }), async (request, extra) => {
    const { name, cursor = null } = request.params;
    if (name !== EVENT_NAME) throw Object.assign(new Error('NotFound'), { code: NOT_FOUND });
    streamRequests.push({ cursor, pid: process.pid });
    const historyLength = readHistory().length;
    const start = cursor === null ? historyLength : Math.min(position(cursor) ?? historyLength, historyLength);
    const meta = { [SUBSCRIPTION_ID]: extra.requestId };
    const stream = {
      position: start,
      closed: false,
      sending: Promise.resolve(),
      send: (method, params) => extra.sendNotification({ method, params: { ...params, _meta: meta } }),
    };
    await stream.send('notifications/events/active', { cursor: `pos-${start}`, truncated: false, heartbeatMs: HEARTBEAT_MS });
    streams.add(stream);
    void flush(stream);
    const heartbeat = setInterval(() => {
      if (hung) return;
      stream.sending = stream.sending
        .then(() => stream.send('notifications/events/heartbeat', { cursor: `pos-${stream.position}` }))
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    await new Promise(resolve => {
      if (extra.signal.aborted) resolve();
      extra.signal.addEventListener('abort', resolve, { once: true });
    });
    clearInterval(heartbeat);
    stream.closed = true;
    streams.delete(stream);
    return { _meta: meta };
  });

  return connection;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : undefined); } catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

const everyConnection = send => Promise.all([...connections].map(connection => send(connection).catch(() => undefined)));

const CONTROL_ROUTES = new Set(['/emit', '/channel', '/resources-changed', '/resource-updated', '/hang', '/state']);

async function control(request) {
  const route = new URL(request.url, 'http://fixture').pathname;
  if (!CONTROL_ROUTES.has(route)) return null;
  const body = request.method === 'POST' ? (await readJson(request)) ?? {} : {};
  if (route === '/emit') {
    const history = readHistory();
    const event = {
      eventId: body.eventId ?? `evt-${history.length + 1}`,
      name: EVENT_NAME,
      timestamp: new Date().toISOString(),
      data: body.data ?? {},
    };
    appendFileSync(historyFile, `${JSON.stringify(event)}\n`);
    await Promise.all([...streams].map(flush));
    return { eventId: event.eventId, cursor: `pos-${history.length + 1}` };
  }
  if (route === '/channel') {
    await everyConnection(({ server }) => server.notification({
      method: 'notifications/claude/channel',
      params: { content: body.content, ...(body.meta ? { meta: body.meta } : {}) },
    }));
    return { connections: connections.size };
  }
  if (route === '/resources-changed') {
    await everyConnection(({ server }) => server.sendResourceListChanged());
    return { connections: connections.size };
  }
  if (route === '/resource-updated') {
    await everyConnection(({ server, subscriptions }) => subscriptions.has(body.uri)
      ? server.sendResourceUpdated({ uri: body.uri })
      : Promise.resolve());
    return { connections: connections.size };
  }
  if (route === '/hang') {
    hung = true;
    process.stdin.pause();
    return { hung: true };
  }
  if (route === '/state') {
    return {
      pid: process.pid,
      streams: streams.size,
      connections: connections.size,
      standaloneStreams: [...connections].reduce((sum, connection) => sum + connection.standaloneStreams, 0),
      subscriptions: [...connections].flatMap(connection => [...connection.subscriptions]),
      streamRequests,
      polls,
    };
  }
  throw new Error(`Unknown control route ${route}`);
}

async function answerControl(request, response) {
  try {
    const result = await control(request);
    if (result === null) return false;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
  return true;
}

function announce(port) {
  const file = path.join(stateDir, 'control.json');
  writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, port }));
  renameSync(`${file}.tmp`, file);
}

function listen(httpServer, port) {
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve(httpServer.address().port));
  });
}

async function serveStdio() {
  const connection = eventServer();
  connections.add(connection);
  const controlServer = createServer((request, response) => {
    void answerControl(request, response).then(handled => {
      if (!handled) response.writeHead(404).end();
    });
  });
  const port = await listen(controlServer, 0);
  controlServer.unref();
  await connection.server.connect(new StdioServerTransport());
  announce(port);
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
}

async function serveHttp(port) {
  const sessions = new Map();
  const httpServer = createServer(async (request, response) => {
    if (await answerControl(request, response)) return;
    if (!request.url?.startsWith('/mcp')) {
      response.writeHead(404).end();
      return;
    }
    const sessionId = request.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (existing) {
      if (request.method === 'GET') {
        existing.connection.standaloneStreams += 1;
        response.on('close', () => { existing.connection.standaloneStreams -= 1; });
      }
      await existing.transport.handleRequest(request, response, request.method === 'POST' ? await readJson(request) : undefined);
      return;
    }
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    if (request.method !== 'POST' || !isInitializeRequest(body)) {
      response.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Session not found' : 'Bad Request: Server not initialized' }, id: null }));
      return;
    }
    const connection = eventServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: id => {
        sessions.set(id, { transport, connection });
        connections.add(connection);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      connections.delete(connection);
    };
    await connection.server.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  announce(await listen(httpServer, port));
}

if (portArgument === undefined) await serveStdio();
else await serveHttp(Number(portArgument));
