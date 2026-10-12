import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { effectiveRecoveryDotenvRoots, inspectRecoveryApplication, observeRecoveryWorker,
  recoveryBudget, stopRecoveryWorker } from './worker-recovery-runtime.mjs';

const application = path.resolve('synthetic-compiled-recovery-root');
const env = { FLUJO_RUNTIME_ENV_DIR: application };
function compiledFilesystem({ dotenv, build = 'synthetic-build', name = 'flujo-ai' } = {}) {
  const probes = [];
  return { probes,
    async lstat(file) {
      probes.push(file);
      if (path.basename(file) === dotenv) return { isFile: () => true };
      throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' });
    },
    async readFile(file) {
      return path.basename(file) === 'package.json' ? JSON.stringify({ name, version: 'fixture' }) : build;
    },
  };
}

test('the local compiled profile checks all four effective dotenv names and labels artifact identity unverified', async () => {
  const filesystem = compiledFilesystem();
  const result = await inspectRecoveryApplication(application, env, { filesystem });
  assert.deepEqual(filesystem.probes, ['.env', '.env.local', '.env.production', '.env.production.local']
    .map(name => path.join(application, name)));
  assert.deepEqual(result.effectiveDotenvRoots, [application]);
  assert.equal(result.profile, 'local-compiled-package');
  assert.equal(result.artifactDigest, 'not-verified-by-this-harness');
});

test('the container dotenv root is accounted for and refused before any foreign filesystem probe', async () => {
  const filesystem = compiledFilesystem();
  const containerEnv = { ...env, FLUJO_CONTAINER: '1' };
  assert.ok(effectiveRecoveryDotenvRoots(application, containerEnv).includes(path.resolve('/app/data')));
  await assert.rejects(inspectRecoveryApplication(application, containerEnv, { filesystem }), /FLUJO_CONTAINER/);
  assert.equal(filesystem.probes.length, 0);
});

test('an alternate runtime dotenv directory is refused before configuration is loaded', async () => {
  const filesystem = compiledFilesystem();
  await assert.rejects(inspectRecoveryApplication(application,
    { FLUJO_RUNTIME_ENV_DIR: path.resolve('foreign-runtime-root') }, { filesystem }), /admitted application root/);
  assert.equal(filesystem.probes.length, 0);
});

test('a production-local dotenv file refuses entry even when the compiled package marker exists', async () => {
  await assert.rejects(inspectRecoveryApplication(application, env,
    { filesystem: compiledFilesystem({ dotenv: '.env.production.local' }) }), /no production dotenv/);
});

test('an empty build marker cannot qualify as a local compiled package', async () => {
  await assert.rejects(inspectRecoveryApplication(application, env,
    { filesystem: compiledFilesystem({ build: ' ' }) }), /identity is incomplete/);
});

test('one monotonic deadline cannot be renewed by moving a wall-clock value', () => {
  let now = 100;
  const budget = recoveryBudget({ totalMs: 10, maximumOutputBytes: 10, now: () => now });
  now = 109; assert.equal(budget.remainingMs(), 1);
  now = 110; assert.throws(() => budget.assertOpen(), /whole-window deadline/);
  now = 101; assert.throws(() => budget.assertOpen(), /whole-window deadline/);
  assert.equal(budget.signal.aborted, true);
});

test('output budget failure is sticky across later worker generations', () => {
  const budget = recoveryBudget({ totalMs: 100, maximumOutputBytes: 3, now: () => 0 });
  budget.chargeOutput(2);
  assert.throws(() => budget.chargeOutput(2), /output budget/);
  assert.throws(() => budget.remainingMs(), /output budget/);
  assert.equal(budget.receipt().outputBytes, 4);
});

function complete(child, code = 143, signal = null, close = true) {
  child.exitCode = code; child.signalCode = signal;
  child.emit('exit', code, signal);
  if (close) child.emit('close', code, signal);
}
function fakeChild({ send, kill } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 987, connected: true, exitCode: null, signalCode: null, unrefs: 0,
    messages: [], kills: [], stdin: { destroy() {} }, stdout: { destroy() {} }, stderr: { destroy() {} } });
  child.send = (message, callback) => { child.messages.push(message); if (send) send(child, callback); else callback(); };
  child.kill = signal => { child.kills.push(signal); kill?.(child, signal); return true; };
  child.unref = () => { child.unrefs++; };
  return child;
}
const limits = { ipcMs: 10, graceMs: 10, crashMs: 10, closeMs: 10 };

test('graceful restart joins the original worker exit and stdio close through owned IPC without a signal', async () => {
  const child = fakeChild({ send: (current, callback) => { complete(current); callback(); } });
  const record = observeRecoveryWorker(child, 1);
  const receipt = await stopRecoveryWorker(record, limits);
  assert.deepEqual(child.messages, ['stop']); assert.deepEqual(child.kills, []);
  assert.equal(receipt.parentExitObserved, true); assert.equal(receipt.stdioCloseObserved, true);
  assert.equal(receipt.descendantExit, 'unverified');
});

test('intentional crash targets only the original worker and still requires original stdio close', async () => {
  const child = fakeChild({ kill: current => complete(current, null, 'SIGKILL') });
  const record = observeRecoveryWorker(child, 2);
  const receipt = await stopRecoveryWorker(record, { ...limits, crash: true });
  assert.deepEqual(child.kills, ['SIGKILL']); assert.deepEqual(child.messages, []);
  assert.deepEqual(receipt.signalAttempts, [{ signal: 'SIGKILL', delivered: true }]);
  assert.equal(receipt.parentExitObserved, true); assert.equal(receipt.stdioCloseObserved, true);
});

test('an already exited worker with held stdio is not signaled and late closure never repairs abandonment', async () => {
  const child = fakeChild(); const record = observeRecoveryWorker(child, 3);
  complete(child, 143, null, false);
  await assert.rejects(stopRecoveryWorker(record, limits), /stop and fallback failed/);
  assert.equal(record.observation.abandoned, true); assert.deepEqual(child.kills, []);
  child.emit('close', 143, null);
  await assert.rejects(stopRecoveryWorker(record, limits), /remains abandoned/);
  assert.deepEqual(child.kills, []);
});

test('forced fallback remains a graceful-stop failure even when original terminals subsequently arrive', async () => {
  const child = fakeChild({ kill: current => complete(current) });
  const record = observeRecoveryWorker(child, 4);
  await assert.rejects(stopRecoveryWorker(record, limits), /graceful exit/);
  assert.equal(record.receipt.failure, 'original-worker-stop-unresolved');
  assert.deepEqual(child.kills, ['SIGTERM']);
  await assert.rejects(stopRecoveryWorker(record, limits), /remains failed/);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('a failed-spawn close cannot be promoted to an observed worker exit', async () => {
  const child = fakeChild(); child.pid = undefined;
  const record = observeRecoveryWorker(child, 5);
  child.emit('close', -2, null);
  await assert.rejects(stopRecoveryWorker(record, limits), /not an observed worker exit/);
  assert.equal(record.receipt.parentExitObserved, false);
});
