/**
 * `flujo update` from end to end with real package files, real `npm install`, real
 * processes and real data copies. Only the FLUJO server is replaced, by a tiny
 * stand-in, so this runs in seconds per update rather than needing a production build.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findActiveRuns, isInsideWindow, npmCommand, pruneRoot, verifyPackageFile, waitUntilUsable } from '../bin/cli/update.mjs';
import { prepareManagedRoot, readCurrent, rootPaths, writeCurrent } from '../bin/cli/managed-root.mjs';
import { isProcessAlive, killProcessTree } from '../bin/cli/common.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flujo = path.join(repo, 'bin', 'flujo.mjs');
const cliIndex = pathToFileURL(path.join(repo, 'bin', 'cli', 'index.mjs')).href;

/**
 * Service commands run the real code. Otherwise a tiny server. `behavior` decides how
 * this version misbehaves. Each version writes into the data directory, so a test can
 * see whose data it is looking at.
 */
const standIn = behavior => `
if (process.argv[2] === 'service') {
  const { runSubcommand } = await import(${JSON.stringify(cliIndex)});
  process.exit(await runSubcommand('service', process.argv.slice(3)));
}
import('node:fs').then(async ({ default: fs }) => {
  const http = await import('node:http');
  const path = await import('node:path');
  const { readFileSync } = fs;
  const self = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const behavior = ${JSON.stringify(behavior)};
  if (behavior === 'no-start') { console.error('cannot start'); process.exit(1); }
  const data = process.env.FLUJO_DATA_DIR;
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'last-writer.txt'), self);
  fs.appendFileSync(path.join(data, 'history.txt'), self + '\\n');
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname === '/api/workspaces') return json(response, { workspaces: [{ name: 'default-workspace' }] });
    if (url.pathname === '/api/operations/status') {
      const running = fs.existsSync(path.join(data, 'pretend-running')) ? 1 : 0;
      return json(response, { activeRuns: [], scheduler: { runningRuns: running } });
    }
    if (url.pathname === '/api/cwd') return json(response, { success: true, version: self });
    if (url.pathname === '/api/operations/selftest') {
      if (behavior === 'never-answers') return undefined;
      if (behavior === 'no-selftest-route') return json(response, { error: 'not found' }, 404);
      const good = behavior !== 'bad-selftest';
      return json(response, {
        format: 'flujo-selftest', version: 1, workspace: 'default-workspace', collectedAt: new Date().toISOString(), usable: good,
        checks: [{ id: 'storage', status: good ? 'ok' : 'fail', reason: good ? undefined : 'not-writable' }, { id: 'flows', status: 'ok', count: 0 }],
      });
    }
    return response.end('ok');
  }).listen(port, '127.0.0.1');
  setInterval(() => {}, 1000);
});
`;

function sha512Of(file) {
  return `sha512-${createHash('sha512').update(fs.readFileSync(file)).digest('base64')}`;
}

function packStandIn(directory, version, behavior = 'good', name = 'flujo-ai') {
  const source = path.join(directory, `src-${version}-${behavior}`);
  fs.mkdirSync(path.join(source, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name, version, type: 'module', bin: { flujo: 'bin/flujo.mjs' } }));
  fs.writeFileSync(path.join(source, 'bin', 'flujo.mjs'), behavior === 'broken' ? "throw new Error('broken at import');\n" : standIn(behavior));
  const destination = path.join(directory, `pkg-${version}-${behavior}`);
  fs.mkdirSync(destination, { recursive: true });
  const packed = spawnSync(process.execPath, [npmCommand(), 'pack', source, '--pack-destination', destination, '--silent'], { encoding: 'utf8', windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const file = path.join(destination, fs.readdirSync(destination).find(entry => entry.endsWith('.tgz')));
  return { file, integrity: sha512Of(file) };
}

function freePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const waitFor = async (check, timeoutMs = 45_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state');
    await new Promise(resolve => { setTimeout(resolve, 150); });
  }
};

