import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { observeSmokeChild, stopSmokeChild, withTimeout } from './mcp-smoke-cleanup.mjs';

export const recoveryLimits = Object.freeze({
  totalMs: 1_800_000, totalOutputBytes: 8 * 1024 * 1024,
  generationOutputBytes: 2 * 1024 * 1024, maximumGenerations: 5,
  ipcMs: 1_000, graceMs: 10_000, crashMs: 5_000, closeMs: 5_000,
});

/** Include the actual launcher's container root, even though this local profile refuses it. */
export function effectiveRecoveryDotenvRoots(application, env) {
  return [...new Set([path.resolve(application), path.resolve(env.FLUJO_CONTAINER
    ? '/app/data' : env.FLUJO_RUNTIME_ENV_DIR || application)])];
}

/** This equipment selects a local compiled package, never the Docker /app/data profile. */
export async function inspectRecoveryApplication(application, env, { compiled = true, filesystem = fs } = {}) {
  const roots = effectiveRecoveryDotenvRoots(application, env);
  assert.ok(!env.FLUJO_CONTAINER, 'Local compiled recovery refuses FLUJO_CONTAINER and its /app/data dotenv root.');
  assert.equal(roots.length, 1, 'Recovery runtime dotenv must stay at the admitted application root.');
  for (const root of roots) {
    for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) {
      await assert.rejects(filesystem.lstat(path.join(root, name)), error => error.code === 'ENOENT',
        'Smoke application must have no production dotenv files.');
    }
  }
  if (!compiled) return { profile: 'isolated-development', effectiveDotenvRoots: roots };
  const [manifest, build] = await Promise.all([
    filesystem.readFile(path.join(application, 'package.json'), 'utf8'),
    filesystem.readFile(path.join(application, '.next', 'BUILD_ID'), 'utf8'),
  ]);
  const pkg = JSON.parse(manifest);
  assert.equal(pkg.name, 'flujo-ai', 'Recovery application must be a compiled flujo-ai package.');
  assert.ok(typeof pkg.version === 'string' && build.trim(), 'Recovery package/build identity is incomplete.');
  return { profile: 'local-compiled-package', effectiveDotenvRoots: roots,
    packageVersion: pkg.version, buildId: build.trim(),
    sourceCorrespondence: 'requires-independent-payload-join', artifactDigest: 'not-verified-by-this-harness' };
}

/** One monotonic window and one output census across every worker generation. */
export function recoveryBudget({ totalMs = recoveryLimits.totalMs,
  maximumOutputBytes = recoveryLimits.totalOutputBytes, now = () => performance.now() } = {}) {
  assert.ok(Number.isSafeInteger(totalMs) && totalMs > 0 && Number.isSafeInteger(maximumOutputBytes)
    && maximumOutputBytes > 0, 'Recovery budget must be finite and positive.');
  const started = now();
  const controller = new AbortController();
  let outputBytes = 0;
  let failure;
  const refuse = error => {
    failure ??= error;
    if (!controller.signal.aborted) controller.abort(failure);
    return failure;
  };
  const assertOpen = () => {
    if (now() - started >= totalMs) refuse(new Error('Recovery whole-window deadline exceeded.'));
    if (failure) throw failure;
  };
  return { signal: controller.signal, refuse, assertOpen,
    remainingMs() { assertOpen(); return Math.max(1, totalMs - (now() - started)); },
    chargeOutput(bytes) {
      outputBytes += bytes;
      if (outputBytes > maximumOutputBytes) refuse(new Error('Recovery total worker output budget exceeded.'));
      assertOpen();
    },
    receipt() { return { elapsedMs: now() - started, deadlineMs: totalMs, outputBytes,
      maximumOutputBytes, outcome: failure ? 'failed-or-unknown' : 'within-budget' }; },
  };
}

/** Original ChildProcess observation only; no PID lookup, process group or tree signal. */
export function observeRecoveryWorker(child, generation) {
  const observation = observeSmokeChild(child);
  const receipt = { generation, pid: child.pid ?? null, startedAt: new Date().toISOString(),
    parentExitObserved: false, stdioCloseObserved: false, exitCode: null, signal: null,
    crashRequested: false, ipcStopRequested: false, signalAttempts: [], abandoned: false,
    descendantExit: 'unverified', ownership: 'original-direct-child-only', failure: null };
  observation.exit.then(({ code, signal }) => {
    receipt.parentExitObserved = true; receipt.exitCode = code; receipt.signal = signal;
    receipt.exitedAt = new Date().toISOString();
  });
  observation.close.then(() => {
    receipt.stdioCloseObserved = true; receipt.closedAt = new Date().toISOString();
  });
  child.on('error', () => { receipt.failure ??= 'original-worker-process-error'; });
  const kill = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    const attempt = { signal, delivered: false };
    receipt.signalAttempts.push(attempt);
    attempt.delivered = kill(signal);
    return attempt.delivered;
  };
  return { observation, receipt };
}

export async function stopRecoveryWorker(record, { crash = false,
  ipcMs = recoveryLimits.ipcMs, graceMs = recoveryLimits.graceMs,
  crashMs = recoveryLimits.crashMs, closeMs = recoveryLimits.closeMs } = {}) {
  const { observation, receipt } = record;
  const { child } = observation;
  if (observation.abandoned) throw new Error('Original recovery worker remains abandoned.');
  if (receipt.failure) {
    try { await stopSmokeChild(observation, 'failed recovery worker', { graceMs, killMs: crashMs, closeMs }); }
    finally { receipt.abandoned = observation.abandoned; }
    throw new Error('Original recovery worker remains failed.');
  }
  const alive = () => !observation.exited && !observation.closed && child.exitCode === null && child.signalCode === null;
  try {
    if (crash) {
      assert.ok(alive(), 'Crash requires the still-live original worker.');
      receipt.crashRequested = true;
      assert.ok(child.kill('SIGKILL'), 'Original worker crash signal was refused.');
      await withTimeout(observation.exit, crashMs, 'original recovery worker crash exit');
    } else if (alive()) {
      assert.ok(child.connected, 'Owned recovery IPC is disconnected.');
      receipt.ipcStopRequested = true;
      await withTimeout(new Promise((resolve, reject) => child.send('stop', error => error ? reject(error) : resolve())),
        ipcMs, 'original recovery worker stop request');
      await withTimeout(observation.exit, graceMs, 'original recovery worker graceful exit');
    }
    await withTimeout(observation.close, closeMs, 'original recovery worker stdio close');
    assert.ok(observation.exited, 'A failed spawn/close is not an observed worker exit.');
    if (!crash) assert.ok(receipt.exitCode === 0 || receipt.exitCode === 143,
      'Original recovery worker did not stop gracefully.');
  } catch (error) {
    let failure = error;
    receipt.failure = 'original-worker-stop-unresolved';
    // Reuse the admitted bounded direct-child fallback. A successful forced
    // terminal never turns the original graceful-stop failure into acceptance.
    try { await stopSmokeChild(observation, 'recovery worker', { graceMs, killMs: crashMs, closeMs }); }
    catch (cleanupError) { failure = new AggregateError([error, cleanupError], 'Recovery worker stop and fallback failed.'); }
    receipt.abandoned = observation.abandoned;
    throw failure;
  }
  receipt.abandoned = observation.abandoned;
  return receipt;
}
