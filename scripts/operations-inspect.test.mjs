import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectOperations, parseArguments, validateBaseUrl } from './operations-inspect.mjs';

const revision = 'a'.repeat(40);
const token = 'fixture-synthetic-control-token';
const workspace = 'default-workspace';
const processId = '11111111-1111-4111-8111-111111111111';
function snapshot() {
  return { schemaVersion: 2, collectedAt: '2026-10-03T12:00:00.000Z', observationProcessId: processId, workspace, identity: { applicationVersion: '3.46.3',
    snapshotFormatVersion: 2, layoutVersion: 2, workerProtocolVersion: 1, workerSnapshotSourceVersion: 1, revision }, actor: { kind: 'worker-control' },
    observation: 'non-atomic-diagnostic-sample', complete: true, scope: { schedulerAndActiveRuns: 'this-process-and-workspace',
      mcpRecords: 'this-process-and-workspace', memory: 'this-process-all-workspaces', observationProcessId: 'self-reported-process-correlation-only',
      approvalAndHistory: 'unverified-durable-index', processExit: 'matching-runtime-generation-receipt' }, probes: [], truncated: false, rowLimit: 200,
    worker: { mode: 'worker', state: 'ready' }, scheduler: { started: true, pausedAtLastReconcile: false, pausedInStoredConfig: false,
      armedTriggers: 0, runningRuns: 0, queue: { overlap: 0, exclusiveWaiting: 0, maxOverlapDepth: 0, blockedByExclusive: 0, capPerQueue: 50 } },
    schedules: [], indexedApprovals: [], activeRuns: [], processes: [], memory: { rssBytes: 100, heapUsedBytes: 50, heapTotalBytes: 80 }, alerts: [] };
}
async function fixture(t, handler) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    handler(request, response);
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    const stopped = new Promise(resolve => server.close(resolve));
    server.closeAllConnections(); await stopped;
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
const json = (response, body) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
const inspect = (baseUrl, extra = {}) => inspectOperations({ baseUrl, workspace, expectedRevision: revision, token, ...extra });

/** Observe the original direct child, with finite output/deadline and no PID/tree signals. */
function executable(args, env, receipts) {
  const receipt = { scope: 'original-direct-child-only', exitObserved: false, closeObserved: false,
    code: null, signal: null, signalsSent: 0, abandoned: false, descendantAbsence: 'not-established' };
  receipts.push(receipt);
  const child = spawn(process.execPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let length = 0; let failure;
    const timer = setTimeout(() => {
      receipt.abandoned = true;
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      reject(new Error('Direct child deadline expired; exit remains unverified.'));
    }, 20_000);
    const capture = stream => chunk => {
      length += chunk.length;
      if (length > 64 * 1024) { failure ??= new Error('Direct child output budget exceeded.'); return; }
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'));
    child.once('error', error => { failure = error; });
    child.once('exit', (code, signal) => { receipt.exitObserved = true; receipt.code = code; receipt.signal = signal; });
    child.once('close', () => {
      clearTimeout(timer); receipt.closeObserved = true;
      if (failure) reject(failure);
      else if (!receipt.exitObserved || receipt.signal !== null) reject(new Error('Direct child did not complete naturally.'));
      else resolve({ stdout, stderr, receipt });
    });
  });
}

test('one authenticated GET returns a metadata projection without raw provider or unknown fields', async t => {
  const source = snapshot(); source.secret = token; source.providerError = 'SECRET_PROVIDER_ERROR';
  source.schedules = [{ id: 'plan-a', enabled: true, armed: false, runningInThisProcess: false, prompt: 'SECRET_PROMPT',
    recovery: { state: 'rejected', reason: 'unresolved-admission', eligible: false, pendingRunId: 'run-a', signature: 'SECRET_SIGNATURE' },
    indexedLastRun: { runId: 'run-a', status: 'error', output: 'SECRET_OUTPUT' } }];
  source.processes = [{ runtimeId: 'runtime-a', generation: 2, state: 'cold', leases: 0, pins: 0, command: 'SECRET_COMMAND',
    shutdown: { processOwnership: 'owned', exitOutcome: 'observed_exit', forced: true, errorClassification: 'none', generation: 2, runtimeId: 'runtime-a', rawError: 'SECRET_ERROR' } }];
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, source));
  const result = await inspect(baseUrl);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(requests, [{ method: 'GET', url: '/api/operations/status?workspace=default-workspace', authorization: `Bearer ${token}` }]);
  assert.equal(result.report.checks.artifactDigest, 'not-verified');
  assert.equal(result.report.checks.revision, 'self-report-matches');
  assert.equal(result.report.checks.processIdentity, 'self-report-only');
  assert.equal(result.report.checks.runtimeAcceptance, false);
  assert.equal(result.report.snapshot.identity.workerSnapshotSourceVersion, 1);
  assert.equal(result.report.snapshot.schedules[0].recovery.pendingRunId, 'run-a');
  assert.doesNotMatch(JSON.stringify(result.report), /SECRET_|fixture-synthetic-control-token/);
});

