import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readSubscriptionAllowance, parseAllowanceArguments, validateAllowanceBaseUrl, projectSubscriptionAllowance } from './subscription-allowance.mjs';

function source(now = Date.now()) {
  return { observedAt: new Date(now).toISOString(), models: [{ modelId: 'codex-model', provider: 'codex', accountGroup: 'a'.repeat(64),
    status: 'available', observedAt: new Date(now).toISOString(), source: 'codex-app-server', windows: [
      { id: 'codex:primary', label: 'Five hours', remainingPercent: 75, resetAt: new Date(now + 3600000).toISOString() },
      { id: 'codex:secondary', label: 'Weekly', remainingPercent: null, resetAt: null },
    ] }], entities: { flows: { flow1: ['codex-model'] }, personas: {} } };
}
async function fixture(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, accept: request.headers.accept });
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
const json = (response, body) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };

test('real authenticated GET projects only known metadata, preserves unknown windows, and never refreshes', async t => {
  const input = source(); input.secret = 'SECRET_CREDENTIAL'; input.models[0].accountId = 'SECRET_ACCOUNT'; input.models[0].windows[0].providerError = 'SECRET_NATIVE_STDERR';
  const { requests, baseUrl } = await fixture(t, (_request, response) => json(response, input));
  const result = await readSubscriptionAllowance({ baseUrl, workspace: 'workspace-a', token: 'synthetic-owner-token' });
  assert.equal(result.models[0].windows[0].remainingPercent, 75);
  assert.equal(result.models[0].windows[1].remainingPercent, null);
  assert.deepEqual(result.entities, input.entities);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_|synthetic-owner-token/);
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/model/allowance?workspace=workspace-a', authorization: 'Bearer synthetic-owner-token', accept: 'application/json' }]);
});

test('owner policy can be absent; stale and elapsed resets never become fresh percentages', async t => {
  const input = source(); input.models[0].status = 'unknown';
  const { requests, baseUrl } = await fixture(t, (_request, response) => json(response, input));
  assert.equal((await readSubscriptionAllowance({ baseUrl })).models[0].windows[0].remainingPercent, null);
  assert.equal(requests[0].authorization, undefined);
  const now = Date.now(), stale = source(now - 300000);
  assert.equal(projectSubscriptionAllowance(stale, now).models[0].status, 'stale');
  assert.equal(projectSubscriptionAllowance(stale, now).models[0].windows[0].remainingPercent, null);
  const reset = source(now); reset.models[0].windows[0].resetAt = new Date(now).toISOString();
  assert.equal(projectSubscriptionAllowance(reset, now).models[0].windows[0].remainingPercent, null);
});

test('refuses redirects without forwarding owner credentials to another endpoint', async t => {
  const destination = await fixture(t, (_request, response) => json(response, source()));
  const origin = await fixture(t, (_request, response) => { response.writeHead(302, { Location: destination.baseUrl }); response.end(); });
  await assert.rejects(readSubscriptionAllowance({ baseUrl: origin.baseUrl, token: 'synthetic-owner-token' }), { code: 'redirect-refused' });
  assert.equal(destination.requests.length, 0);
});

test('streaming body budget is enforced without trusting Content-Length', async t => {
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(200); response.write(' '.repeat(200)); response.end('{}'); });
  await assert.rejects(readSubscriptionAllowance({ baseUrl, maxResponseBytes: 100 }), { code: 'response-budget-exceeded' });
});

test('timeout covers streaming body, and caller abort has a fixed error', async t => {
  const { baseUrl } = await fixture(t, (_request, response) => { response.writeHead(200); response.write('{'); });
  await assert.rejects(readSubscriptionAllowance({ baseUrl, timeoutMs: 40 }), { code: 'request-timeout' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readSubscriptionAllowance({ baseUrl, signal: controller.signal }), { code: 'request-timeout' });
});

test('HTTP errors and invalid JSON never return raw endpoint diagnostics', async t => {
  const refused = await fixture(t, (_request, response) => { response.writeHead(423); response.end('SECRET_LOCKED_ERROR'); });
  await assert.rejects(readSubscriptionAllowance({ baseUrl: refused.baseUrl }), { code: 'http-refused', httpStatus: 423, message: 'http-refused' });
  const invalid = await fixture(t, (_request, response) => response.end('SECRET_INVALID_JSON'));
  await assert.rejects(readSubscriptionAllowance({ baseUrl: invalid.baseUrl }), { code: 'invalid-response', message: 'invalid-response' });
});

test('loopback URL spelling, workspace, credentials, and budgets are validated before any network call', async () => {
  for (const value of ['https://example.com', 'http://127.1', 'http://2130706433', 'http://localhost.evil', 'http://user:pass@localhost', 'http://localhost/api', 'http://localhost?x=1', 'http://localhost#x']) assert.throws(() => validateAllowanceBaseUrl(value), { code: 'invalid-base-url' });
  for (const value of ['http://127.0.0.1:4200', 'https://localhost:4200/', 'http://[::1]:4200']) assert.ok(validateAllowanceBaseUrl(value));
  for (const workspace of ['../secret', 'CON', '', ['default-workspace']]) await assert.rejects(readSubscriptionAllowance({ workspace }), { code: 'invalid-arguments' });
  for (const token of ['', 'secret token', 'secret\nheader']) await assert.rejects(readSubscriptionAllowance({ token }), { code: 'invalid-owner-token' });
  await assert.rejects(readSubscriptionAllowance({ timeoutMs: 0 }), { code: 'invalid-arguments' });
});

test('rejects token reflection and malformed allowance percentages instead of leaking output', async t => {
  const input = source(); input.models[0].modelName = 'synthetic-owner-token';
  const { baseUrl } = await fixture(t, (_request, response) => json(response, input));
  await assert.rejects(readSubscriptionAllowance({ baseUrl, token: 'synthetic-owner-token' }), { code: 'invalid-response' });
  const bad = source(); bad.models[0].windows[0].remainingPercent = 101;
  assert.throws(() => projectSubscriptionAllowance(bad), { code: 'invalid-response' });
});

test('CLI accepts only documented arguments and never accepts a bearer token argument', () => {
  assert.deepEqual(parseAllowanceArguments(['--workspace', 'workspace-a', '--timeout-ms', '100']), { baseUrl: undefined, workspace: 'workspace-a', timeoutMs: 100 });
  for (const args of [['--token', 'SECRET'], ['--workspace'], ['--workspace', 'a', '--workspace', 'b'], ['--timeout-ms', '1e3'], ['--refresh', 'true']]) assert.throws(() => parseAllowanceArguments(args), { code: 'invalid-arguments' });
});

test('standalone CLI uses owner environment and emits safe JSON from one GET', async t => {
  const { requests, baseUrl } = await fixture(t, (_request, response) => json(response, source()));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./subscription-allowance.mjs', import.meta.url)), '--base-url', baseUrl, '--workspace', 'workspace-a'],
    { env: { ...process.env, FLUJO_OWNER_API_TOKEN: 'synthetic-cli-token' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).models[0].windows[0].remainingPercent, 75);
  assert.doesNotMatch(stdout, /synthetic-cli-token/);
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'GET'); assert.equal(requests[0].authorization, 'Bearer synthetic-cli-token');
});
