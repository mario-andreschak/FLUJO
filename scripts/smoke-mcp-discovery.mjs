// Actual built API + public Registry + deterministic local model. No paid inference.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSmokeOperator } from './smoke-bundled-operator.mjs';

const application = fileURLToPath(new URL('../', import.meta.url));
await fs.access(path.join(application, '.next/BUILD_ID'));
const operator = await createSmokeOperator();
const originalPolicy = await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE);
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const password = randomBytes(32).toString('base64url'), key = randomBytes(24).toString('base64url');
let child, closed, serverLog = '', failed = false, receipt, modelRequests = 0;
let hold = false, providerStarted, providerDisconnected;
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.headers.authorization, `Bearer ${key}`);
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 128 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'discovery-fixture'); assert.equal(body.max_completion_tokens ?? body.max_tokens, 2048);
    assert.equal('tools' in body, false); modelRequests++; providerStarted?.();
    if (hold) { response.once('close', () => providerDisconnected?.()); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'local-discovery', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        searches: ['web search'], service: 'web search', suggestedName: 'web-search', summary: 'Fixture narrative is advisory.', notes: {},
      }) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch { response.statusCode = 500; response.end('Discovery fixture contract failed.'); }
});
async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function retain() {
  failed = true;
  await fs.writeFile(path.join(root, 'discovery-server.log'), serverLog.split(operator.token).join('[redacted]').split(key).join('[redacted]').split(password).join('[redacted]'));
  console.error(`Private discovery failure evidence retained at ${root}`);
}
try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const port = await unusedPort(), sandbox = await unusedPort(), base = `http://127.0.0.1:${port}`;
  const environment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[name] !== undefined) environment[name] = process.env[name];
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...environment, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_BASE_URL: base,
        FLUJO_PORT: String(port), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandbox) },
    });
    child.once('error', reject); child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid readiness receipt')));
    child.once('exit', () => reject(new Error('Server exited before readiness')));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('Startup timeout'); })]);
  const headers = { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' };
  const get = params => fetch(`${base}/api/mcp-registry?${new URLSearchParams(params)}`, { headers, signal: AbortSignal.timeout(45_000) });
  assert.equal((await fetch(`${base}/api/mcp-registry?search=web+search`)).status, 401);
  assert.equal((await get({ search: 'web search' })).status, 423);
  for (const action of ['initialize', 'authenticate']) {
    const response = await fetch(`${base}/api/encryption/secure`, { method: 'POST', headers, body: JSON.stringify({ action, password }), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).success, true);
  }
  const snapshots = [];
  for (const query of ['web search', 'web-search', 'edit a spreadsheet']) {
    const response = await get({ search: query, limit: '5' }); assert.equal(response.status, 200);
    const page = await response.json(); assert.ok(page.servers.length > 0 && page.servers.length <= 5);
    assert.equal(page.metadata.discovery.bounded, true); assert.ok(page.metadata.discovery.terms.length <= 6);
    snapshots.push({ query, names: page.servers.map(value => value.server.name), discovery: page.metadata.discovery });
    if (page.metadata?.nextCursor) {
      const next = await get({ search: query, limit: '5', cursor: page.metadata.nextCursor }); assert.equal(next.status, 200);
      const more = await next.json(); assert.ok(more.servers.every(value => !snapshots.at(-1).names.includes(value.server.name)));
    }
  }
  assert.deepEqual(snapshots[0].names, snapshots[1].names);
  const configsResponse = await fetch(`${base}/api/mcp/servers`, { headers, signal: AbortSignal.timeout(20_000) }); assert.equal(configsResponse.status, 200);
  const before = await configsResponse.json(); assert.ok(before.some(config => config.name === 'filesystem' && config.disabled));
  const model = await fetch(`${base}/api/model`, { method: 'POST', headers, body: JSON.stringify({ id: 'discovery-local-fixture', name: 'discovery-fixture', provider: 'openai', adapter: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, ApiKey: key }), signal: AbortSignal.timeout(20_000) }); assert.equal(model.status, 201); await model.json();
  const research = await fetch(`${base}/api/mcp/assistant`, { method: 'POST', headers, body: JSON.stringify({ action: 'research', query: 'work with local files', modelId: '' }), signal: AbortSignal.timeout(110_000) }); assert.equal(research.status, 200);
  const events = (await research.text()).trim().split('\n').map(line => JSON.parse(line));
  const result = events.find(event => event.type === 'complete')?.result; assert.ok(result, 'Research must complete, not emit an error');
  const candidate = result.candidates[0]; assert.equal(candidate.action, 'configure-existing'); assert.equal(candidate.existingServerName, 'filesystem');
  assert.equal(candidate.recommendationTier, 'flujo-supported'); assert.equal(candidate.cost.kind, 'free'); assert.equal(candidate.recommended, true);
  const after = await (await fetch(`${base}/api/mcp/servers`, { headers, signal: AbortSignal.timeout(20_000) })).json(); assert.deepEqual(after, before);
  assert.equal((await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE)).equals(originalPolicy), true);
  await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
  assert.equal(modelRequests, 0);
  const interpreted = await fetch(`${base}/api/mcp/assistant`, { method: 'POST', headers,
    body: JSON.stringify({ action: 'research', query: 'search the latest news', modelId: 'discovery-local-fixture' }), signal: AbortSignal.timeout(110_000) });
  assert.equal(interpreted.status, 200);
  const interpretedEvents = (await interpreted.text()).trim().split('\n').map(line => JSON.parse(line));
  const interpretedResult = interpretedEvents.find(event => event.type === 'complete')?.result;
  assert.ok(interpretedResult, 'Mixed-intent research must complete');
  assert.match(interpretedResult.summary, /interpreted your request as “web search”/);
  assert.ok(interpretedResult.candidates.length > 0, 'Model interpretation must preserve useful generic web-search integrations');
  assert.equal(modelRequests, 1, 'Completed wider research sends exactly one tool-free model request');
  assert.deepEqual(await (await fetch(`${base}/api/mcp/servers`, { headers, signal: AbortSignal.timeout(20_000) })).json(), before);
  assert.equal((await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE)).equals(originalPolicy), true);
  await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
  hold = true;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const disconnected = new Promise(resolve => { providerDisconnected = resolve; });
  const controller = new AbortController();
  const pending = fetch(`${base}/api/mcp/assistant`, { method: 'POST', headers,
    body: JSON.stringify({ action: 'research', query: 'edit a spreadsheet', modelId: 'discovery-local-fixture' }), signal: controller.signal })
    .then(response => response.text()).then(() => false, error => error.name === 'AbortError');
  await Promise.race([started, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Provider was not actually running before disconnect'); })]);
  controller.abort(); assert.equal(await pending, true);
  await Promise.race([disconnected, delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Provider did not receive actual cancellation'); })]);
  await delay(200); assert.equal(modelRequests, 2);
  receipt = { actualPublicRegistry: snapshots, researchFirstCandidate: { action: candidate.action, server: candidate.existingServerName, cost: candidate.cost, tier: candidate.recommendationTier },
    resultSha256: createHash('sha256').update(JSON.stringify(result)).digest('hex'), modelRequests,
    mixedIntent: { query: interpretedResult.query, candidates: interpretedResult.candidates.map(value => value.registryName),
      summary: interpretedResult.summary, completedModelRequests: 1 }, actualRunningProviderDisconnect: true,
    model: 'deterministic local transport fixture; not real-model recommendation accuracy', noInstallOrEnable: true, consentAuthorityUnchanged: true };
} catch (error) { await retain(); throw error; }
finally {
  let cleanupError;
  try {
    if (child?.connected && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve()));
    if (closed) { const exit = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Cleanup timeout'); })]); assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); }
  } catch (error) { cleanupError = error; await retain(); }
  try {
    provider.closeAllConnections(); if (provider.listening) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    if (!failed && !cleanupError) await operator.restore();
  } catch (error) { cleanupError ??= error; await retain(); }
  if (cleanupError) throw cleanupError;
}
console.log(JSON.stringify({ ...receipt, gracefulCleanup: true }, null, 2));
