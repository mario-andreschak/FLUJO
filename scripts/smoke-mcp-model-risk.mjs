// Actual production route + public GitHub evidence + deterministic local model transport.
// This validates integration/cancellation; it is not real-model semantic accuracy evidence.
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
const password = randomBytes(32).toString('base64url');
const providerKey = randomBytes(24).toString('base64url');
let providerRequests = 0, hold = false, providerStarted, providerDisconnected;
let child, closed, serverLog = '', failed = false, receipt;
const provider = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 96 * 1024); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(body.model, 'fixture-text'); assert.equal(body.max_completion_tokens ?? body.max_tokens, 2048);
    assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
    assert.equal('tools' in body, false); assert.equal('tool_choice' in body, false);
    const evidence = JSON.parse(body.messages[1].content).untrustedRepositoryEvidence;
    assert.equal(evidence.repositoryUrl, 'https://github.com/mario-andreschak/mcp-voice');
    assert.match(evidence.revision, /^[a-f0-9]{40}$/); assert.match(evidence.evidenceDigest, /^[a-f0-9]{64}$/);
    providerRequests++; providerStarted?.();
    if (hold) { response.once('close', () => providerDisconnected?.()); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'local-assessment', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'fixture-text',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ score: 43,
        rationale: 'Deterministic local transport fixture; not a real model security judgment.', flags: ['Only the bounded public evidence was supplied.'] }) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch { response.statusCode = 500; response.end('Local model fixture contract failed.'); }
});
async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function retain() {
  failed = true;
  await fs.writeFile(path.join(root, 'server.log'), serverLog.replaceAll(operator.token, '[redacted]').replaceAll(password, '[redacted]').replaceAll(providerKey, '[redacted]'), { mode: 0o600 });
  console.error(`Private smoke diagnostics retained at ${root}`);
}
try {
  await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const modelUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const port = await unusedPort(), sandboxPort = await unusedPort(), base = `http://127.0.0.1:${port}`;
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) environment[key] = process.env[key];
  for (const name of ['data', 'home', 'temp']) await fs.mkdir(path.join(root, name));
  const ready = new Promise((resolve, reject) => {
    child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
      cwd: application, execPath: process.execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...environment, ...operator.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
        FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_EXPOSURE_MODE: 'localhost',
        FLUJO_BASE_URL: base, FLUJO_PORT: String(port), FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(sandboxPort) },
    });
    child.once('error', reject);
    child.once('message', message => message?.type === 'journey-server-ready' && message.pid === child.pid ? resolve() : reject(new Error('Invalid server readiness receipt')));
    child.once('exit', () => reject(new Error('Server exited before readiness')));
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { serverLog = `${serverLog}${bytes}`.slice(-64_000); });
  closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await Promise.race([ready, delay(60_000, undefined, { ref: false }).then(() => { throw new Error('Server startup timeout'); })]);
  const headers = { authorization: `Bearer ${operator.token}`, 'content-type': 'application/json' };
  const body = { repositoryUrl: 'https://github.com/mario-andreschak/mcp-voice', modelId: 'local-risk-fixture', includeSource: true };
  const post = (payload, token = operator.token, origin) => fetch(`${base}/api/mcp/model-risk-assessment`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(120_000) });
  assert.equal((await post(body, '')).status, 401); assert.equal((await post(body, 'wrong-owner')).status, 401);
  assert.equal((await post(body, operator.token, 'https://untrusted.invalid')).status, 403); assert.equal((await post(body)).status, 423);
  for (const action of ['initialize', 'authenticate']) {
    const response = await fetch(`${base}/api/encryption/secure`, { method: 'POST', headers, body: JSON.stringify({ action, password }), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200); assert.equal((await response.json()).success, true);
  }
  const model = await fetch(`${base}/api/model`, { method: 'POST', headers, body: JSON.stringify({ id: body.modelId, name: 'fixture-text', displayName: 'Local assessment fixture', provider: 'openai', adapter: 'openai', baseUrl: modelUrl, ApiKey: providerKey }), signal: AbortSignal.timeout(20_000) });
  assert.equal(model.status, 201); await model.json();
  assert.equal((await post({ ...body, apiKey: 'not-accepted' })).status, 400);
  assert.equal((await post({ ...body, padding: 'x'.repeat(5000) })).status, 400);
  const unsupported = await post({ ...body, modelId: 'missing-model' }); assert.equal((await unsupported.json()).review.status, 'unsupported');
  assert.equal(providerRequests, 0);
  const response = await post(body); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const review = (await response.json()).review;
  assert.equal(review.status, 'assessed'); assert.equal(review.assessment.score, 43); assert.equal(providerRequests, 1);
  assert.equal(review.model.id, body.modelId); assert.ok(review.source.fileCount > 0); assert.ok(review.source.bytes <= 48 * 1024);
  assert.equal('files' in review.source, false); assert.ok(review.source.limitations.includes('sampleOnly'));

  hold = true;
  const started = new Promise(resolve => { providerStarted = resolve; });
  const disconnected = new Promise(resolve => { providerDisconnected = resolve; });
  const controller = new AbortController();
  const pending = fetch(`${base}/api/mcp/model-risk-assessment`, { method: 'POST', headers, body: JSON.stringify({ ...body, includeSource: false }), signal: controller.signal }).then(() => false, () => true);
  try {
    await Promise.race([started, delay(45_000, undefined, { ref: false }).then(() => { throw new Error('Observe actual model request before HTTP disconnect'); })]);
    assert.equal(providerRequests, 2);
    const concurrent = await post(body); assert.deepEqual((await concurrent.json()).review, { status: 'unavailable', reason: 'busy' });
  } finally { controller.abort(); assert.equal(await pending, true); }
  await Promise.race([disconnected, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Provider connection did not close after disconnect'); })]);
  hold = false;
  let resumed; const resumeDeadline = Date.now() + 15_000;
  do { await delay(200); resumed = (await (await post({ ...body, includeSource: false })).json()).review; }
  while (resumed.reason === 'busy' && Date.now() < resumeDeadline);
  assert.equal(resumed.status, 'assessed'); assert.equal(resumed.source.fileCount, 0); assert.equal(resumed.source.bytes, 0);
  assert.ok(resumed.source.limitations.includes('signalsOnly')); assert.equal(providerRequests, 3);
  assert.equal((await fs.readFile(operator.env.FLUJO_OWNER_AUTH_FILE)).equals(originalPolicy), true);
  await assert.rejects(fs.access(operator.env.FLUJO_MCP_TRUSTED_HOST_FILE), { code: 'ENOENT' });
  receipt = { builtHttpAdmission: true, actualPublicEvidence: review.source, reportSha256: createHash('sha256').update(JSON.stringify(review)).digest('hex'),
    modelTransport: 'deterministic local OpenAI HTTP fixture, no paid model or real-model accuracy claim', explicitSavedModel: true,
    oneRequestPerAssessment: true, actualProviderDisconnect: true, concurrentRefusal: true, capacityRecovered: true, consentAuthorityUnchanged: true };
} catch (error) { await retain(); throw error; }
finally {
  let cleanupError;
  try {
    if (child?.connected && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve()));
    if (closed) { const exit = await Promise.race([closed, delay(15_000, undefined, { ref: false }).then(() => { throw new Error('Server cleanup timeout'); })]); assert.ok(exit.code === 0 || exit.code === 143 || exit.signal === 'SIGTERM'); }
  } catch (error) { cleanupError = error; await retain(); }
  try {
    provider.closeAllConnections(); if (provider.listening) await new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    if (!failed && !cleanupError) await operator.restore();
  } catch (error) { cleanupError ??= error; await retain(); }
  if (cleanupError) throw cleanupError;
}
console.log(JSON.stringify({ ...receipt, gracefulCleanup: true }, null, 2));
