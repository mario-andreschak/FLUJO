import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createWorkerPhoneHost } from './worker-phone-host.mjs';

const config = { password: 'p'.repeat(40), workerToken: 'w'.repeat(40),
  voiceGrant: 'flo_v1_' + 'v'.repeat(43), workspace: 'fixture-workspace' };
const authorization = 'Basic ' + Buffer.from('operator:' + config.password).toString('base64');
async function fixture(t, options = {}) {
  const received = [];
  let closed;
  const streamClosed = new Promise(resolve => { closed = resolve; });
  const upstream = http.createServer((req, res) => {
    const row = { path: req.url, method: req.method, headers: req.headers, body: '' };
    received.push(row);
    req.on('data', chunk => { row.body += chunk; });
    req.on('end', () => {
      if (options.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: voice-started\n\n');
        res.on('close', closed);
        return;
      }
      res.writeHead(options.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const phone = createWorkerPhoneHost({ ...config, ...options.config }, {
    upstreamPort: upstream.address().port, publicOrigin: 'https://phone.example',
  });
  phone.listen(0, '127.0.0.1'); await once(phone, 'listening');
  t.after(() => { phone.closeAllConnections(); upstream.closeAllConnections(); phone.close(); upstream.close(); });
  const url = 'http://127.0.0.1:' + phone.address().port;
  const request = (path, init = {}) => fetch(url + path, { ...init,
    headers: { authorization, ...init.headers } });
  const response = await request('/phone/session');
  return { received, request, session: await response.json(), response, streamClosed, url };
}

test('bootstrap is private, same-origin, bounded to public session facts and not cached', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/phone/session', { headers: { authorization: '' } })).status, 401);
  assert.equal((await f.request('/world', { headers: { authorization: '' } })).status, 401);
  assert.equal((await f.request('/phone/session', { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.request('/phone/session', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.request('/phone/session', { method: 'POST' })).status, 405);
  assert.deepEqual(Object.keys(f.session).sort(), ['csrf', 'nativeWorkspace', 'voiceScopeKey']);
  assert.equal(f.session.nativeWorkspace, config.workspace);
  assert.match(f.session.csrf, /^[a-f0-9]{64}$/);
  assert.equal(f.response.headers.get('cache-control'), 'no-store');
  for (const secret of [config.password, config.workerToken, config.voiceGrant]) assert.ok(!JSON.stringify(f.session).includes(secret));
  assert.equal(f.received.length, 0);
});

test('every fixed phone voice action reaches the existing remote worker route with two private capabilities', async t => {
  const f = await fixture(t);
  const actions = ['availability', 'native-turn', 'native-input', 'native-observe', 'native-played', 'native-reset', 'native-result', 'native-result-receipt'];
  for (const action of actions) {
    const method = action === 'availability' ? 'GET' : 'POST';
    const response = await f.request('/phone/voice/' + action, { method,
      ...(method === 'POST' ? { body: '{}' } : {}),
      headers: { 'x-phone-csrf': f.session.csrf, origin: 'https://phone.example',
        'x-flujo-avatar-client': '12345678-1234-1234-1234-123456789012',
        'x-flujo-avatar-authorization': 'Bearer caller-supplied', 'proxy-authorization': 'caller-supplied' } });
    assert.equal(response.status, 200);
    const row = f.received.at(-1);
    assert.equal(row.path, '/api/avatar/remote/' + action);
    assert.equal(row.method, method);
    assert.equal(row.headers.authorization, 'Bearer ' + config.workerToken);
    assert.equal(row.headers['x-flujo-avatar-authorization'], 'Bearer ' + config.voiceGrant);
    assert.equal(row.headers['x-flujo-workspace'], config.workspace);
    assert.equal(row.headers.origin, 'http://localhost:4200');
    assert.equal(row.headers['proxy-authorization'], undefined);
    assert.equal(row.headers['x-phone-csrf'], undefined);
  }
});

test('invalid CSRF, workspace, origin, method and unknown voice routes never reach the worker', async t => {
  const f = await fixture(t);
  const voice = '/phone/voice/native-reset';
  const admitted = { 'x-phone-csrf': f.session.csrf };
  assert.equal((await f.request(voice, { method: 'POST' })).status, 403);
  assert.equal((await f.request(voice, { method: 'POST', headers: { 'x-phone-csrf': 'wrong' } })).status, 403);
  assert.equal((await f.request(voice + '?workspace=other', { method: 'POST', headers: admitted })).status, 403);
  assert.equal((await f.request(voice, { method: 'POST', headers: { ...admitted, 'x-flujo-workspace': 'other' } })).status, 403);
  assert.equal((await f.request(voice, { method: 'POST', headers: { ...admitted, origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.request(voice, { method: 'POST', headers: { ...admitted, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await f.request(voice, { headers: admitted })).status, 405);
  assert.equal((await f.request('/phone/voice/availability', { method: 'POST', headers: admitted })).status, 405);
  assert.equal((await f.request('/phone/voice/unknown', { method: 'POST', headers: admitted })).status, 404);
  assert.equal((await f.request('/phone/unknown')).status, 404);
  assert.equal(f.received.length, 0);
});

test('native API and v1 writes keep CSRF and workspace fences without forwarding a browser voice grant', async t => {
  const f = await fixture(t);
  for (const path of ['/api/example', '/v1/example']) {
    assert.equal((await f.request(path, { method: 'POST' })).status, 403);
    assert.equal((await f.request(path + '?workspace=other')).status, 403);
    assert.equal((await f.request(path + '?workspace=fixture-workspace&workspace=fixture-workspace')).status, 403);
    assert.equal((await f.request(path, { method: 'POST', headers: { 'x-phone-csrf': f.session.csrf, 'x-flujo-workspace': 'other' } })).status, 403);
    const response = await f.request(path, { method: 'POST', headers: {
      'x-phone-csrf': f.session.csrf, 'x-flujo-workspace': config.workspace, 'x-flujo-avatar-authorization': 'Bearer caller-supplied' } });
    assert.equal(response.status, 200);
    assert.equal(f.received.at(-1).headers['x-flujo-avatar-authorization'], undefined);
  }
});

test('a worker revocation reaches the phone unchanged', async t => {
  const f = await fixture(t, { status: 403 });
  assert.equal((await f.request('/phone/voice/availability', { headers: { 'x-phone-csrf': f.session.csrf } })).status, 403);
});

test('missing private voice admission leaves native World usable and makes no voice call', async t => {
  const f = await fixture(t, { config: { voiceGrant: undefined } });
  assert.equal((await f.request('/phone/voice/availability', { headers: { 'x-phone-csrf': f.session.csrf } })).status, 503);
  assert.equal(f.received.length, 0);
  assert.equal((await f.request('/world')).status, 200);
});

test('host restart rotates the phone lifetime and rejects the old CSRF', async t => {
  const first = await fixture(t), second = await fixture(t);
  assert.notEqual(first.session.voiceScopeKey, second.session.voiceScopeKey);
  assert.notEqual(first.session.csrf, second.session.csrf);
  assert.equal((await second.request('/phone/voice/availability', { headers: { 'x-phone-csrf': first.session.csrf } })).status, 403);
});

test('invalid private configuration and non-loopback worker origins are rejected', () => {
  assert.throws(() => createWorkerPhoneHost({ ...config, voiceGrant: '\r\ninjected' }));
  assert.throws(() => createWorkerPhoneHost({ ...config, workspace: '../other' }));
  assert.throws(() => createWorkerPhoneHost(config, { workerOrigin: 'https://other.example' }));
  assert.throws(() => createWorkerPhoneHost(config, { publicOrigin: 'http://other.example' }));
});

test('stopping a phone voice stream closes the upstream request', async t => {
  const f = await fixture(t, { stream: true });
  const controller = new AbortController();
  const response = await f.request('/phone/voice/native-turn', { method: 'POST', body: '{}', signal: controller.signal,
    headers: { 'x-phone-csrf': f.session.csrf } });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.byteLength > 0);
  controller.abort();
  await Promise.race([f.streamClosed, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream stream did not stop')), 2000);
    f.streamClosed.then(() => clearTimeout(timer));
  })]);
  await reader.cancel().catch(() => {});
});

test('public phone requests cannot bypass the private voice grant through native or encoded aliases', async t => {
  const f = await fixture(t, { config: { voiceGrant: undefined } });
  for (const path of ['/api/avatar/voice', '/api/avatar/native-turn', '/api/avatar/remote/native-turn',
    '/api/avatar/pocket-speech', '/api/%61vatar/%6eative-turn']) {
    assert.equal((await f.request(path, { method: 'POST', body: '{}', headers: {
      'x-phone-csrf': f.session.csrf, 'x-flujo-workspace': config.workspace } })).status, 403);
  }
  assert.equal(f.received.length, 0);
  assert.equal((await f.request('/api/avatar/connections?workspace=' + config.workspace)).status, 200);
});

test('upgrade requests cannot bypass voice admission or native write CSRF', async t => {
  const f = await fixture(t);
  const upgrade = (path, method = 'GET') => new Promise((resolve, reject) => {
    const request = http.request(f.url + path, { method, headers: { authorization,
      connection: 'Upgrade', upgrade: 'websocket', origin: 'https://phone.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(await upgrade('/api/avatar/native-turn'), 403);
  assert.equal(await upgrade('/api/%61vatar/native-turn'), 403);
  assert.equal(await upgrade('/phone/voice/native-turn'), 403);
  assert.equal(await upgrade('/api/example', 'POST'), 405);
  assert.equal(f.received.length, 0);
});
