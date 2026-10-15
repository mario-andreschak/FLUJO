#!/usr/bin/env node
// #1093 EVENTS-1: real production app and SDK HTTP streams. Run through flujo-bash MCP.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema, ListPromptsRequestSchema, ReadResourceRequestSchema,
  SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Server as ModernServer, createMcpHandler, InMemoryServerEventBus } from '@modelcontextprotocol/server';
import { SUBSCRIPTION_ID_META_KEY as subscriptionKey } from '@modelcontextprotocol/client';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

assert.equal(process.argv.slice(2).join(' '), '--production', 'Usage: smoke-mcp-subscriptions.mjs --production (build first)');
const application = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildId = (await fs.readFile(path.join(application, '.next/BUILD_ID'), 'utf8')).trim();
const workspace = 'subscription-acceptance', uri = 'events://watched', otherUri = 'events://unwatched';
const password = randomBytes(32).toString('hex');
const sessions = new Map(), streams = new Set(), legacyStreams = new Set(), flowClients = new Set();
const bus = new InMemoryServerEventBus();
const state = { legacy: { epoch: 0, contentEpoch: 1, reads: 0, lists: {}, subscribes: 0 },
  modern: { epoch: 0, contentEpoch: 1, reads: 0, lists: {}, subscribes: 0 } };
const receipt = { schemaVersion: 1, buildId, externalProviderCalls: 0, fixtureModelCalls: 0,
  groups: [], traces: [], limitations: ['Source production build and loopback reference servers; not installed artifacts or a public deployment',
    'Synthetic loopback model only; no OAuth or Apps browser qualification'] };