/** A managed instance, version 1.0.0, running under the real supervisor. */
async function instance(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-update-'));
  const root = path.join(directory, 'root');
  const data = path.join(directory, 'data');
  const port = await freePort();
  const name = 'upd';
  const paths = rootPaths(root);
  const cli = (command, ...args) => spawnSync(process.execPath, [flujo, command, ...args, '--name', name, '--root', root, '--json'], {
    encoding: 'utf8', windowsHide: true, timeout: 180_000,
  });
  const answers = async () => {
    try { return await (await fetch(`http://127.0.0.1:${port}/api/cwd`, { signal: AbortSignal.timeout(2000) })).json(); }
    catch { return null; }
  };
  // The old version lives outside versions/, as it does after a first install.
  const old = packStandIn(directory, '1.0.0');
  const oldDir = path.join(directory, 'installed-1.0.0');
  fs.mkdirSync(oldDir);
  assert.equal(spawnSync(process.execPath, [npmCommand(), 'install', old.file, '--prefix', oldDir, '--no-audit', '--no-fund', '--no-save', '--loglevel=error'], { windowsHide: true }).status, 0);
  const oldPackage = path.join(oldDir, 'node_modules', 'flujo-ai');
  fs.mkdirSync(root, { recursive: true });
  prepareManagedRoot(root, oldPackage);
  const installed = cli('service', 'install', '--data-dir', data, '--port', String(port), '--mode', 'none');
  assert.equal(installed.status, 0, installed.stderr);
  await waitFor(answers);
  fs.writeFileSync(path.join(data, 'precious.txt'), 'keep me');
  t.after(() => {
    cli('service', 'uninstall');
    const state = JSON.parse(fs.existsSync(paths.state) ? fs.readFileSync(paths.state, 'utf8') : '{}');
    for (const pid of [state.childPid, state.supervisorPid]) if (isProcessAlive(pid)) killProcessTree(pid, { signal: 'SIGKILL' });
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 300 });
  });
  const update = (version, pack, ...extra) => {
    const result = cli('update', '--to', version, '--package', pack.file, '--integrity', pack.integrity, ...extra);
    let json = null;
    try { json = JSON.parse(result.stdout); } catch { /* A refusal is plain text on stderr. */ }
    return { status: result.status, json, stderr: result.stderr };
  };
  return { directory, root, data, port, paths, cli, answers, update, oldPackage };
}

test('a time window may cross midnight, and a typo is refused rather than meaning never', () => {
  const at = (hours, minutes = 0) => new Date(2026, 10, 5, hours, minutes);
  assert.equal(isInsideWindow('01:00-05:00', at(3)), true);
  assert.equal(isInsideWindow('01:00-05:00', at(5)), false);
  assert.equal(isInsideWindow('01:00-05:00', at(0, 59)), false);
  assert.equal(isInsideWindow('22:00-04:00', at(23)), true);
  assert.equal(isInsideWindow('22:00-04:00', at(3, 59)), true);
  assert.equal(isInsideWindow('22:00-04:00', at(12)), false);
  assert.equal(isInsideWindow('00:00-00:00', at(12)), true);
  for (const bad of ['', 'tonight', '25:00-26:00', '1-5', '01:00', undefined]) assert.throws(() => isInsideWindow(bad), /time window/);
});

test('a package must match every given hash, and no hash at all is refused', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-hash-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'a.tgz');
  fs.writeFileSync(file, 'content');
  const integrity = sha512Of(file);
  const sha256 = createHash('sha256').update('content').digest('hex');
  assert.equal(verifyPackageFile(file, { integrity }), integrity);
  assert.equal(verifyPackageFile(file, { sha256 }), integrity);
  assert.equal(verifyPackageFile(file, { integrity, sha256 }), integrity);
  assert.throws(() => verifyPackageFile(file, {}), /needs --integrity or --sha256/);
  assert.throws(() => verifyPackageFile(file, { integrity: 'md5-abc' }), /must look like/);
  assert.throws(() => verifyPackageFile(file, { sha256: 'abc' }), /64 hexadecimal/);
  assert.throws(() => verifyPackageFile(file, { integrity: `sha512-${Buffer.alloc(64).toString('base64')}` }), /does not match/);
  assert.throws(() => verifyPackageFile(file, { integrity, sha256: '0'.repeat(64) }), /does not match/);
});

test('active runs: running blocks, waiting does not, and unknown is never read as none', async () => {
  const answer = routes => async url => {
    const { pathname } = new URL(url);
    const entry = routes[pathname];
    if (entry instanceof Error) throw entry;
    return Response.json(entry?.body ?? {}, { status: entry?.status ?? 200 });
  };
  const list = { body: { workspaces: [{ name: 'a' }] } };
  const run = status => findActiveRuns({ port: 1, request: answer({ '/api/workspaces': list, '/api/operations/status': status }) });
  assert.deepEqual(await run({ body: { activeRuns: [{ status: 'running' }], scheduler: { runningRuns: 0 } } }), { known: true, answering: true, running: 1 });
  assert.deepEqual(await run({ body: { activeRuns: [{ status: 'awaiting_tool_approval' }], scheduler: { runningRuns: 0 } } }), { known: true, answering: true, running: 0 });
  assert.equal((await run({ status: 401 })).known, false);
  assert.equal((await run({ status: 503 })).known, false);
  assert.equal((await run({ status: 423 })).locked, true);
  assert.deepEqual(await findActiveRuns({ port: 1, request: answer({ '/api/workspaces': new Error('refused') }) }), { known: true, answering: false, running: 0 });
});

