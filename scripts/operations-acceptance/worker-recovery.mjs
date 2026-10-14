import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import JSZip from 'jszip';
import { verifyBuildEvidence } from './build-evidence.mjs';
import { createPrivateSmokeProfile } from '../smoke-cloud-worker-profile.mjs';
import { createSmokeOperator } from '../smoke-bundled-operator.mjs';
import { captureWorkerRecoveryAttempt, copiedRecoveryPlan, boundedJson } from '../worker-recovery-acceptance.mjs';
import { withTimeout } from '../mcp-smoke-cleanup.mjs';
import { inspectRecoveryApplication, observeRecoveryWorker, recoveryBudget, recoveryLimits, stopRecoveryWorker } from '../worker-recovery-runtime.mjs';

const args = process.argv.slice(2);
assert.ok((args.length === 4 || args.length === 6 && args[4] === '--fail-at' && args[5] === 'first-ready')
  && args[0] === '--report' && args[2] === '--build-evidence' && path.isAbsolute(args[1]) && path.isAbsolute(args[3]),
'Usage: node scripts/operations-acceptance/worker-recovery.mjs --report <new-absolute-report> --build-evidence <absolute-build-receipt> [--fail-at first-ready]');
const application = fileURLToPath(new URL('../../', import.meta.url));
const report = path.resolve(args[1]);
await assert.rejects(fs.access(report), { code: 'ENOENT' });
const build = await verifyBuildEvidence(application, args[3]);
assert.equal(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'package.json', 'package-lock.json', 'next.config.mjs'],
  { cwd: application, encoding: 'utf8' }), '', 'Application code must match its recorded revision.');