let child, childClosed, operator, base, serverLog = '', failure, expectedResourceText, wireFailure;
let selectedWorkspace = 'default-workspace';

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() { const server = http.createServer(), port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; }
async function waitFor(check, label) {
  const end = Date.now() + 10_000;
  do { if (wireFailure) throw wireFailure; const value = await check(); if (value) return value; await delay(50); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
async function readJson(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; assert.ok(size <= 256 * 1024); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function catalog(generation, method) {
  const current = state[generation]; current.lists[method] = (current.lists[method] ?? 0) + 1;
  const name = `${generation}_${current.epoch}`;
  if (method === 'tools/list') return { tools: [{ name, inputSchema: { type: 'object', properties: {} } }] };
  if (method === 'prompts/list') return { prompts: [{ name }] };
  if (method === 'resources/templates/list') return { resourceTemplates: [{ name, uriTemplate: `events://${current.epoch}/{id}` }] };
  return { resources: [{ name, uri }] };
}
function resource(generation, requestedUri) {
  assert.equal(requestedUri, uri);
  state[generation].reads++;
  return { contents: [{ uri, mimeType: 'text/plain', text: `${generation} content ${state[generation].contentEpoch}` }] };
}
const capabilities = { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { subscribe: true, listChanged: true } };
const modern = createMcpHandler(() => {
  const cacheHints = Object.fromEntries(['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list', 'resources/read']
    .map(method => [method, { ttlMs: 60_000, cacheScope: 'private' }]));
  const server = new ModernServer({ name: 'events-modern', version: '1.0.0' }, { capabilities, cacheHints });
  for (const method of ['tools/list', 'prompts/list', 'resources/list', 'resources/templates/list']) server.setRequestHandler(method, () => catalog('modern', method));
  server.setRequestHandler('resources/read', request => resource('modern', request.params.uri));
  return server;
}, { legacy: 'reject', bus });

function observeFrames(stream, bytes) {
  stream.buffer += bytes.toString();
  for (;;) {
    const end = stream.buffer.indexOf('\n\n'); if (end < 0) break;
    const frame = stream.buffer.slice(0, end); stream.buffer = stream.buffer.slice(end + 2);
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) continue;
    const message = JSON.parse(data), correlated = message.params?._meta?.[subscriptionKey];
    stream.messages.push(message);
    receipt.traces.push({ method: message.method, subscriptionId: correlated, requestId: stream.id,
      ...(message.method === 'notifications/subscriptions/acknowledged' ? { honoredFilter: message.params.notifications } : {}),
      ...(message.params?.uri ? { uri: message.params.uri } : {}) });
    if (message.method === 'notifications/subscriptions/acknowledged') {
      assert.equal(stream.messages.length, 1, 'Acknowledgment must be first');
      assert.equal(correlated, String(stream.id), 'Acknowledgment must correlate to the listen request');
    }
  }
}
const reference = http.createServer(async (request, response) => {
  try {
    if (request.url === '/modern') {
      const controller = new AbortController();
      response.once('close', () => { if (!response.writableEnded) controller.abort(); });
      const body = request.method === 'POST' ? await readJson(request) : undefined;
      const stream = body?.method === 'subscriptions/listen' ? { id: body.id, filter: body.params.notifications, response, buffer: '', messages: [] } : undefined;
      if (stream) { streams.add(stream); if (stream.filter.resourceSubscriptions) state.modern.subscribes++;
        receipt.traces.push({ generation: 'modern', method: 'subscriptions/listen', requestId: stream.id, filter: stream.filter });
        response.once('close', () => streams.delete(stream)); }
      const web = new Request(`http://127.0.0.1:${reference.address().port}/modern`, { method: request.method, headers: request.headers,
        signal: controller.signal, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await modern.fetch(web); response.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) { response.end(); return; }
      const readable = Readable.fromWeb(result.body);
      readable.on('error', () => response.destroy());
      if (stream) readable.on('data', bytes => { try { observeFrames(stream, bytes); } catch (error) { wireFailure = error; response.destroy(); } });
      response.once('close', () => readable.destroy()); readable.pipe(response); return;
    }
    assert.equal(request.url, '/legacy');
    if (request.method === 'GET') { legacyStreams.add(response); response.once('close', () => legacyStreams.delete(response)); }
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    let session = sessions.get(request.headers['mcp-session-id']);
    if (!session && body?.method === 'initialize') {
      const server = new Server({ name: 'events-legacy', version: '1.0.0' }, { capabilities });
      for (const schema of [ListToolsRequestSchema, ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema])
        server.setRequestHandler(schema, request => catalog('legacy', request.method));
      server.setRequestHandler(ReadResourceRequestSchema, request => resource('legacy', request.params.uri));
      const subscribed = new Set();
      server.setRequestHandler(SubscribeRequestSchema, request => { assert.equal(request.params.uri, uri); subscribed.add(uri); state.legacy.subscribes++;
        receipt.traces.push({ generation: 'legacy', method: 'resources/subscribe', uri }); return {}; });
      server.setRequestHandler(CallToolRequestSchema, () => ({ content: [] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      session = { server, transport, subscribed }; await server.connect(transport);
    }
    assert.ok(session, 'Unknown legacy session');
    await session.transport.handleRequest(request, response, body);
    if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
});
const model = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, 'Bearer synthetic-subscription-key');
    const body = await readJson(request); assert.equal(body.model, 'subscription-fixture');
    assert.ok(JSON.stringify(body.messages).includes(expectedResourceText), 'The bound resource must reach the real Flow model context');
    receipt.fixtureModelCalls++;
    const data = { id: 'subscription-fixture', model: body.model, created: 1,
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
    if (body.stream) { response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...data, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...data, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...data,
      object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
async function api(endpoint, body, method = body === undefined ? 'GET' : 'POST') {
  const url = new URL(endpoint, base); url.searchParams.set('workspace', selectedWorkspace);
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000) });
  const result = await response.json(); assert.ok(response.ok, `API ${endpoint}: ${response.status} ${JSON.stringify(result)}`); return result;
}
async function inspect(generation) {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', handler); reject(new Error('IPC observation timed out')); }, 5000);
    const handler = message => { if (message?.type === 'subscription-state' && message.requestId === requestId) {
      clearTimeout(timer); child.off('message', handler); resolve(message.servers.find(server => server.name === `events-${generation}`)); } };
    child.on('message', handler); child.send({ type: 'subscription-state', requestId, workspace });
  });
}
async function catalogs(generation, epoch) {
  for (const kind of ['tools', 'prompts', 'resources']) {
    const result = await api(`/api/mcp/servers/events-${generation}/${kind}`);
    assert.equal(result[kind].length, 1); assert.equal(result[kind][0].name, `${generation}_${epoch}`, `${kind} catalog must refresh`);
    if (kind === 'resources') { assert.equal(result.resourceTemplates.length, 1); assert.equal(result.resourceTemplates[0].name, `${generation}_${epoch}`); }
  }
}
async function notify(generation) {
  if (generation === 'modern') { modern.notify.toolsChanged(); modern.notify.promptsChanged(); modern.notify.resourcesChanged(); }
  else { const session = [...sessions.values()].at(-1); if (session) {
    await session.server.sendToolListChanged(); await session.server.sendPromptListChanged(); await session.server.sendResourceListChanged();
    receipt.traces.push(...['tools', 'prompts', 'resources'].map(kind => ({ generation, method: `notifications/${kind}/list_changed` })));
  } }
}
async function runFlow(generation) {
  expectedResourceText = `${generation} content ${state[generation].contentEpoch}`;
  const client = new Client({ name: 'subscription-flow-acceptance', version: '1.0.0' }); flowClients.add(client);
  const url = new URL('/mcp-flows', base); url.searchParams.set('workspace', workspace);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${operator.token}` } } }));
  const result = await client.callTool({ name: `events_${generation}_flow`, arguments: { input: 'Read the resource and reply OK.' } }, undefined, { timeout: 60_000 });
  assert.ok(!result.isError, JSON.stringify(result)); assert.ok(result.content.some(content => content.type === 'text' && content.text.includes('OK')));
  await client.close(); flowClients.delete(client);
}

try {
  operator = await createSmokeOperator(); const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const referencePort = await listen(reference), modelPort = await listen(model), appPort = await unusedPort(), sandboxPort = await unusedPort();
  base = `http://127.0.0.1:${appPort}`;
  const safe = {}; for (const [name, value] of Object.entries(process.env)) if (/^(path|systemroot|windir|comspec|pathext|systemdrive)$/i.test(name)) safe[name] = value;
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/mcp-subscriptions-process.cjs'), [String(appPort)], {
      cwd: application, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...safe, ...operator.env,
        NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
        TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_APP_ROOT: application,
        FLUJO_BASE_URL: base, FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_PORT: String(appPort),
        FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject); child.once('exit', () => reject(new Error('App exited before readiness')));
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid readiness receipt')));
  });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('App readiness timeout'); })]);
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { action, password })).success, true);
  await api('/api/workspaces', { name: workspace });
  selectedWorkspace = workspace;
  // Workspace creation can initialize a separate encryption profile; unlock it through the normal API.
  for (const action of ['initialize', 'authenticate']) assert.equal((await api('/api/encryption/secure', { action, password })).success, true);
  await api('/api/model', { id: 'subscription-fixture', name: 'subscription-fixture', provider: 'openai', adapter: 'openai',
    ApiKey: 'synthetic-subscription-key', baseUrl: `http://127.0.0.1:${modelPort}/v1` });
  for (const generation of ['legacy', 'modern']) {
    await api('/api/storage', { key: 'speech_settings', value: { experimental: { mcpBetaProtocol: generation === 'modern' } } });
    await api('/api/mcp/servers', { name: `events-${generation}`, transport: 'streamable', serverUrl: `http://127.0.0.1:${referencePort}/${generation}`, disabled: false });
    await catalogs(generation, 0);
    if (generation === 'modern') {
      await waitFor(() => streams.size === 1 && bus.listenerCount === 1, 'modern catalog listen');
      assert.deepEqual([...streams][0].filter, { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
    }
    const version = (await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion;
    state[generation].epoch = 1;
    if (generation === 'modern') {
      const before = { ...state.modern.lists }; await catalogs(generation, 0);
      assert.deepEqual(state.modern.lists, before, 'Fresh catalogs must actually be cached before invalidation is credited');
    }
    await notify(generation);
    await waitFor(async () => (await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion === version + 1, 'one correlated catalog update');
    await catalogs(generation, 1);
    const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, properties } });
    const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'subscription-fixture', promptTemplate: 'Reply OK.', allowQuestion: false }),
      node('finish', 'finish'), node('resource', 'resource', { scope: 'mcp', boundServer: `events-${generation}`, uri })];
    const edge = (source, target, edgeType = 'standard') => ({ id: `${source}->${target}`, source, target, data: { edgeType } });
    await api('/api/flow', { id: `events-${generation}-flow`, name: `Events ${generation} Flow`, nodes,
      edges: [edge('start', 'process'), edge('process', 'finish'), edge('resource', 'process', 'resource')], updatedAt: Date.now() });
    await runFlow(generation); await runFlow(generation);
    await waitFor(() => state[generation].subscribes > 0, 'resource subscription');
    state[generation].contentEpoch = 2;
    if (generation === 'modern') {
      assert.equal(state.modern.subscribes, 1, 'Repeated resource reads must reuse the URI stream');
      assert.equal(state.modern.reads, 1, 'Fresh resource content must actually be cached');
      assert.equal(bus.listenerCount, 2); assert.equal(streams.size, 2);
      assert.deepEqual([...streams].find(stream => stream.filter.resourceSubscriptions)?.filter, { resourceSubscriptions: [uri] });
      modern.notify.resourceUpdated(otherUri); modern.notify.resourceUpdated(uri);
    } else { const session = [...sessions.values()].at(-1); assert.ok(session.subscribed.has(uri)); await session.server.sendResourceUpdated({ uri });
      receipt.traces.push({ generation, method: 'notifications/resources/updated', uri }); }
    await waitFor(async () => (await inspect(generation)).pendingUris.includes(uri), 'subscribed URI reaches application');
    assert.deepEqual((await inspect(generation)).pendingUris, [uri], 'Unsubscribed resources must not enter application state');
    const updated = await api(`/api/mcp/servers/events-${generation}/resources/read?uri=${encodeURIComponent(uri)}`);
    assert.equal(updated.data.contents[0].text, `${generation} content 2`);
    if (generation === 'modern') assert.equal(state.modern.reads, 2, 'The subscribed URI update must evict cached content');
    const oldId = [...streams].find(stream => stream.filter.resourceSubscriptions)?.id;
    await api(`/api/mcp/servers/events-${generation}`, { disabled: true }, 'PUT');
    await waitFor(async () => !(await inspect(generation)).connected, 'generation deregistration');
    if (generation === 'modern') await waitFor(() => streams.size === 0 && bus.listenerCount === 0, 'retired generation stream teardown');
    else await waitFor(() => legacyStreams.size === 0, 'retired legacy SSE teardown');
    const retiredVersion = (await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion;
    if (generation === 'modern') { await notify(generation); await delay(100); assert.equal((await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion, retiredVersion); }
    await api(`/api/mcp/servers/events-${generation}`, { disabled: false }, 'PUT'); await catalogs(generation, 1);
    if (generation === 'modern') {
      await waitFor(() => streams.size === 1, 'reconnected catalog stream');
      const current = [...streams][0]; assert.notEqual(current.id, oldId);
      current.response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/resources/list_changed',
        params: { _meta: { [subscriptionKey]: String(oldId) } } })}\n\n`);
      receipt.traces.push({ method: 'notifications/resources/list_changed', subscriptionId: oldId, injectedRetiredUriId: true });
      await delay(150); assert.equal((await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion, retiredVersion,
        'A retired subscription id must not mutate the replacement generation');
    }
    state[generation].epoch = 2; await notify(generation);
    await waitFor(async () => (await api(`/api/mcp/servers/events-${generation}/status`)).resourceListVersion === retiredVersion + 1, 'replacement generation single update');
    await catalogs(generation, 2); await api(`/api/mcp/servers/events-${generation}`, { disabled: true }, 'PUT');
    if (generation === 'modern') await waitFor(() => streams.size === 0 && bus.listenerCount === 0, 'final stream teardown');
    else await waitFor(() => legacyStreams.size === 0, 'final legacy SSE teardown');
    receipt.groups.push({ generation, catalogUpdates: 2, uriDelivered: true, resourceListVersion: retiredVersion + 1,
      subscriptions: state[generation].subscribes, catalogReads: state[generation].lists, generationRetired: true });
    console.log(JSON.stringify({ subscriptionGroup: receipt.groups.at(-1) }));
  }
  if (wireFailure) throw wireFailure;
  for (const secret of [password, operator.token]) assert.ok(!serverLog.includes(secret), 'Credentials must not enter application logs');
} catch (error) {
  failure = error; let diagnostic = `${error.stack ?? error}\n${serverLog.slice(-5000)}`;
  for (const secret of [password, operator?.token]) if (secret) diagnostic = diagnostic.split(secret).join('[redacted]');
  console.error(diagnostic);
} finally {
  const cleanupErrors = [];
  for (const client of flowClients) try { await client.close(); } catch (error) { cleanupErrors.push(error); }
  if (child?.connected && child.exitCode === null && child.signalCode === null) child.send('stop');
  if (childClosed) try {
    const exit = await Promise.race([childClosed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('App closure timeout; private profile retained'); })]);
    assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); receipt.appClosed = true;
  } catch (error) { cleanupErrors.push(error); }
  for (const session of sessions.values()) try { await session.server.close(); } catch (error) { cleanupErrors.push(error); }
  try { await modern.close(); } catch (error) { cleanupErrors.push(error); }
  for (const server of [reference, model]) try { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
  catch (error) { cleanupErrors.push(error); }
  if (operator && receipt.appClosed) try { await operator.restore(); receipt.privateProfileRemoved = true; } catch (error) { cleanupErrors.push(error); }
  receipt.remainingStreams = streams.size; receipt.remainingLegacyStreams = legacyStreams.size; receipt.remainingBusListeners = bus.listenerCount;
  if (cleanupErrors.length) throw new AggregateError(failure ? [failure, ...cleanupErrors] : cleanupErrors, 'Subscription acceptance cleanup failed');
}
console.log(JSON.stringify({ subscriptionReceipt: { ...receipt, success: !failure, node: process.version, platform: process.platform } }));
if (failure) process.exitCode = 1;