test('verdict: a locked instance counts only if it was locked before', async () => {
  const locked = async () => new Response('{}', { status: 423 });
  const base = { port: 1, deadlineMs: 300, pauseMs: 10, request: locked };
  assert.equal((await waitUntilUsable({ ...base, acceptLocked: false })).usable, false);
  assert.equal((await waitUntilUsable({ ...base, acceptLocked: true })).lockedAccepted, true);
});

test('pruning keeps what is in use and the newest two data copies', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = rootPaths(root);
  const keep = version => path.join(paths.versions, version, 'node_modules', 'flujo-ai');
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) fs.mkdirSync(keep(version), { recursive: true });
  fs.mkdirSync(path.join(paths.versions, '.staging-x'), { recursive: true });
  for (const name of ['2026-01-a', '2026-02-b', '2026-03-c', '2026-04-d.partial']) fs.mkdirSync(path.join(paths.backups, name), { recursive: true });
  writeCurrent(root, { version: '3.0.0', packageDir: keep('3.0.0'), previous: { version: '2.0.0', packageDir: keep('2.0.0') } });
  pruneRoot(root);
  assert.deepEqual(fs.readdirSync(paths.versions).sort(), ['2.0.0', '3.0.0']);
  assert.deepEqual(fs.readdirSync(paths.backups).sort(), ['2026-02-b', '2026-03-c']);
});

