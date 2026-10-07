import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureWorkerRecoveryAttempt, completedTickAfterCatchup, copiedRecoveryPlan, exerciseWorkerRecovery } from './worker-recovery-acceptance.mjs';

test('a recovery preentry refusal retains its allocated evidence without deletion or app entry', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-recovery-retention-test-'));
  const application = path.join(parent, 'application');
  await fs.mkdir(application);
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ version: '3.46.3' }));
  // This owned marker refuses startup before listeners, snapshot restore or app spawn.
  await fs.writeFile(path.join(application, '.env'), 'SYNTHETIC_REFUSAL_MARKER=1\n');
  const tracePath = path.join(parent, 'trace.json');
  const hookPath = path.join(parent, 'preentry-hook.mjs');
  await fs.writeFile(hookPath, String.raw`
import { promises as fs, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const trace = { root: null, unlinkCalls: 0, rmCalls: 0, appSpawnCalls: 0, runtimeListenerCalls: 0 };
const save = () => fs.writeFile(process.env.FLUJO_RECOVERY_TEST_TRACE, JSON.stringify(trace));
const originalMkdtemp = fs.mkdtemp.bind(fs);
fs.mkdtemp = async (...args) => {
  const root = await originalMkdtemp(...args);
  if (path.dirname(root) !== process.env.FLUJO_RECOVERY_TEST_PARENT
      || !path.basename(root).startsWith('flujo-cloud-worker-smoke-')) throw new Error('Unexpected test namespace');
  trace.root = root; await save(); return root;
};
fs.unlink = async () => { trace.unlinkCalls++; await save(); throw new Error('Unexpected evidence deletion'); };
fs.rm = async () => { trace.rmCalls++; await save(); throw new Error('Unexpected evidence deletion'); };
childProcess.spawn = () => {
  trace.appSpawnCalls++; writeFileSync(process.env.FLUJO_RECOVERY_TEST_TRACE, JSON.stringify(trace));
  throw new Error('Unexpected app entry after refusal');
};
childProcess.fork = childProcess.spawn;
http.Server.prototype.listen = () => {
  trace.runtimeListenerCalls++; writeFileSync(process.env.FLUJO_RECOVERY_TEST_TRACE, JSON.stringify(trace));
  throw new Error('Unexpected runtime listener after refusal');
};
syncBuiltinESMExports();
`);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|comspec|pathext|systemdrive|programfiles(?:\(x86\))?)$/i.test(name) && value) env[name] = value;
  }
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(hookPath).href,
    fileURLToPath(new URL('./smoke-cloud-worker.mjs', import.meta.url)), '--production', '--worker-recovery', '--application', application], {
    env: { ...env, TMP: parent, TEMP: parent, TMPDIR: parent,
      FLUJO_RECOVERY_TEST_TRACE: tracePath, FLUJO_RECOVERY_TEST_PARENT: parent },
    windowsHide: true, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, 'The synthetic dotenv marker must refuse startup.');
  assert.match(result.stderr, /Smoke application must have no production dotenv files/);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.attempt.outcome, 'not-entered');
  assert.equal(report.completion, 'partial-or-not-entered');
  assert.deepEqual(report.fixtureFinalization, { providerListenerClosed: true, parentShutdownUnverified: false,
    disposableData: 'retained', descendantExit: 'unverified', cleanupPolicy: 'retain-worker-recovery-fixture',
    cleanupAttempted: false, cleanupCompleted: false });
  const trace = JSON.parse(await fs.readFile(tracePath, 'utf8'));
  assert.equal(path.dirname(trace.root), parent);
  assert.equal(trace.unlinkCalls, 0);
  assert.equal(trace.rmCalls, 0);
  assert.equal(trace.appSpawnCalls, 0);
  assert.equal(trace.runtimeListenerCalls, 0);
  assert.equal((await fs.lstat(trace.root)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(application, '.env'), 'utf8'), 'SYNTHETIC_REFUSAL_MARKER=1\n');
  // The allocated test parent and refused app namespace are retained, too.
});

