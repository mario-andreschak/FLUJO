import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { Ledger } from '../dist/ledger.js';
import { createController } from '../dist/server.js';
import { ensureLocalTLS, localTLSRoot } from '../dist/local-tls.js';
import { localExecutable } from '../dist/local-executable.js';
import { privateFixture } from './private-fixture.mjs';

test('local HTTPS discovery, app cookies, sidecar routes and shutdown share current parent authority', { timeout: 180_000 }, async t => {
  const { directory, close } = privateFixture(t);
  const app = `app${'a'.repeat(60)}`; const origin = 'https://alice.localhost:4280';
  const appOrigin = `https://${app}.alice.localhost:4280`;
  const generation = 'a'.repeat(32);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory,
    tls: { directory: join(directory, 'tls'), executable: localExecutable('openssl') }, runtimes: [{
      id: 'alice', actorId: 'alice', origin, upstream: 'http://127.0.0.1:4200', credential: `flo_v1_${'a'.repeat(43)}`,
      isolationId: `local-docker:${'a'.repeat(64)}`, localRuntime: { kind: 'local-docker', executable: process.execPath,
        daemon: 'unix:///tmp/fixture.sock', imageId: `sha256:${'a'.repeat(64)}`, containerId: 'a'.repeat(64), generation,
        dataVolume: `flujo-owner-${generation}-data`, homeVolume: `flujo-owner-${generation}-home`,
        authorityVolume: `flujo-owner-${generation}-authority`, credentialExpiresAt: Date.now() + 3600_000,
        memoryMiB: 1024, cpus: 1, pidsLimit: 256 } }] });
  const runtime = config.runtimes[0]; const sockets = new Set();
  let controller; let ledger; let refresh;
  const channels = []; const appCalls = [];
  const application = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ originKey: app, url: `${appOrigin}/sandbox.html`, token: 'b'.repeat(43),
      port: 4201, shared: false, allowAll: false }));
  });
  const sandbox = createServer((request, response) => {
    appCalls.push({ path: request.url, headers: request.headers });
    response.writeHead(200, request.url.startsWith('/sandbox.html?') ? {
      'Content-Type': 'text/html', 'Content-Security-Policy': `default-src 'none'; frame-ancestors ${origin}`,
    } : { 'Content-Type': 'text/plain' });
    response.end('app content');
  });
  sandbox.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  close.push(async () => {
    clearInterval(refresh); sockets.forEach(socket => socket.destroy());
    if (controller?.listening) await new Promise(resolve => { controller.close(resolve); controller.closeAllConnections(); });
    await controller?.stopTLS(); ledger?.close();
    await Promise.all([application, sandbox].map(server => new Promise(resolve => server.close(resolve))));
  });
  for (const server of [application, sandbox]) {
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  await ensureLocalTLS(config, { initialize: true });
  ledger = new Ledger(directory);
  controller = await createController(config, ledger, (_runtime, channel = 'application') => {
    channels.push(channel);
    return createConnection({ host: '127.0.0.1', port: (channel === 'sandbox' ? sandbox : application).address().port });
  });
  // Explicitly simulated runtime observations: this tests real TLS/SQLite/HTTP,
  // not actual installed container or process isolation.
  for (const intent of ledger.intents()) ledger.observeRuntime(intent);
  refresh = setInterval(() => { for (const intent of ledger.intents()) ledger.observeRuntime(intent); }, 5000);
  await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
  const ca = localTLSRoot(config).certificate.raw;
  const request = (host, path, headers = {}) => new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', servername: host, port: controller.address().port, ca,
      path, headers: { host: `${host}:4280`, ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.once('error', reject); req.end();
  });
  const password = 'local app controller fixture password';
  const revision = runtimeRevision(config, runtime); await ledger.setPassword(runtime, revision, password);
  const token = await ledger.authenticate(runtime, revision, password, 3600); assert.ok(token);
  const discovered = await request('alice.localhost', '/api/mcp/app-sandbox?serverName=fixture&uri=ui%3A%2F%2Ffixture', {
    cookie: `__Host-flujo-controller=${token}`, 'sec-fetch-site': 'same-origin',
  });
  assert.equal(discovered.status, 200); const launch = JSON.parse(discovered.body);
  const appHost = new URL(launch.url).hostname;
  const document = await request(appHost, `/sandbox.html?token=${launch.token}`, {
    referer: `${origin}/`, 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate',
  });
  assert.equal(document.status, 200);
  const appCookie = document.headers['set-cookie'][0].split(';')[0];
  assert.match(appCookie, /^__Host-flujo-app=/);
  assert.equal((await request(appHost, '/ide/file', { cookie: appCookie, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await request('alice.localhost', '/api/workspaces', { cookie: appCookie, 'sec-fetch-site': 'same-origin' })).status, 401);
  assert.equal((await request(appHost, '/_flujo/runtime/register', { cookie: appCookie, 'sec-fetch-site': 'same-origin' })).status, 421);
  assert.deepEqual(channels, ['application', 'sandbox', 'sandbox']);
  assert.equal(appCalls[1].headers.cookie, undefined);
  assert.equal(appCalls[1].headers.authorization, undefined);
  const peer = await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', servername: appHost, port: controller.address().port, ca,
      path: '/ide/socket', headers: { host: `${appHost}:4280`, origin: appOrigin, cookie: appCookie,
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 3).toString('base64') } });
    req.once('upgrade', (_response, socket) => { socket.on('error', () => {}); resolve(socket); });
    req.once('error', reject); req.end();
  });
  const disconnected = new Promise(resolve => peer.once('close', resolve)); peer.resume();
  const stopped = new Promise(resolve => { controller.close(resolve); controller.closeAllConnections(); });
  await Promise.all([stopped, disconnected]);
});