test('update from end to end: refusals change nothing, success switches and keeps the data', { timeout: 300_000 }, async t => {
  const box = await instance(t);
  const two = packStandIn(box.directory, '2.0.0');
  const three = packStandIn(box.directory, '3.0.0');
  const four = packStandIn(box.directory, '4.0.0');

  // Refused before anything is stopped.
  const wrongHash = box.update('2.0.0', { ...two, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` });
  assert.equal(wrongHash.status, 1);
  assert.match(wrongHash.stderr, /does not match/);
  const wrongVersion = box.update('9.9.9', two);
  assert.equal(wrongVersion.status, 1);
  assert.match(wrongVersion.stderr, /is not flujo-ai 9\.9\.9/);
  const stranger = packStandIn(box.directory, '2.0.0', 'good', 'some-other-package');
  assert.equal(box.update('2.0.0', stranger).status, 1);
  assert.equal(box.cli('update', '--to', 'latest').status, 1);
  const hour = new Date().getHours();
  const shut = `${String((hour + 2) % 24).padStart(2, '0')}:00-${String((hour + 3) % 24).padStart(2, '0')}:00`;
  assert.equal(box.update('2.0.0', two, '--window', shut).status, 4);
  fs.writeFileSync(path.join(box.data, 'pretend-running'), '');
  const busy = box.update('2.0.0', two);
  assert.equal(busy.status, 5);
  assert.match(busy.stderr, /in progress/);
  fs.rmSync(path.join(box.data, 'pretend-running'));
  assert.equal(readCurrent(box.root).version, '1.0.0');
  assert.equal((await box.answers())?.version, '1.0.0', 'all of that left the old version running');
  assert.deepEqual(fs.existsSync(box.paths.updateJournal), false);

  // Success.
  const good = box.update('2.0.0', two);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.json.outcome, 'updated');
  assert.equal(good.json.integrity, two.integrity);
  assert.equal((await box.answers())?.version, '2.0.0');
  assert.equal(fs.readFileSync(path.join(box.data, 'precious.txt'), 'utf8'), 'keep me');
  assert.equal(readCurrent(box.root).previous.version, '1.0.0');
  assert.equal(fs.existsSync(box.paths.updateJournal), false);
  assert.equal(fs.existsSync(box.paths.stopRequest), false);

  // A second run to the same version does nothing.
  const same = box.update('2.0.0', two);
  assert.equal(same.status, 0);
  assert.equal(same.json.outcome, 'already-current');

  // Keeps the last two versions and copies; the original folder is not ours to delete.
  assert.equal(box.update('3.0.0', three).status, 0);
  assert.equal(box.update('4.0.0', four).status, 0);
  assert.deepEqual(fs.readdirSync(box.paths.versions).sort(), ['3.0.0', '4.0.0']);
  assert.equal(fs.readdirSync(box.paths.backups).length, 2);
  assert.ok(fs.existsSync(path.join(box.oldPackage, 'package.json')));

  // Stopped on purpose stays the owner's decision.
  assert.equal(box.cli('service', 'stop').status, 0);
  const stopped = box.update('2.0.0', two);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /stopped on purpose/);
  assert.equal(box.cli('service', 'start').status, 0);
  await waitFor(box.answers);
});

test('update: failed self-test and a version that cannot start both go back, with the old data', { timeout: 300_000 }, async t => {
  const box = await instance(t);
  const bad = packStandIn(box.directory, '2.0.0', 'bad-selftest');
  const failed = box.update('2.0.0', bad);
  assert.equal(failed.status, 3, failed.stderr);
  assert.equal(failed.json.outcome, 'went-back');
  assert.equal(failed.json.failedReason, 'storage');
  assert.equal((await box.answers())?.version, '1.0.0');
  assert.equal(readCurrent(box.root).version, '1.0.0');
  // What the failed version wrote is gone: it is the old data, plus the old version
  // writing again on its restart.
  const history = fs.readFileSync(path.join(box.data, 'history.txt'), 'utf8').trim().split('\n');
  assert.equal(history.includes('2.0.0'), false);
  assert.equal(fs.readFileSync(path.join(box.data, 'precious.txt'), 'utf8'), 'keep me');
  assert.equal(fs.existsSync(path.join(box.paths.versions, '2.0.0')), false);
  assert.equal(fs.existsSync(`${box.data}.discarded`), false);
  assert.equal(fs.existsSync(`${box.data}.restoring`), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.root, 'last-update.json'), 'utf8')).outcome, 'went-back');

  const dead = packStandIn(box.directory, '2.0.1', 'no-start');
  const notStarting = box.update('2.0.1', dead, '--selftest-timeout', '6');
  assert.equal(notStarting.status, 3, notStarting.stderr);
  assert.equal((await box.answers())?.version, '1.0.0');

  // An older version with no self-test route is judged by whether it is ready.
  const older = packStandIn(box.directory, '2.0.2', 'no-selftest-route');
  const accepted = box.update('2.0.2', older);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.json.selftest.basic, true);
});

test('update: power cut with a version too broken to run anything is still undone', { timeout: 300_000 }, async t => {
  const box = await instance(t);
  const broken = packStandIn(box.directory, '2.0.0', 'broken');
  const running = spawn(process.execPath, [flujo, 'update', '--to', '2.0.0', '--package', broken.file, '--integrity', broken.integrity,
    '--selftest-timeout', '120', '--name', 'upd', '--root', box.root], { stdio: 'ignore', windowsHide: true });
  await waitFor(() => {
    try { return JSON.parse(fs.readFileSync(box.paths.updateJournal, 'utf8')).phase === 'switched'; }
    catch { return false; }
  }, 120_000);
  await waitFor(() => JSON.parse(fs.readFileSync(box.paths.state, 'utf8')).lastExit !== null);
  const state = JSON.parse(fs.readFileSync(box.paths.state, 'utf8'));
  killProcessTree(running.pid, { signal: 'SIGKILL' });
  killProcessTree(state.supervisorPid, { signal: 'SIGKILL' });
  assert.equal(readCurrent(box.root).version, '2.0.0');
  // The next start must not depend on the broken version's code in any way.
  assert.equal(box.cli('service', 'start').status, 0);
  await waitFor(async () => (await box.answers())?.version === '1.0.0', 60_000);
  assert.equal(readCurrent(box.root).version, '1.0.0');
  assert.equal(fs.existsSync(box.paths.updateJournal), false);
});

test('update: power cut during the self-test is undone at the next start', { timeout: 300_000 }, async t => {
  const box = await instance(t);
  const hangs = packStandIn(box.directory, '2.0.0', 'never-answers');
  const running = spawn(process.execPath, [flujo, 'update', '--to', '2.0.0', '--package', hangs.file, '--integrity', hangs.integrity,
    '--selftest-timeout', '120', '--name', 'upd', '--root', box.root], { stdio: 'ignore', windowsHide: true });
  await waitFor(async () => (await box.answers())?.version === '2.0.0', 120_000);
  assert.equal(JSON.parse(fs.readFileSync(box.paths.updateJournal, 'utf8')).phase, 'switched');
  // The update and the instance vanish at once, as in a power cut.
  const state = JSON.parse(fs.readFileSync(box.paths.state, 'utf8'));
  killProcessTree(running.pid, { signal: 'SIGKILL' });
  killProcessTree(state.supervisorPid, { signal: 'SIGKILL' });
  await waitFor(async () => !await box.answers());
  assert.equal(readCurrent(box.root).version, '2.0.0', 'still switched, until something recovers it');

  // The next start finds the journal and goes back by itself.
  assert.equal(box.cli('service', 'start').status, 0);
  await waitFor(async () => (await box.answers())?.version === '1.0.0', 60_000);
  assert.equal(readCurrent(box.root).version, '1.0.0');
  assert.equal(fs.existsSync(box.paths.updateJournal), false);
  assert.equal(fs.existsSync(box.paths.stopRequest), false);
  const history = fs.readFileSync(path.join(box.data, 'history.txt'), 'utf8').trim().split('\n');
  assert.equal(history.includes('2.0.0'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.root, 'last-update.json'), 'utf8')).outcome, 'interrupted-and-recovered');
});