async function fixture(t, fault, observationRoute = 'operations') {
  const token = 'synthetic-acceptance-token'; const workspace = 'fixture-workspace';
  const copied = copiedRecoveryPlan('fixture-flow');
  const plans = new Map([[copied.id, { execution: copied, optedIn: false, runs: [], reason: 'no-local-provenance' }]]);
  const methods = []; let calls = 0; let mode = 'success'; let restartCount = 0; let resumedTickReads = 0;
  let privateBytes = Buffer.from('fixture pending identity');
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const url = new URL(request.url, 'http://127.0.0.1'); assert.equal(url.searchParams.get('workspace'), workspace);
    const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    const parts = []; for await (const chunk of request) parts.push(chunk);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
    methods.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/operations/status') {
      json({ complete: true, identity: { applicationVersion: 'fixture' }, workspace, worker: { state: 'ready' },
        schedules: [...plans.values()].map(plan => ({ id: plan.execution.id, armed: plan.execution.id === copied.id ? fault === 'copied-armed'
          : plan.optedIn && !plan.pendingRunId, recovery: { reason: plan.reason, ...(plan.pendingRunId ? { pendingRunId: plan.pendingRunId } : {}) } })) });
    } else if (url.pathname === '/api/worker/status') {
      json({ workspace, state: 'ready' });
    } else if (url.pathname === '/api/snapshot/info') {
      json({ workerCompatibility: { applicationVersion: 'fixture' } });
    } else if (url.pathname === '/api/planned-executions' && request.method === 'POST') {
      const id = `local-${plans.size}`; const execution = { ...body, id, generationId: `generation-${plans.size}` };
      plans.set(id, { execution, optedIn: false, reason: 'not-opted-in', runs: [] }); json({ execution }, 201);
    } else if (url.pathname === '/api/planned-executions') {
      json({ executions: [...plans.values()].map(plan => ({ execution: plan.execution,
        status: { armed: plan.execution.id === copied.id ? fault === 'copied-armed' : plan.optedIn && !plan.pendingRunId,
          workerRecovery: { definitionSha256: 'a'.repeat(64), reason: plan.reason,
            ...(plan.pendingRunId ? { pending: { runId: plan.pendingRunId } } : {}) } } })) });
    } else if (url.pathname === '/api/planned-executions/reconcile') {
      if (fault === 'unsafe-reconcile') calls++;
      json({ ok: true });
    } else {
      const match = /^\/api\/planned-executions\/([^/]+)\/(runs|worker-recovery)$/.exec(url.pathname);
      assert.ok(match, 'Unexpected fixture endpoint');
      const plan = plans.get(match[1]); assert.ok(plan);
      if (match[2] === 'runs') {
        if (restartCount === 1 && match[1] === 'local-1' && ++resumedTickReads === 2 && fault !== 'no-resumed-tick') {
          const now = new Date().toISOString();
          plan.runs.push({ runId: 'resumed-tick', executionGenerationId: plan.execution.generationId,
            status: 'completed', triggerSummary: 'Schedule', firedAt: now, finishedAt: now });
          if (fault !== 'resumed-without-dispatch') calls++;
        }
        return json({ runs: plan.runs });
      }
      if (body.expectedGenerationId !== plan.execution.generationId) return json({ error: 'fixture conflict' }, 409);
      plan.optedIn = body.enabled; plan.reason = body.enabled ? 'eligible' : 'not-opted-in';
      if (body.enabled && plan.runs.length === 0) {
        const runId = `run-${match[1]}`;
        plan.runs.push({ runId, executionGenerationId: plan.execution.generationId,
          status: mode === 'hold' ? 'running' : 'completed', triggerSummary: 'Schedule' });
        if (fault !== 'completed-without-dispatch') calls++;
        if (mode === 'hold') { plan.pendingRunId = runId; privateBytes = Buffer.from(`fixture pending ${runId}`); }
      }
      json({ recovery: { reason: plan.reason } });
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; });
  const restart = async ({ epoch }) => {
    restartCount++;
    const completed = plans.get('local-1');
    const pending = plans.get('local-2');
    if (restartCount === 1) {
      const length = fault === 'duplicate-catchup' ? 2 : 1;
      for (let index = 0; index < length; index++) {
        completed.runs.push({ runId: `catchup-${index}`, executionGenerationId: completed.execution.generationId,
          status: 'completed', triggerSummary: 'Schedule (missed while FLUJO was closed — ran once at startup)' }); calls++;
      }
    } else if (epoch === 2) pending.reason = fault === 'unsafe-epoch' ? 'eligible' : 'worker-authority-changed';
    else {
      pending.reason = 'unresolved-admission';
      if (fault === 'replay-on-startup') calls++;
      if (fault === 'rewritten-private-record') privateBytes = Buffer.from('replaced admission');
    }
  };
  return { methods, input: { baseUrl: `http://127.0.0.1:${server.address().port}`, workspace, controlToken: token, flowId: 'fixture-flow', observationRoute,
    restart, providerCount: () => calls, setProviderMode: value => { mode = value; }, readPrivateRecord: async () => Buffer.from(privateBytes),
    observeMs: 1, offlineMs: 1, timeoutMs: 2000, pause: async () => {} } };
}

