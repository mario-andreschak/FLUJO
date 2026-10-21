import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { AppSandboxes, appSandboxOrigin, APP_SESSION_COOKIE } from '../dist/app-sandboxes.js';
import { appResponseCookies, appRequestHeaders } from '../dist/app-headers.js';
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
  assert.ok(accepted.headers['content-security-policy'].endsWith(`frame-ancestors ${runtime.origin} ${appSandboxOrigin(runtime, app)}`));
  assert.equal(accepted.headers['origin-agent-cluster'], '?1');
  revoke = true;
  const denied = await send(front);
  assert.equal(denied.status, 401);
  assert.equal(denied.body.includes('proxy document'), false);
  revoke = false; current = true; redirect = true;
  assert.equal((await send(front)).status, 502);
});

test('app cookies authorize only their app and current parent, never a sibling or reserved route', () => {
  const grants = new AppSandboxes(); let current = true;
  const parent = { hash: 'd'.repeat(64), expiresAt: Date.now() + 3600_000 };
  const launch = grants.issue(runtime, discovery, () => current, parent);
  const admitted = grants.admit(requestFor(launch));
  assert.match(admitted.cookie, /; Path=\/; Secure; HttpOnly; SameSite=Strict;/);
  const cookie = admitted.cookie.split(';')[0];
  const request = { method: 'GET', url: '/ide/session/file.js', headers: {
    host: new URL(launch.url).host, cookie, 'sec-fetch-site': 'same-origin',
  } };
  assert.equal(grants.sidecar(request).runtime, runtime);
  const second = grants.admit(requestFor(grants.issue(runtime, discovery, () => current, parent)));
  assert.equal(second.cookie.split(';')[0], cookie, 'Concurrent mounts share an app session, not a one-use ticket');
  for (const headers of [{ cookie: undefined }, { cookie: `${cookie}; ${cookie}` },
    { host: `${app}.bob.localhost:4280` }, { host: 'alice.localhost:4280' },
    { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': undefined },
    { 'sec-fetch-dest': 'serviceworker' }, { 'service-worker': 'script' },
    { origin: runtime.origin }, { origin: 'null' }]) {
    assert.equal(grants.sidecar({ ...request, headers: { ...request.headers, ...headers } }), undefined);
  }
  for (const url of ['/sandbox.html', '/', '/_flujo/runtime/register', '/.well-known/flujo/mcp-app-runtime', '/x/../ide', '/ide%2ffile']) {
    assert.equal(grants.sidecar({ ...request, url }), undefined);
  }
  assert.equal(grants.sidecar({ ...request, method: 'POST' }), undefined);
  assert.ok(grants.sidecar({ ...request, method: 'POST', headers: { ...request.headers, origin: appSandboxOrigin(runtime, app) } }));
  assert.equal(grants.sidecar(request, true), undefined);
  assert.ok(grants.sidecar({ ...request, headers: { ...request.headers, origin: appSandboxOrigin(runtime, app) } }, true));
  const stream = grants.sidecar(request);
  current = false;
  assert.equal(stream.current(), false);
  assert.equal(grants.sidecar(request), undefined);
  assert.equal(new AppSandboxes().sidecar(request), undefined);
});

test('sidecar headers preserve app cookies without leaking or setting controller/sibling cookies', () => {
  const headers = appRequestHeaders({ headers: { cookie: `${APP_SESSION_COOKIE}=private; __Host-flujo-controller=owner; editor=app`,
    'x-flujo-owner': 'alice', 'x-forwarded-host': 'bob', origin: discovery.url, authorization: 'Bearer app-token' } }, appSandboxOrigin(runtime, app));
  assert.equal(headers.cookie, 'editor=app');
  assert.equal(headers.authorization, 'Bearer app-token');
  assert.equal(headers['x-flujo-owner'], undefined);
  assert.equal(headers['x-forwarded-host'], new URL(appSandboxOrigin(runtime, app)).host);
  assert.equal(headers['x-forwarded-proto'], 'https');
  assert.deepEqual(appResponseCookies([`${APP_SESSION_COOKIE}=forged; Secure; Path=/`, '__Host-flujo-controller=forged; Path=/',
    'editor=foreign; Domain=alice.localhost', 'editor=empty; Domain=', 'editor=local; Path=/ide; HttpOnly']),
  ['editor=local; Path=/ide; HttpOnly; Secure']);
});

test('sidecar HTTP carries bodies/app cookies and rejects external redirects', async t => {
  let observed; let redirect = false;
  const upstream = await listen(createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      observed = { headers: request.headers, body: Buffer.concat(chunks).toString(), path: request.url };
      response.writeHead(redirect ? 302 : 200, { 'Content-Type': 'application/javascript',
        'Set-Cookie': ['editor=local; Path=/ide', `${APP_SESSION_COOKIE}=forged; Secure; Path=/`],
        ...(redirect ? { Location: 'https://other.example/file.js' } : {}) });
      response.end('sidecar asset');
    });
  }), t);
  const front = await listen(createServer((request, response) => proxy(request, response, {
    runtime, current: () => true, finished: () => {}, connect: () => createConnection({ host: '127.0.0.1', port: upstream }),
    sandbox: { sidecar: true, origin: appSandboxOrigin(runtime, app), path: '/ide/session/asset.js' },
  })), t);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: front, method: 'POST', headers: {
      'content-type': 'text/plain', cookie: `${APP_SESSION_COOKIE}=private; editor=app`, origin: appSandboxOrigin(runtime, app),
    } }, response => {
      response.resume(); response.once('end', () => resolve(response));
    });
    request.once('error', reject); request.end('file contents');
  });
  assert.equal(result.statusCode, 200);
  assert.equal(observed.body, 'file contents');
  assert.equal(observed.path, '/ide/session/asset.js');
  assert.equal(observed.headers.cookie, 'editor=app');
  assert.equal(observed.headers.authorization, undefined);
  assert.deepEqual(result.headers['set-cookie'], ['editor=local; Path=/ide; Secure']);
  redirect = true;
  assert.equal((await send(front)).status, 502);
});
