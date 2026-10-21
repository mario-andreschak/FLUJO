import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { AppSandboxes, appSandboxOrigin } from '../dist/app-sandboxes.js';
import { proxy } from '../dist/proxy.js';

const app = `app${'a'.repeat(60)}`;
const runtime = { id: 'alice', origin: 'https://alice.localhost:4280', upstream: 'http://127.0.0.1:4200',
  localRuntime: { containerId: 'fixture' }, credential: 'private-owner-authority' };
const discovery = { originKey: app, token: 'b'.repeat(43), url: `${appSandboxOrigin(runtime, app)}/sandbox.html`,
  port: 4201, shared: false, allowAll: false };
function requestFor(launch, overrides = {}) {
  return { method: 'GET', url: `/sandbox.html?token=${launch.token}`, headers: {
    host: new URL(launch.url).host, referer: `${runtime.origin}/`,
    'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', ...overrides,
  } };
}

test('verified app launch binds owner, app, parent session and one-time ticket', () => {
  const launches = new AppSandboxes(); let current = true;
  const launch = launches.issue(runtime, discovery, () => current);
  assert.notEqual(launch.token, discovery.token);
  assert.equal(launch.reusable, false);
  assert.notEqual(appSandboxOrigin(runtime, app), appSandboxOrigin({ ...runtime, origin: 'https://bob.localhost:4280' }, app));
  for (const headers of [
    { host: `${app}.bob.localhost:4280` }, { host: `app${'c'.repeat(60)}.alice.localhost:4280` },
    { host: 'alice.localhost:4280' }, { referer: 'https://bob.localhost:4280/' }, { referer: undefined },
    { 'sec-fetch-dest': 'document' }, { 'sec-fetch-mode': 'cors' }, { origin: 'https://evil.example' },
    { 'content-length': '1' }, { 'transfer-encoding': 'chunked' },
  ]) assert.equal(launches.admit(requestFor(launch, headers)), undefined);
  for (const path of ['/api/workspaces', '/_flujo/runtime/register', '//sandbox.html', '/x/../sandbox.html']) {
    assert.equal(launches.admit({ ...requestFor(launch), url: `${path}?token=${launch.token}` }), undefined);
  }
  const accepted = launches.admit(requestFor(launch));
  assert.equal(accepted.runtime, runtime);
  assert.equal(new URL(accepted.path, runtime.origin).searchParams.get('token'), discovery.token);
  assert.equal(launches.admit(requestFor(launch)), undefined);
  const revoked = launches.issue(runtime, discovery, () => current);
  current = false;
  assert.equal(launches.admit(requestFor(revoked)), undefined);
  assert.throws(() => launches.issue(runtime, discovery, () => current));
});

test('tickets expire, fail closed after restart and bound pending launch allocation', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const launches = new AppSandboxes();
  const launch = launches.issue(runtime, discovery, () => true);
  assert.equal(new AppSandboxes().admit(requestFor(launch)), undefined);
  t.mock.timers.tick(60_001);
  assert.equal(launches.admit(requestFor(launch)), undefined);
  for (let i = 0; i < 64; i++) launches.issue(runtime, discovery, () => true);
  assert.throws(() => launches.issue(runtime, discovery, () => true));
  t.mock.timers.tick(60_001);
  assert.doesNotThrow(() => launches.issue(runtime, discovery, () => true));
  for (const patch of [{ port: 80 }, { url: 'https://evil.example/sandbox.html' }, { shared: true },
    { allowAll: true }, { token: 'invalid' }, { originKey: 'alice' }]) {
    assert.throws(() => launches.issue(runtime, { ...discovery, ...patch }, () => true));
  }
});

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}
function send(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end();
  });
}

test('discovery response replacement hides runtime tokens and rejects invalid/oversized JSON', async t => {
  let body = JSON.stringify(discovery); let current = true;
  const upstream = await listen(createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=private' }); response.end(body);
  }), t);
  const launches = new AppSandboxes();
  const front = await listen(createServer((request, response) => proxy(request, response, {
    runtime, current: () => current, finished: () => {}, connect: () => createConnection({ host: '127.0.0.1', port: upstream }),
    rewriteJson: value => launches.issue(runtime, value, () => current),
  })), t);
  const accepted = await send(front);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.includes(discovery.token), false);
  assert.equal(accepted.headers['set-cookie'], undefined);
  assert.equal(accepted.headers['cache-control'], 'no-store');
  current = false;
  assert.equal(launches.admit(requestFor(JSON.parse(accepted.body))), undefined);
  current = true;
  for (const invalid of ['{}', 'not JSON', JSON.stringify({ ...discovery, padding: 'x'.repeat(70_000) })]) {
    body = invalid; assert.equal((await send(front)).status, 502);
  }
});

test('sandbox channel strips owner/browser secrets and preserves CSP with exact owner embedding', async t => {
  let observed; let current = true; let revoke = false; let redirect = false;
  const upstream = await listen(createServer((request, response) => {
    observed = { headers: request.headers, path: request.url };
    response.writeHead(redirect ? 302 : 200, { 'Content-Type': 'text/html',
      'Content-Security-Policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-ancestors *",
      'Set-Cookie': 'upstream=private', 'Access-Control-Allow-Origin': '*', ...(redirect ? { Location: 'https://evil.example' } : {}) });
    if (revoke) current = false;
    response.end('<html>proxy document</html>');
  }), t);
  const front = await listen(createServer((request, response) => proxy(request, response, {
    runtime, current: () => current, finished: () => {}, connect: () => createConnection({ host: '127.0.0.1', port: upstream }),
    sandbox: { origin: appSandboxOrigin(runtime, app), path: `/sandbox.html?token=${discovery.token}` },
  })), t);
  const accepted = await send(front, { authorization: 'Bearer browser-secret', cookie: 'owner-cookie',
    'x-flujo-controller-account': '1', 'x-forwarded-host': 'evil.example' });
  assert.equal(accepted.status, 200);
  assert.equal(observed.headers.host, `${app}.alice.localhost:4280`);
  assert.equal(observed.headers.referer, `${runtime.origin}/`);
  for (const key of ['authorization', 'cookie', 'x-flujo-controller-account', 'x-forwarded-host']) assert.equal(observed.headers[key], undefined);
  assert.equal(accepted.headers['x-frame-options'], undefined);
  assert.equal(accepted.headers['set-cookie'], undefined);
  assert.equal(accepted.headers['access-control-allow-origin'], undefined);
  assert.match(accepted.headers['content-security-policy'], /script-src 'self' 'unsafe-inline'/);
  assert.equal(accepted.headers['content-security-policy'].includes('frame-ancestors *'), false);
  assert.match(accepted.headers['content-security-policy'], /frame-ancestors https:\/\/alice.localhost:4280$/);
  assert.equal(accepted.headers['origin-agent-cluster'], '?1');
  revoke = true;
  const denied = await send(front);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.includes('proxy document'), false);
  revoke = false; current = true; redirect = true;
  assert.equal((await send(front)).status, 502);
});
