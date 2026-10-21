import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { proxy } from '../dist/proxy.js';

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

function send(port, headers = {}, path = '/api/workspaces', method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('proxy injects only the selected runtime authority and strips browser/downstream cookies', async t => {
  let observed;
  const backend = createServer((request, response) => {
    observed = { headers: request.headers, path: request.url };
    response.writeHead(200, { 'Set-Cookie': 'stolen=runtime-cookie', 'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' });
    response.end('{"owned":true}');
  });
  const port = await listen(backend, t);
  const runtime = { origin: 'https://alice.example', upstream: `http://127.0.0.1:${port}`,
    credential: `flo_v1_${'a'.repeat(43)}` };
  let finished = 0;
  const controller = createServer((request, response) => proxy(request, response, {
    runtime, current: () => true, finished: () => { finished++; },
  }));
  const front = await listen(controller, t);
  const result = await send(front, { authorization: 'Bearer attacker', cookie: 'private-browser-session=value',
    origin: runtime.origin, 'x-forwarded-host': 'bob.example', 'x-user-id': 'bob',
    'x-flujo-owner': 'bob', 'x-workspace-id': 'workspace-inside-alice' }, '/api/workspaces?user=bob');
  assert.equal(result.status, 200);
  assert.equal(observed.headers.authorization, `Bearer ${runtime.credential}`);
  assert.equal(observed.headers.host, 'alice.example');
  assert.equal(observed.headers.origin, runtime.origin);
  assert.equal(observed.headers.cookie, undefined);
  assert.equal(observed.headers['x-forwarded-host'], undefined);
  assert.equal(observed.headers['x-user-id'], undefined);
  assert.equal(observed.headers['x-flujo-owner'], undefined);
  assert.equal(observed.headers['x-workspace-id'], 'workspace-inside-alice');
  assert.equal(observed.path, '/api/workspaces?user=bob');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.body, '{"owned":true}');
  assert.equal(finished, 1);
});

test('revoked requests and oversized uploads are refused before contacting a private runtime', async t => {
  let called = 0;
  const backend = createServer((_request, response) => { called++; response.end(); });
  const port = await listen(backend, t);
  let current = false;
  const controller = createServer((request, response) => proxy(request, response, {
    runtime: { origin: 'https://alice.example', upstream: `http://127.0.0.1:${port}`, credential: 'private' },
    current: () => current, finished: () => {},
  }));
  const front = await listen(controller, t);
  assert.equal((await send(front)).status, 401);
  current = true;
  assert.equal((await send(front, { 'Content-Length': String(65 * 1024 * 1024) }, '/', 'POST')).status, 413);
  assert.equal(called, 0);
});

test('current authority is checked again before an awaited upstream response is disclosed', async t => {
  let current = true;
  const backend = createServer((_request, response) => {
    current = false;
    response.end('private response must not escape');
  });
  const port = await listen(backend, t);
  const controller = createServer((request, response) => proxy(request, response, {
    runtime: { origin: 'https://alice.example', upstream: `http://127.0.0.1:${port}`, credential: 'private' },
    current: () => current, finished: () => {},
  }));
  const front = await listen(controller, t);
  const result = await send(front);
  assert.equal(result.status, 401);
  assert.equal(result.body.includes('private response must not escape'), false);
});

test('an unavailable runtime returns a generic error without exposing its endpoint or bearer', async t => {
  const unused = createServer();
  await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
  const port = unused.address().port;
  await new Promise(resolve => unused.close(resolve));
  const controller = createServer((request, response) => proxy(request, response, {
    runtime: { origin: 'https://alice.example', upstream: `http://127.0.0.1:${port}`, credential: 'private-secret' },
    current: () => true, finished: () => {},
  }));
  const front = await listen(controller, t);
  const result = await send(front);
  assert.equal(result.status, 502);
  assert.equal(result.body.includes('private-secret'), false);
  assert.equal(result.body.includes('127.0.0.1'), false);
});

test('revoking an established stream closes its upstream and downstream connections', async t => {
  let current = true;
  let finished = 0;
  let backendClosed;
  const closed = new Promise(resolve => { backendClosed = resolve; });
  const backend = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: first\n\n');
    response.on('close', backendClosed);
  });
  const port = await listen(backend, t);
  const controller = createServer((request, response) => proxy(request, response, {
    runtime: { origin: 'https://alice.example', upstream: `http://127.0.0.1:${port}`, credential: 'private' },
    current: () => current, finished: () => { finished++; },
  }));
  const front = await listen(controller, t);
  const request = httpRequest({ host: '127.0.0.1', port: front });
  request.end();
  const [response] = await once(request, 'response');
  response.on('error', () => {});
  await once(response, 'data');
  const disconnected = new Promise(resolve => response.once('close', resolve));
  current = false;
  await disconnected;
  await closed;
  assert.equal(finished, 1);
});
