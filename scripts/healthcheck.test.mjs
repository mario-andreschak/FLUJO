import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkHealth } from './healthcheck.mjs';

const json = (body, status = 200) => Response.json(body, { status });

test('normal readiness sends only the configured owner bearer to loopback', async () => {
  let calls = 0;
  assert.equal(await checkHealth({ env: { FLUJO_HEALTHCHECK_TOKEN: ' synthetic-owner-token ' }, request: async (url, options) => {
    calls++;
    assert.equal(url, 'http://127.0.0.1:4200/api/cwd');
    assert.deepEqual(options.headers, { authorization: 'Bearer synthetic-owner-token' });
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return json({ success: true });
  } }), true);
  assert.equal(calls, 1);
});

test('legacy normal probe remains anonymous and cannot consume worker authority', async () => {
  assert.equal(await checkHealth({ env: { FLUJO_SNAPSHOT_CONTROL_TOKEN: 'worker-token' }, request: async (_, options) => {
    assert.equal(options.headers, undefined);
    return json({ success: true });
  } }), true);
});

test('worker authority takes precedence and only ready worker JSON succeeds', async () => {
  for (const [body, ready] of [[{ mode: 'worker', state: 'ready' }, true], [{ mode: 'local', state: 'ready' }, false],
    [{ mode: 'worker', state: 'restoring' }, false], [{ mode: 'worker', state: 'locked' }, false], [{ success: true }, false]]) {
    assert.equal(await checkHealth({ env: { FLUJO_WORKER_MODE: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'worker-token',
      FLUJO_HEALTHCHECK_TOKEN: 'owner-token', FLUJO_PORT: '7100' }, request: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:7100/api/worker/status');
      assert.equal(options.headers.authorization, 'Bearer worker-token');
      return json(body);
    } }), ready);
  }
});

test('missing worker authority and malformed explicit credentials fail before contacting a service', async () => {
  for (const env of [{ FLUJO_WORKER_MODE: '1', FLUJO_HEALTHCHECK_TOKEN: 'owner-token' },
    ...['', ' ', 'a b', 'a\nb', 'a\rb', '\u00e9', 42].map(value => ({ FLUJO_HEALTHCHECK_TOKEN: value }))]) {
    assert.equal(await checkHealth({ env, request: () => assert.fail('Invalid credential reached HTTP') }), false);
  }
});

test('a malformed explicit port cannot fall back to an unrelated service', async () => {
  for (const port of ['', ' ', '-1', '0', '65536', '100000', '4.2', '4e3', '0x1068', '4200/path', '4200 ', 4200]) {
    assert.equal(await checkHealth({ env: { FLUJO_PORT: port }, request: () => assert.fail('Invalid port reached HTTP') }), false);
  }
  for (const port of ['1', '65535']) {
    assert.equal(await checkHealth({ env: { FLUJO_PORT: port }, request: async url => {
      assert.equal(url, `http://127.0.0.1:${port}/api/cwd`);
      return json({ success: true });
    } }), true);
  }
});

test('normal readiness requires successful API JSON, not merely a 200 response', async () => {
  for (const body of [{}, { success: false }, { success: 'true' }, null, [], { mode: 'worker', state: 'ready' }]) {
    assert.equal(await checkHealth({ env: {}, request: async () => json(body) }), false);
  }
  for (const status of [401, 403, 423, 503]) {
    assert.equal(await checkHealth({ env: {}, request: async () => json({ success: true }, status) }), false);
  }
  assert.equal(await checkHealth({ env: {}, request: async () => new Response('<html>Login</html>') }), false);
  assert.equal(await checkHealth({ env: {}, request: async () => { throw new Error('Private diagnostic'); } }), false);
});

test('real HTTP redirects never receive a probe bearer and never count as ready', async t => {
  let redirectedRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/cwd') {
      res.writeHead(302, { Location: '/login' }); res.end();
    } else { redirectedRequests++; res.end(JSON.stringify({ success: true })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(await checkHealth({ env: { FLUJO_PORT: String(server.address().port), FLUJO_HEALTHCHECK_TOKEN: 'synthetic-owner-token' } }), false);
  assert.equal(redirectedRequests, 0);
});

test('CLI reports only an exit code, without printing credentials or server errors', async t => {
  const secret = 'synthetic-private-health-token';
  let status = 401;
  const server = createServer((_, res) => { res.writeHead(status); res.end(status === 200 ? JSON.stringify({ success: true }) : `Rejected ${secret}`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (status of [401, 200, 423]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./healthcheck.mjs', import.meta.url))], {
      env: { ...process.env, FLUJO_WORKER_MODE: '0', FLUJO_PORT: String(server.address().port), FLUJO_HEALTHCHECK_TOKEN: secret },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, status === 200 ? 0 : 1);
    assert.equal(output, '');
  }
});

test('the request deadline covers a response body that never finishes', { timeout: 8_000 }, async t => {
  const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"success":'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(await checkHealth({ env: { FLUJO_PORT: String(server.address().port) } }), false);
});
