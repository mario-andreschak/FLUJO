import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupSmokeSandbox, observeSmokeChild, stopSmokeChild, withSmokeCleanup, withTimeout } from './mcp-smoke-cleanup.mjs';

const limits = { graceMs: 20, killMs: 20, closeMs: 20 };
function fakeChild(onKill = () => {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, kills: [], destroyed: [], unrefs: 0 });
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = { destroy: () => child.destroyed.push(name) };
  child.unref = () => child.unrefs++;
  child.kill = (signal) => { child.kills.push(signal); onKill(child, signal); return true; };
  return child;
}
function exitChild(child, code = 0) { child.exitCode = code; child.emit('exit', code, null); }
function closeChild(child, code = 0) { child.emit('close', code, null); }

test('functional failure survives successful cleanup with its original stack', async () => {
  const primary = new Error('proxy initialization failed\nInstalled FLUJO logs: diagnostic');
  await assert.rejects(withSmokeCleanup(async () => { throw primary; }, async () => {}), (error) => error === primary);
});

test('functional failure and EBUSY remain visible together in rejection order', async () => {
  const primary = new Error('proxy initialization failed\nInstalled FLUJO logs: diagnostic');
  const busy = Object.assign(new Error('locked consumer directory'), { code: 'EBUSY', syscall: 'rmdir' });
  await assert.rejects(withSmokeCleanup(async () => { throw primary; }, () => cleanupSmokeSandbox({
    stop: async () => {}, remove: async () => { throw busy; }, sandbox: '/disposable/consumer',
  })), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.match(error.errors[0].stack, /Installed FLUJO logs/);
    assert.equal(error.errors[1].cause, busy);
    assert.match(error.errors[1].message, /remaining sandbox retained at/);
    return true;
  });
});

test('cleanup failure after functional success still fails the smoke', async () => {
  const cleanup = new Error('cleanup failed');
  await assert.rejects(withSmokeCleanup(async () => 'passed', async () => { throw cleanup; }), (error) => error === cleanup);
});

test('a falsey thrown value is preserved as a failure', async () => {
  await assert.rejects(withSmokeCleanup(async () => { throw undefined; }, async () => {}), (error) => error === undefined);
});

test('successful cleanup preserves the operation result', async () => {
  assert.equal(await withSmokeCleanup(async () => 'done', async () => {}), 'done');
});

test('unresolved stop retains the sandbox and never starts recursive removal', async () => {
  const primary = new Error('functional probe failed');
  const stop = new Error('stdio closure unknown');
  let removed = false;
  await assert.rejects(withSmokeCleanup(async () => { throw primary; }, () => cleanupSmokeSandbox({
    stop: async () => { throw stop; }, remove: async () => { removed = true; }, sandbox: '/retained/consumer',
  })), (error) => {
    assert.equal(error.errors[0], primary);
    assert.equal(error.errors[1].cause, stop);
    assert.match(error.errors[1].message, /sandbox retained at/);
    return true;
  });
  assert.equal(removed, false);
});