test('HTTP orchestration retains separate complete, interrupted and changed-authority observations', async t => {
  const { input, methods } = await fixture(t);
  const report = await exerciseWorkerRecovery(input);
  assert.deepEqual(report.observations.map(item => item.check), ['copied-and-unenrolled-suppression',
    'actual-local-tick-and-same-worker-catchup', 'interrupted-dispatch-retained-without-replay', 'changed-epoch-fences-private-admission']);
  assert.equal(report.provider.originalPaidProviderCalls, 0);
  assert.equal(report.observations[1].resumedOrdinaryTickRunId, 'resumed-tick');
  assert.ok(Date.parse(report.observations[1].resumedOrdinaryTickFiredAt) >= Date.parse(report.observations[1].catchupObservedAt));
  assert.equal(report.observations[2].replacementDispatches, 0);
  assert.ok(methods.includes('POST /api/planned-executions/reconcile'));
  assert.doesNotMatch(JSON.stringify(report), /synthetic-acceptance-token/);
});

test('the current scheduler observation profile uses its three routes and labels reconciliation', async t => {
  const { input, methods } = await fixture(t, undefined, 'scheduler');
  const report = await exerciseWorkerRecovery(input);
  assert.equal(report.observationContract, 'ordinary-scheduler-list-can-reconcile');
  assert.ok(methods.includes('GET /api/worker/status'));
  assert.ok(methods.includes('GET /api/snapshot/info'));
  assert.ok(methods.includes('GET /api/planned-executions'));
  assert.ok(!methods.includes('GET /api/operations/status'));
  assert.equal(report.observations[1].resumedOrdinaryTickRunId, 'resumed-tick');
  assert.equal(report.observations[2].replacementDispatches, 0);
});

for (const [fault, message] of [
  ['copied-armed', undefined], ['completed-without-dispatch', /did not reach/], ['duplicate-catchup', /multiple catch-up/],
  ['replay-on-startup', /startup replayed/], ['rewritten-private-record', /changed retained admission/],
  ['unsafe-reconcile', /Repeated reconciliation/], ['unsafe-epoch', undefined],
  ['no-resumed-tick', /Ordinary cron recurrence did not complete/],
  ['resumed-without-dispatch', /did not reach the provider after catch-up observation/],
]) test(`negative control rejects ${fault}`, async t => {
  const { input } = await fixture(t, fault);
  await assert.rejects(exerciseWorkerRecovery(input), message);
});

test('the snapshot row is explicitly copied, enabled and without any local enrollment flag', () => {
  const copied = copiedRecoveryPlan('fixture-flow');
  assert.equal(copied.enabled, true); assert.equal(copied.overlapStrategy, 'skip');
  assert.equal(copied.trigger.cron.split(' ').length, 6);
  assert.equal(copied.workerLocalRecovery, undefined);
});

const recurrenceIdentity = { generationId: 'generation-a', catchupRunId: 'catchup-a', priorRunIds: new Set(['old-a']),
  observedAt: '2026-10-04T08:00:00.000Z' };
