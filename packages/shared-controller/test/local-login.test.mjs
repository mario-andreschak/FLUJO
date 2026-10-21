import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request as httpRequest, createServer } from 'node:http';
import { privateFixture } from './private-fixture.mjs';
import { configSchema, runtimeRevision } from '../dist/config.js';
import { Ledger } from '../dist/ledger.js';
import { createController } from '../dist/server.js';
import { readPasswordForm, SESSION_COOKIE } from '../dist/http.js';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

function send(port, { path = '/_account/login', method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject); request.end(body);
  });
}

test('password form decoding rejects duplicate fields, malformed UTF-8, encoding and oversize input', async t => {
  const port = await listen(createServer(async (request, response) => {
    const password = await readPasswordForm(request);
    response.writeHead(password === null ? 400 : 204); response.end();
  }), t);
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  assert.equal((await send(port, { headers, body: 'password=a+local+passphrase' })).status, 204);
  for (const body of ['password=a&password=b', 'password=a&username=alice', 'password=%FF', 'password=%xx',
    'password=' + 'a'.repeat(8192), Buffer.from([0xff])]) {
    assert.equal((await send(port, { headers, body })).status, 400);
  }
  assert.equal((await send(port, { headers: { ...headers, 'content-encoding': 'gzip' }, body: 'password=a' })).status, 400);
});

test('local sign-in, private dispatch, recovery and logout require no online identity', async t => {
  const { directory, close } = privateFixture(t);
  const ledger = new Ledger(directory);
  close.push(() => ledger.close());
  let forwarded = 0;
  const upstreamPort = await listen(createServer((_request, response) => { forwarded++; response.end('alice private data'); }), t);
  const config = configSchema.parse({ schemaVersion: 2, stateDirectory: directory, runtimes: [
    { id: 'alice-runtime', actorId: 'alice', origin: 'https://alice.localhost', upstream: `http://127.0.0.1:${upstreamPort}`,
      isolationId: 'local-alice', credential: `flo_v1_${'a'.repeat(43)}` },
    { id: 'bob-runtime', actorId: 'bob', origin: 'https://bob.localhost', upstream: 'http://127.0.0.1:4212',
      isolationId: 'local-bob', credential: `flo_v1_${'b'.repeat(43)}` },
  ] });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network disabled'); });
  const front = await listen(await createController(config, ledger), t);
  const alice = config.runtimes[0];
  const headers = { host: 'alice.localhost', origin: alice.origin, 'content-type': 'application/x-www-form-urlencoded' };
  const password = 'local fixture secret passphrase';
  const body = new URLSearchParams({ password }).toString();
  assert.equal((await send(front, { headers, body })).status, 401);
  await ledger.setPassword(alice, runtimeRevision(config, alice), password);
  assert.equal((await send(front, { headers: { ...headers, origin: 'https://bob.localhost' }, body })).status, 403);
  assert.equal((await send(front, { headers: { ...headers, host: 'unknown.localhost' }, body })).status, 421);
  const login = await send(front, { headers, body });
  assert.equal(login.status, 303);
  assert.equal(login.headers.location, '/');
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(setCookie.startsWith(`${SESSION_COOKIE}=`));
  assert.equal(setCookie.includes(password), false);
  const cookie = setCookie.split(';')[0];
  assert.equal((await send(front, { method: 'GET', path: '/api/workspaces', headers: { ...headers, cookie } })).body, 'alice private data');
  assert.equal(forwarded, 1);
  assert.equal((await send(front, { method: 'GET', path: '/api/workspaces',
    headers: { host: 'bob.localhost', origin: 'https://bob.localhost', cookie } })).status, 401);
  assert.equal(forwarded, 1);
  assert.equal((await send(front, { path: '/_account/logout', headers: { ...headers, cookie } })).status, 303);
  assert.equal((await send(front, { method: 'GET', path: '/api/workspaces', headers: { ...headers, cookie } })).status, 401);
  const second = await send(front, { headers, body });
  const oldCookie = second.headers['set-cookie'][0].split(';')[0];
  await ledger.setPassword(alice, runtimeRevision(config, alice), 'replacement local test password');
  assert.equal((await send(front, { method: 'GET', path: '/api/workspaces', headers: { ...headers, cookie: oldCookie } })).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