test('directory retry is finite and begins only after the original stop completes', async () => {
  const calls = [];
  await cleanupSmokeSandbox({
    stop: async () => { calls.push('stopped'); },
    remove: async (directory, options) => {
      assert.deepEqual(calls, ['stopped']);
      assert.equal(directory, '/owned/sandbox');
      assert.deepEqual(options, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      calls.push('removed');
    }, sandbox: '/owned/sandbox',
  });
  assert.deepEqual(calls, ['stopped', 'removed']);
});

test('direct exit alone does not permit cleanup before inherited stdio closes', async () => {
  const child = fakeChild();
  const observed = observeSmokeChild(child);
  exitChild(child);
  let stopped = false;
  const stopping = stopSmokeChild(observed, 'fixture', { ...limits, closeMs: 200 }).then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  assert.deepEqual(child.kills, []);
  closeChild(child);
  await stopping;
  assert.equal(observed.closed, true);
});

test('already closed original child is never signaled again', async () => {
  const child = fakeChild();
  const observed = observeSmokeChild(child);
  exitChild(child); closeChild(child);
  await stopSmokeChild(observed, 'fixture', limits);
  assert.deepEqual(child.kills, []);
});

test('stop waits for original exit and close after signaling the live direct child', async () => {
  const child = fakeChild((current) => { exitChild(current); closeChild(current); });
  const observed = observeSmokeChild(child);
  await stopSmokeChild(observed, 'fixture', limits);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(observed.exited, true);
  assert.equal(observed.closed, true);
  assert.equal(observed.abandoned, false);
});

test('an exited child with unclosed stdio is held without signaling any PID', async () => {
  const child = fakeChild();
  const observed = observeSmokeChild(child);
  exitChild(child);
  await assert.rejects(stopSmokeChild(observed, 'fixture', limits), /cleanup failed/);
  assert.equal(observed.abandoned, true);
  assert.deepEqual(child.kills, []);
  assert.deepEqual(child.destroyed, ['stdin', 'stdout', 'stderr']);
  assert.equal(child.unrefs, 1);
  // Releasing observer pipes must never become a later cleanup/exit proof.
  closeChild(child);
  await assert.rejects(stopSmokeChild(observed, 'fixture', limits), /remains unresolved/);
});

test('grace timeout remains a failure even when direct-child escalation exits and closes', async () => {
  const child = fakeChild((current, signal) => { if (signal === 'SIGKILL') { exitChild(current); closeChild(current); } });
  const observed = observeSmokeChild(child);
  await assert.rejects(stopSmokeChild(observed, 'fixture', limits), (error) => {
    assert.match(error.errors[0].message, /direct child to exit/);
    return true;
  });
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(observed.closed, true);
  assert.equal(observed.abandoned, false);
});

test('escalation timeout is bounded, retained, and never treated as observed closure', async () => {
  const child = fakeChild();
  const observed = observeSmokeChild(child);
  await assert.rejects(stopSmokeChild(observed, 'fixture', limits), (error) => {
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[1].message, /after escalation/);
    return true;
  });
  assert.equal(observed.closed, false);
  assert.equal(observed.abandoned, true);
});

test('failed-spawn close is awaited without inventing a process identity', async () => {
  const child = fakeChild(); child.pid = undefined;
  const observed = observeSmokeChild(child);
  closeChild(child, -2);
  await stopSmokeChild(observed, 'fixture', limits);
  assert.deepEqual(child.kills, []);
});

test('finite native fixture distinguishes direct exit from descendant-held stdio', { timeout: 5000 }, async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-smoke-close-fixture-'));
  const grandchildSource = "console.log('descendant-ready');setTimeout(()=>{console.log('descendant-finished');process.exit(0)},600)";
  const parentSource = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{cwd:process.cwd(),stdio:['ignore',process.stdout,process.stderr],env:process.env,detached:true,windowsHide:true});child.once('spawn',()=>{console.log(JSON.stringify({parentPid:process.pid,descendantPid:child.pid}));process.exit(0)});`;
  const child = spawn(process.execPath, ['-e', parentSource], { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true });
  const observed = observeSmokeChild(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    assert.deepEqual(await withTimeout(observed.exit, 2000, 'finite fixture direct exit'), { code: 0, signal: null });
    assert.equal(observed.closed, false, output);
    await stopSmokeChild(observed, 'finite fixture', { ...limits, closeMs: 2000 });
    assert.equal(observed.closed, true);
    assert.match(output, /descendant-finished/);
    const identities = JSON.parse(output.split('\n').find((line) => line.startsWith('{')));
    assert.equal(identities.parentPid, child.pid);
    assert.notEqual(identities.descendantPid, child.pid);
    console.log(JSON.stringify({ kind: 'finite-source-close-fixture', ...identities, directExitObserved: true, inheritedStdioCloseObserved: true, descendantsExitByOwn600msTimer: true, signalsSent: 0, installedAcceptance: false }));
  } finally {
    // Both fixture processes are finite and exit naturally; no PID/tree cleanup.
    await withTimeout(observed.close, 2000, 'finite fixture natural close');
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