test('process correlation binds repeated samples only; revision/artifact fields cannot establish runtime identity', async t => {
  let source = snapshot();
  const { baseUrl } = await fixture(t, (_request, response) => json(response, source));
  const first = await inspect(baseUrl, { expectedProcessId: processId });
  assert.equal(first.report.checks.processIdentity, 'self-report-matches');
  assert.equal(first.report.checks.artifactDigest, 'not-verified');
  assert.equal(first.report.checks.runtimeAcceptance, false);
  source.observationProcessId = '22222222-2222-4222-8222-222222222222';
  await assert.rejects(inspect(baseUrl, { expectedProcessId: processId }), { code: 'process-mismatch' });
  source = snapshot(); source.schemaVersion = 1;
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
  source = snapshot(); source.scope.memory = 'this-process-and-workspace';
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
  source = snapshot(); delete source.observationProcessId;
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
});

test('refuses an exit receipt for a different runtime generation', async t => {
  const source = snapshot();
  source.processes = [{ runtimeId: 'runtime-a', generation: 2, state: 'cold', leases: 0, pins: 0,
    shutdown: { processOwnership: 'owned', exitOutcome: 'observed_exit', forced: false,
      errorClassification: 'none', generation: 1, runtimeId: 'runtime-a' } }];
  const { baseUrl } = await fixture(t, (_request, response) => json(response, source));
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
});

test('partial observations, warning alerts and missing/mismatched revision require attention', async t => {
  let source = snapshot();
  const { baseUrl } = await fixture(t, (_request, response) => json(response, source));
  source.complete = false;
  assert.equal((await inspect(baseUrl)).exitCode, 2);
  source = snapshot(); source.probes.push({ component: 'run-history', state: 'unavailable', reason: 'invalid-json' });
  assert.equal((await inspect(baseUrl)).report.checks.observation, 'partial');
  source = snapshot(); source.alerts.push({ code: 'shutdown-exit-unobserved', severity: 'warning' });
  assert.equal((await inspect(baseUrl)).exitCode, 2);
  source = snapshot(); source.identity.revision = 'b'.repeat(40);
  assert.equal((await inspect(baseUrl)).report.checks.revision, 'self-report-mismatch');
  source = snapshot(); delete source.identity.revision;
  assert.equal((await inspect(baseUrl)).report.checks.revision, 'self-report-missing');
});

test('refuses redirects without forwarding authority even to a second loopback server', async t => {
  const destination = await fixture(t, (_request, response) => json(response, snapshot()));
  const source = await fixture(t, (_request, response) => { response.writeHead(302, { Location: destination.baseUrl }); response.end('SECRET_REDIRECT'); });
  await assert.rejects(inspect(source.baseUrl), { code: 'redirect-refused' });
  assert.equal(destination.requests.length, 0);
});

test('refused HTTP and malformed schema never expose the response body', async t => {
  let mode = 'refused';
  const { baseUrl } = await fixture(t, (_request, response) => {
    if (mode === 'refused') { response.writeHead(401); response.end('SECRET_TOKEN SECRET_ERROR'); }
    else if (mode === 'invalid-json') { response.setHeader('Content-Type', 'application/json'); response.end('{SECRET_ERROR'); }
    else { const source = snapshot(); source.alerts.push({ code: 'SECRET_SERVER_MESSAGE', severity: 'warning' }); json(response, source); }
  });
  await assert.rejects(inspect(baseUrl), error => error.code === 'http-refused' && error.httpStatus === 401 && !error.message.includes('SECRET'));
  mode = 'invalid-json'; await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
  mode = 'invalid-schema'; await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
});