const hash = value => createHash('sha256').update(value).digest('hex');
const startedAt = new Date().toISOString();
const budget = recoveryBudget();
// Reserve the log before issuing credentials or starting a private fixture.
// Existing evidence stays intact, and a passing receipt cannot precede log I/O.
const log = await fs.open(report + '.log', 'wx', 0o600);
const operator = await createSmokeOperator().catch(async error => { await log.close(); throw error; });
const root = path.dirname(operator.env.FLUJO_OWNER_AUTH_FILE);
const privateIdentity = await fs.realpath(root);
const workspace = 'operations-worker-fixture';
const controlToken = randomBytes(32).toString('hex');
const workerId = `operations-source-${randomBytes(16).toString('hex')}`;
const key = randomBytes(32);
const answer = 'worker-recovery-source-response';
const requests = [], generations = [], observations = [];
let current, workerPort, baseUrl, archivePath, plaintextDigest, epoch = 1, providerMode = 'success', failure, recovery, attempt;
let cleanupVerified = false, injectedError, timer, providerStarted = false, providerCloseObserved = false;
let serverLog = '';
const fixtureSecrets = [operator.token, controlToken, key.toString('base64')];
const provider = http.createServer(async (request, response) => {
  try {
    const parts = []; let length = 0;
    for await (const part of request) { length += part.length; assert.ok(length <= 256 * 1024); parts.push(part); }
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer synthetic-smoke-key');
    const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.ok(requests.length < 100, 'Provider request budget exceeded.');
    const row = { sequence: requests.length + 1, mode: providerMode, stream: body.stream === true, receivedAt: new Date().toISOString(),
      outcome: providerMode === 'hold' ? 'held-response-uncertain' : 'response-issued' };
    requests.push(row);
    // This is an actual durable external fixture effect, independently counted
    // against completed engine history. It does not claim exactly-once cloud effects.
    await fs.appendFile(path.join(root, 'provider-effects.jsonl'), JSON.stringify(row) + '\n');
    if (providerMode === 'hold') { response.once('close', () => { row.connectionClosedAt = new Date().toISOString(); }); return; }
    const info = { id: `worker-source-${row.sequence}`, created: Math.floor(Date.now() / 1000), model: body.model };
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...info, object: 'chat.completion.chunk', choices: [{ index: 0,
        delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ...info, object: 'chat.completion', choices: [{ index: 0,
        message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 } }));
    }
  } catch {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Synthetic provider rejected the fixture request.' } }));
  }
});
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function unusedPort() { const probe = http.createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve)); return port; }
async function get(endpoint, expected = 200, token = controlToken) {
  budget.assertOpen();
  const url = new URL(endpoint, baseUrl); url.searchParams.set('workspace', workspace);
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([budget.signal, AbortSignal.timeout(10_000)]),
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  assert.equal(response.status, expected, `Unexpected source worker status at ${url.pathname}.`);
  return boundedJson(response);
}
async function stop(crash = false) {
  if (!current) return;
  await stopRecoveryWorker(current, { crash });
  assert.equal(current.receipt.parentExitObserved, true); assert.equal(current.receipt.stdioCloseObserved, true);
  if (crash) assert.equal(current.receipt.signal, 'SIGKILL', 'Original child did not report the requested abrupt exit.');
  current = undefined;
}
async function start() {
  budget.assertOpen();
  assert.ok(generations.length < recoveryLimits.maximumGenerations, 'Worker generation budget exceeded.');
  workerPort ??= await unusedPort(); const port = workerPort; baseUrl = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name)));
  Object.assign(env, operator.env, { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), APPDATA: path.join(root, 'home/roaming'),
    LOCALAPPDATA: path.join(root, 'home/local'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'), TMPDIR: path.join(root, 'temp'),
    FLUJO_APP_ROOT: application, FLUJO_DATA_DIR: path.join(root, 'data'), FLUJO_RUNTIME_ENV_DIR: application,
    FLUJO_WORKER_MODE: '1', FLUJO_WORKER_SNAPSHOT: archivePath, FLUJO_WORKER_SNAPSHOT_SHA256: plaintextDigest,
    FLUJO_WORKER_SNAPSHOT_KEY: key.toString('base64'), FLUJO_SNAPSHOT_CONTROL_TOKEN: controlToken,
    FLUJO_WORKER_RECOVERY_ID: workerId, FLUJO_WORKER_RECOVERY_EPOCH: String(epoch), FLUJO_BUILD_REVISION: build.sourceRevision,
    FLUJO_EXPOSURE_MODE: 'localhost', FLUJO_BASE_URL: baseUrl, FLUJO_PORT: String(port),
    FLUJO_MCP_APP_SANDBOX_HOST: '127.0.0.1', FLUJO_MCP_APP_SANDBOX_PORT: String(await unusedPort()) });
  await inspectRecoveryApplication(application, env);
  const child = fork(path.join(application, 'scripts/persona-browser-acceptance/next-process.cjs'), [String(port)], {
    cwd: application, execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
  current = observeRecoveryWorker(child, generations.length + 1); generations.push(current);
  current.receipt.epoch = epoch; current.receipt.outputBytes = 0;
  const owned = current;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    try {
      owned.receipt.outputBytes += bytes.length; budget.chargeOutput(bytes.length);
      assert.ok(owned.receipt.outputBytes <= recoveryLimits.generationOutputBytes, 'Worker generation output budget exceeded.');
      serverLog = (serverLog + bytes).slice(-128_000);
    }
    catch (error) { budget.refuse(error); if (!owned.observation.exited) owned.observation.child.kill('SIGKILL'); }
  });
  const deadline = performance.now() + 240_000;
  let status;
  do {
    budget.assertOpen(); assert.equal(owned.observation.exited, false, 'Owned worker exited before readiness.');
    try {
      const response = await fetch(`${baseUrl}/api/worker/status?workspace=${workspace}`, {
        signal: AbortSignal.any([budget.signal, AbortSignal.timeout(5_000)]), headers: { authorization: `Bearer ${controlToken}` } });
      if (response.status === 200) { status = await boundedJson(response); if (status.state === 'ready') break; }
      else await response.body?.cancel();
    } catch (error) { if (budget.signal.aborted) throw error; }
    await delay(250, undefined, { signal: budget.signal });
  } while (performance.now() < deadline);
  assert.equal(status?.state, 'ready', `Worker bootstrap did not reach readiness; last state ${status?.state ?? 'unobserved'}.`);
  assert.equal(status.workspace, workspace); assert.deepEqual(status.servers, []);
  const sample = await get('/api/operations/status');
  assert.equal(sample.complete, true); assert.equal(sample.worker.state, 'ready');
  assert.deepEqual(sample.processes, [], 'This source fixture must not launch a bundled or external MCP process.');
  observations.push({ check: 'actual-worker-bootstrap-ready', generation: owned.receipt.generation, epoch, workspace,
    readyAt: new Date().toISOString(), mcpProcessCount: sample.processes.length });
}
try {
  timer = setTimeout(() => { budget.refuse(new Error('Recovery whole-window deadline exceeded.'));
    if (current && !current.observation.exited) current.observation.child.kill('SIGKILL'); }, budget.remainingMs());
  await fs.mkdir(path.join(root, 'data')); await fs.mkdir(path.join(root, 'home')); await fs.mkdir(path.join(root, 'temp'));
  await fs.mkdir(path.join(root, 'home/local')); await fs.mkdir(path.join(root, 'home/roaming'));
  const providerPort = await listen(provider); providerStarted = true;
  const pkg = JSON.parse(await fs.readFile(path.join(application, 'package.json'), 'utf8'));
  const node = (id, type, properties = {}) => ({ id, type, position: { x: 0, y: 0 }, data: { type,
    label: `${type[0].toUpperCase()}${type.slice(1)} Node`, properties } });
  const nodes = [node('start', 'start'), node('process', 'process', { boundModel: 'smoke-model', promptTemplate: 'Reply to the user.',
    inputMode: 'full-history', allowQuestion: false }), node('finish', 'finish')];
  const edge = (source, target) => ({ id: `${source.id}:${source.type}-bottom->${target.id}:${target.type}-top`, source: source.id,
    target: target.id, sourceHandle: `${source.type}-bottom`, targetHandle: `${target.type}-top`, type: 'custom', data: { edgeType: 'standard' } });
  const flow = { id: 'worker-source-flow', name: 'WorkerSourceFixture', nodes, edges: [edge(nodes[0], nodes[1]), edge(nodes[1], nodes[2])], updatedAt: Date.now() };
  const profile = await createPrivateSmokeProfile();
  const files = {
    'db/encryption_key.json': JSON.stringify(profile.metadata), 'db/worker-bootstrap-secrets.json': JSON.stringify(profile.bootstrap),
    'db/mcp_servers.json': '{}', 'db/models.json': JSON.stringify([{ id: 'smoke-model', name: 'cloud-smoke-model',
      provider: 'openai', adapter: 'openai', ApiKey: profile.encryptedApiKey, baseUrl: `http://127.0.0.1:${providerPort}/v1` }]),
    'db/flows/worker-source-flow.json': JSON.stringify(flow),
    'db/planned_executions.json': JSON.stringify({ version: 1, paused: false, executions: [copiedRecoveryPlan(flow.id)] }),
  };
  const zip = new JSZip(); for (const [name, content] of Object.entries(files)) zip.file(name, content);
  const sourceWorkspaceRoot = 'C:\\synthetic-source\\workspaces\\operations-worker-fixture';
  zip.file('snapshot-manifest.json', JSON.stringify({ formatVersion: 2, layoutVersion: 2, workspace, generation: 0,
    createdAt: new Date().toISOString(), coherence: 'registered-flujo-writers', externalRootsIncluded: false,
    subtrees: ['db', 'mcp-servers', 'userdata', 'snapshots', 'screenshots', 'recordings', 'browser-profile', 'bash-utils', 'artifacts'],
    files: Object.entries(files).map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: hash(content) })),
    source: { version: pkg.version, platform: process.platform },
    runtime: { codexAuth: 'none', encryption: 'user', mcpTransfer: { formatVersion: 1, sourceWorkspaceRoot, servers: [] } } }));
  const plaintext = await zip.generateAsync({ type: 'nodebuffer' }); plaintextDigest = hash(plaintext);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]); archivePath = path.join(root, 'worker.snapshot');
  await fs.writeFile(archivePath, JSON.stringify({ format: 'flujo-workspace-encrypted', version: 1, iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }), { flag: 'wx', mode: 0o600 });
  await start();
  for (const endpoint of ['/api/worker/status', '/api/operations/status', '/api/snapshot/info']) await get(endpoint, 401, null);
  assert.equal(requests.length, 0, 'Initial bootstrap dispatched the copied snapshot flow.');
  if (args[5] === 'first-ready') { injectedError = 'Injected first-ready failure after actual worker readiness.'; throw new Error(injectedError); }
  recovery = await captureWorkerRecoveryAttempt({ baseUrl, workspace, controlToken, flowId: flow.id,
    observationRoute: 'operations', signal: budget.signal, providerCount: () => requests.length,
    setProviderMode: mode => { providerMode = mode; },
    readPrivateRecord: id => fs.readFile(path.join(root, 'data/.worker-local-recovery', workspace, `${hash(`${workspace}\0${id}`)}.json`)),
    onObservation: observation => { observations.push(observation); process.stdout.write(`Passed: ${observation.check}\n`); },
    restart: async ({ crash, offlineMs = 0, epoch: nextEpoch }) => {
      await stop(crash); if (offlineMs) await delay(offlineMs, undefined, { signal: budget.signal });
      if (nextEpoch !== undefined) epoch = nextEpoch;
      // Existing exercise helper holds one origin. Each original child is
      // recreated on that exact free literal-loopback port.
      await start();
    } }, { record: value => { attempt = value; } });
  const effectBytes = await fs.readFile(path.join(root, 'provider-effects.jsonl'));
  const effectRows = effectBytes.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(effectRows.length, requests.length);
  assert.equal(new Set(effectRows.map(row => row.sequence)).size, requests.length);
  const counted = { check: 'durable-provider-effect-journal-matches-received-dispatches', effects: effectRows.length,
    completedResponses: effectRows.filter(row => row.mode === 'success').length,
    heldUncertainDispatches: effectRows.filter(row => row.mode === 'hold').length, sha256: hash(effectBytes) };
  observations.push(counted);
  budget.assertOpen();
} catch (error) { failure = error; }
finally {
  clearTimeout(timer);
  const recordCleanupError = cleanup => { failure = failure ? new AggregateError([failure, cleanup], 'Source drill and cleanup failed.') : cleanup; };
  try { await stop(); } catch (cleanup) { recordCleanupError(cleanup); }
  // Always settle the owned listener, including failed child shutdown. A held
  // provider socket must not keep failed equipment alive without a deadline.
  try {
    provider.closeAllConnections();
    if (provider.listening) await withTimeout(new Promise((resolve, reject) => provider.close(error => error ? reject(error) : resolve())),
      recoveryLimits.closeMs, 'owned fixture provider close');
    else assert.equal(providerStarted, false, 'Started provider has no observed close.');
    providerCloseObserved = true;
  } catch (cleanup) { recordCleanupError(cleanup); }
  try {
    assert.equal(providerCloseObserved, true, 'Provider close completion must be observed before private cleanup.');
    assert.ok(generations.every(record => record.receipt.parentExitObserved && record.receipt.stdioCloseObserved && !record.receipt.abandoned && !record.receipt.failure),
      'Every owned worker generation must settle before fixture cleanup.');
    assert.equal(await fs.realpath(root), privateIdentity); assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await operator.restore(); await assert.rejects(fs.lstat(root), { code: 'ENOENT' }); cleanupVerified = true;
  } catch (cleanup) { recordCleanupError(cleanup); }
  const receipt = { schemaVersion: 1, scenario: 'source-worker-recovery-570', outcome: failure ? 'failed' : 'passed',
    startedAt, completedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    sourceRevision: build.sourceRevision, buildId: build.buildId, sourceInputs: build.sourceInputs, builtInputs: build.builtInputs,
    buildEvidenceSha256: build.evidenceSha256, ownerIssuerSourceSha256: operator.issuerSourceSha256,
    observations, requests, recovery, attempt, generations: generations.map(record => record.receipt), budget: budget.receipt(),
    providerCloseObserved, cleanupVerified, ...(cleanupVerified ? {} : { retainedPrivateRoot: root }), injectedError,
    failure: failure ? String(failure.stack ?? failure) : undefined,
    limits: ['Source-built application only; no installed/container/release qualification.',
      'Empty MCP configuration; MCP preparation and generation-bound stdio exit use their separate acceptance.',
      'Loopback model and counted synthetic provider effect; no cloud billing or exactly-once external-effect promise.',
      'Original direct Next child exit/stdio only; no detached-descendant or isolated-container removal inference.',
      'Paused/disabled/retired/stop/corrupt provenance use focused contracts; this live drill covers copied/local/crash/epoch.',
      'Disk-full/migration/snapshot disaster restore, independent operator and exact release profiles remain open.'], equipment: [] };
  for (const name of ['scripts/operations-acceptance/worker-recovery.mjs', 'scripts/worker-recovery-acceptance.mjs',
    'scripts/worker-recovery-runtime.mjs', 'scripts/smoke-cloud-worker-profile.mjs', 'scripts/persona-browser-acceptance/next-process.cjs',
    'scripts/smoke-bundled-operator.mjs', 'scripts/mcp-smoke-cleanup.mjs', 'scripts/operations-acceptance/build-evidence.mjs']) receipt.equipment.push({ name, sha256: hash(await fs.readFile(path.join(application, name))) });
  let serialized = JSON.stringify(receipt, null, 2);
  for (const secret of fixtureSecrets) { serialized = serialized.split(secret).join('[REDACTED]'); serverLog = serverLog.split(secret).join('[REDACTED]'); }
  key.fill(0);
  try { await log.writeFile(serverLog); await log.close(); }
  catch (error) {
    recordCleanupError(error); await log.close().catch(() => {});
    receipt.outcome = 'failed'; receipt.failure = 'Owned evidence log could not be written/closed.';
    serialized = JSON.stringify(receipt, null, 2);
  }
  await fs.writeFile(report, serialized + '\n', { flag: 'wx', mode: 0o600 });
}
if (failure) throw failure;
process.stdout.write(JSON.stringify({ outcome: 'passed', report, cleanupVerified, generations: generations.length,
  observations: observations.map(row => row.check) }) + '\n');