const recurringResult = () => ({ runId: 'ordinary-a', executionGenerationId: 'generation-a', status: 'completed',
  triggerSummary: 'Schedule', firedAt: '2026-10-04T08:00:05.000Z', finishedAt: '2026-10-04T08:00:05.025Z' });
test('recurrence selector accepts a distinct completed ordinary tick after catch-up observation', () => {
  const run = recurringResult();
  assert.equal(completedTickAfterCatchup([run], recurrenceIdentity), run);
});
for (const [label, changes] of [
  ['wrong generation', { executionGenerationId: 'generation-b' }],
  ['the catch-up identity', { runId: 'catchup-a' }],
  ['previous history identity', { runId: 'old-a' }],
  ['another startup catch-up', { triggerSummary: 'Schedule (missed while FLUJO was closed — ran once at startup)' }],
  ['manual execution', { triggerSummary: 'Manual' }],
  ['nonterminal work', { status: 'running' }],
  ['a tick fired before observation', { firedAt: '2026-10-04T07:59:59.999Z' }],
  ['missing fire time', { firedAt: undefined }],
  ['invalid finish time', { finishedAt: 'invalid' }],
  ['finish before firing', { finishedAt: '2026-10-04T08:00:04.999Z' }],
]) test(`recurrence selector refuses ${label}`, () => {
  assert.equal(completedTickAfterCatchup([{ ...recurringResult(), ...changes }], recurrenceIdentity), undefined);
});

test('attempt evidence retains completed stages when a later stage rejects without copying raw errors', async () => {
  const failure = new Error('SECRET_PROVIDER_ERROR'); let evidence;
  await assert.rejects(captureWorkerRecoveryAttempt({}, { record: value => { evidence = value; }, run: async ({ onObservation }) => {
    onObservation({ check: 'copied-and-unenrolled-suppression', providerDispatches: 0, observedMs: 11_000 });
    throw failure;
  } }), error => error === failure);
  assert.equal(evidence.outcome, 'failed');
  assert.deepEqual(evidence.observations, [{ check: 'copied-and-unenrolled-suppression', providerDispatches: 0, observedMs: 11_000 }]);
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET_PROVIDER_ERROR|stack|cause/);
  assert.ok(Number.isFinite(Date.parse(evidence.startedAt)) && Number.isFinite(Date.parse(evidence.completedAt)));
});
test('attempt evidence records an immediate failure with no completed stages', async () => {
  const failure = new Error('SECRET_AUTH_TOKEN'); let evidence;
  await assert.rejects(captureWorkerRecoveryAttempt({}, { record: value => { evidence = value; }, run: async () => { throw failure; } }), error => error === failure);
  assert.equal(evidence.outcome, 'failed'); assert.deepEqual(evidence.observations, []);
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET_AUTH_TOKEN/);
});
test('attempt evidence detaches completed observations from later mutation', async () => {
  const observation = { check: 'copied-and-unenrolled-suppression', providerDispatches: 0, observedMs: 11_000 };
  let evidence;
  await captureWorkerRecoveryAttempt({}, { record: value => { evidence = value; }, run: async ({ onObservation }) => {
    onObservation(observation); observation.providerDispatches = 99;
    return { observations: [] };
  } });
  assert.equal(evidence.observations[0].providerDispatches, 0);
});
test('attempt evidence records success without treating returned report contents as stage witnesses', async () => {
  const report = { privateResponse: 'SECRET_RESPONSE_BODY' }; let evidence;
  const result = await captureWorkerRecoveryAttempt({}, { record: value => { evidence = value; }, run: async ({ onObservation }) => {
    onObservation({ check: 'changed-epoch-fences-private-admission', changedEpoch: 2, replacementDispatches: 0 });
    return report;
  } });
  assert.equal(result, report); assert.equal(evidence.outcome, 'passed');
  assert.match(evidence.qualification, /artifact-and-operator-acceptance-not-established/);
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET_RESPONSE_BODY|privateResponse/);
});