test('enforces both declared and streamed response byte budgets and a request deadline', async t => {
  let mode = 'declared';
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'declared') { response.setHeader('Content-Length', '100000'); response.end('x'); }
    else if (mode === 'streamed') { response.write('x'.repeat(150)); response.end('x'.repeat(150)); }
    else { response.writeHead(200); response.flushHeaders(); }
  });
  await assert.rejects(inspect(baseUrl, { maxResponseBytes: 256 }), { code: 'response-budget-exceeded' });
  mode = 'streamed'; await assert.rejects(inspect(baseUrl, { maxResponseBytes: 256 }), { code: 'response-budget-exceeded' });
  mode = 'deadline'; await assert.rejects(inspect(baseUrl, { timeoutMs: 50 }), { code: 'request-timeout' });
});

test('refuses conflicting workspace, raw metadata and oversized row collections', async t => {
  let source = snapshot();
  const { baseUrl } = await fixture(t, (_request, response) => json(response, source));
  source.workspace = 'other-workspace'; await assert.rejects(inspect(baseUrl), { code: 'workspace-mismatch' });
  source = snapshot(); source.actor = { kind: 'owner', ownerId: 'raw secret /../', credentialId: 'credential-a' };
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
  source = snapshot(); source.schedules = Array.from({ length: 201 }, () => ({ id: 'plan-a' }));
  await assert.rejects(inspect(baseUrl), { code: 'invalid-metadata' });
});

test('requires explicit base/revision/workspace; blocks insecure remote, embedded credentials and path/query URLs', async () => {
  for (const url of ['http://example.com', 'https://secret@example.com', 'http://127.0.0.1/path', 'https://example.com?token=secret', 'https://example.com#secret']) {
    assert.throws(() => validateBaseUrl(url), { code: 'invalid-base-url' });
  }
  for (const args of [[], ['--token', 'secret'], ['--base-url', 'https://example.com'],
    ['--base-url', 'https://example.com', '--base-url', 'https://example.com'],
    ['--base-url', 'https://example.com', '--workspace', workspace, '--expected-revision', revision, '--report', 'relative.json']]) {
    assert.throws(() => parseArguments(args), { code: 'invalid-arguments' });
  }
  await assert.rejects(inspect('http://127.0.0.1', { workspace: 'NUL' }), { code: 'invalid-arguments' });
  await assert.rejects(inspect('http://127.0.0.1', { token: 'secret\nheader' }), { code: 'missing-or-invalid-token' });
});

test('the executable uses an environment bearer and refuses to overwrite its explicit report', { timeout: 50_000 }, async t => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-operations-cli-'));
  const receipts = [];
  t.after(async () => {
    // Preserve evidence if the exact child exit/close was not observed.
    if (receipts.some(receipt => receipt.abandoned || !receipt.exitObserved || !receipt.closeObserved)) return;
    const resolved = path.resolve(fixtureRoot);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^flujo-operations-cli-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const source = snapshot(); source.secret = token;
  const { baseUrl, requests } = await fixture(t, (_request, response) => json(response, source));
  const report = path.join(fixtureRoot, 'report.json');
  const script = fileURLToPath(new URL('./operations-inspect.mjs', import.meta.url));
  const args = [script, '--base-url', baseUrl, '--workspace', workspace, '--expected-revision', revision, '--report', report];
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.FLUJO_OPERATIONS_TOKEN = token;
  const first = await executable(args, env, receipts);
  assert.equal(first.receipt.code, 0);
  assert.equal(JSON.parse(first.stdout).reportWritten, true);
  const original = await fs.readFile(report, 'utf8'); assert.doesNotMatch(original, /fixture-synthetic-control-token/);
  const second = await executable(args, env, receipts);
  assert.equal(second.receipt.code, 1);
  assert.match(second.stderr, /report-unavailable/); assert.ok(!second.stderr.includes(token));
  assert.ok(receipts.every(receipt => receipt.exitObserved && receipt.closeObserved && receipt.signal === null && receipt.signalsSent === 0));
  t.diagnostic(JSON.stringify({ fixture: 'synthetic-loopback-cli', receipts }));
  assert.equal(await fs.readFile(report, 'utf8'), original);
  assert.equal(requests.length, 2); assert.ok(requests.every(request => request.method === 'GET'));
});
