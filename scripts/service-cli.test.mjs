import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, isSameOrInside, killProcessTree, validateServiceName } from '../bin/cli/common.mjs';
import { prepareManagedRoot, readCurrent, rootPaths, writeCurrent } from '../bin/cli/managed-root.mjs';
import { logLimitsFromEnv, RotatingLog } from '../bin/cli/rotating-log.mjs';
import { acquireSupervisorLock, instanceRecordsFor, nextBackoffMs, stopLeftovers } from '../bin/cli/supervisor.mjs';
import { installWindowsTask, localTimestamp, taskAction, taskXml } from '../bin/cli/service-windows.mjs';
import { installSystemdUnit, systemdUnit, unitPath } from '../bin/cli/service-linux.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return directory;
}

const waitFor = async (check, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the expected state');
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
};

test('names that could reach a task name, a folder or a command are refused', () => {
  for (const name of ['pilot-1', 'a', 'A.b_c-1']) assert.equal(validateServiceName(name), name);
  for (const bad of ['', '../x', 'a b', 'a/b', 'a\\b', '-x', '.x', 'x.', 'a"b', 'a&b', 'x'.repeat(65), undefined]) {
    assert.throws(() => validateServiceName(bad), /The name must be/);
  }
});

test('folder containment treats a sibling with the same prefix as outside', () => {
  const base = path.resolve(os.tmpdir(), 'data');
  assert.equal(isSameOrInside(base, base), true);
  assert.equal(isSameOrInside(base, path.join(base, 'x')), true);
  assert.equal(isSameOrInside(base, `${base}-other`), false);
  assert.equal(isSameOrInside(base, path.dirname(base)), false);
});

test('the log never exceeds its limit, across rotation, huge writes and reopening', t => {
  const directory = tempDir(t);
  const file = path.join(directory, 'logs', 'flujo.log');
  const limits = { maxBytes: 64 * 1024, maxFiles: 2 };
  let log = new RotatingLog(file, limits);
  for (let index = 0; index < 500; index += 1) log.write(`${'x'.repeat(1000)}\n`);
  log.write(Buffer.alloc(1024 * 1024, 'y'));
  log.close();
  log = new RotatingLog(file, limits);
  log.line('after restart');
  log.close();
  const files = fs.readdirSync(path.dirname(file)).sort();
  assert.deepEqual(files, ['flujo.log', 'flujo.log.1', 'flujo.log.2']);
  const total = files.reduce((sum, name) => sum + fs.statSync(path.join(path.dirname(file), name)).size, 0);
  assert.ok(total <= limits.maxBytes * (limits.maxFiles + 1), `total ${total}`);
  assert.equal(log.failures, 0);
});

test('with no rotated files kept, the log still stays within its limit', t => {
  const file = path.join(tempDir(t), 'flujo.log');
  const log = new RotatingLog(file, { maxBytes: 64 * 1024, maxFiles: 0 });
  for (let index = 0; index < 300; index += 1) log.write(`${'z'.repeat(1000)}\n`);
  log.close();
  assert.ok(fs.statSync(file).size <= 64 * 1024);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['flujo.log']);
});

test('a log that cannot be opened does not stop the program', t => {
  const directory = tempDir(t);
  const blocked = path.join(directory, 'flujo.log');
  fs.mkdirSync(blocked);
  const log = new RotatingLog(blocked, { maxBytes: 64 * 1024, maxFiles: 1 });
  log.write('still running\n');
  log.line('still running');
  log.close();
  assert.ok(log.failures > 0);
});

test('log settings keep their defaults when a value is unusable', () => {
  assert.deepEqual(logLimitsFromEnv({}), { maxBytes: 20 * 1024 * 1024, maxFiles: 3 });
  assert.deepEqual(logLimitsFromEnv({ FLUJO_LOG_MAX_BYTES: 'lots', FLUJO_LOG_MAX_FILES: '-' }), { maxBytes: 20 * 1024 * 1024, maxFiles: 3 });
  assert.deepEqual(logLimitsFromEnv({ FLUJO_LOG_MAX_BYTES: '1', FLUJO_LOG_MAX_FILES: '9999' }), { maxBytes: 64 * 1024, maxFiles: 100 });
  assert.deepEqual(logLimitsFromEnv({ FLUJO_LOG_MAX_BYTES: '1048576', FLUJO_LOG_MAX_FILES: '0' }), { maxBytes: 1048576, maxFiles: 0 });
});

test('restart delay grows, then holds at one minute and never gives up', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 1000].map(nextBackoffMs), [1000, 2000, 5000, 15000, 30000, 60000, 60000, 60000]);
});

test('one supervisor per instance, and a lock from a dead process is taken over', t => {
  const lockFile = path.join(tempDir(t), 'supervisor.lock');
  const first = acquireSupervisorLock(lockFile, { pid: 111, alive: pid => pid === 111 });
  assert.equal(first.acquired, true);
  assert.deepEqual(acquireSupervisorLock(lockFile, { pid: 222, alive: pid => pid === 111 }), { acquired: false, holder: 111 });
  const takeover = acquireSupervisorLock(lockFile, { pid: 222, alive: () => false });
  assert.equal(takeover.acquired, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '222');
  takeover.release();
  assert.equal(fs.existsSync(lockFile), false);
  fs.writeFileSync(lockFile, 'garbage');
  assert.equal(acquireSupervisorLock(lockFile, { pid: 333, alive: () => false }).acquired, true);
});

test('a leftover is stopped only if it really is this instance', t => {
  const directory = tempDir(t);
  const root = path.join(directory, 'root');
  const data = path.join(directory, 'data');
  const instances = path.join(directory, 'instances');
  fs.mkdirSync(instances);
  const paths = prepareManagedRoot(root, repo);
  fs.writeFileSync(path.join(instances, 'ours.json'), JSON.stringify({ pid: 501, dataRoot: data }));
  fs.writeFileSync(path.join(instances, 'other.json'), JSON.stringify({ pid: 502, dataRoot: path.join(directory, 'other') }));
  fs.writeFileSync(path.join(instances, 'reused.json'), JSON.stringify({ pid: 503, dataRoot: data }));
  fs.writeFileSync(path.join(instances, 'dead.json'), JSON.stringify({ pid: 504, dataRoot: data }));
  fs.writeFileSync(path.join(instances, 'broken.json'), '{');
  fs.writeFileSync(paths.state, JSON.stringify({ childPid: 505 }));
  assert.equal(instanceRecordsFor(data, instances).length, 3);
  const killed = [];
  const lines = {
    501: 'node next/dist/bin/next start -p 4400',
    503: 'notepad.exe report-4400.txt',
    505: `node ${paths.launcher} --no-open --port 4400`,
  };
  const stopped = stopLeftovers({
    root, dataDir: data, port: 4400, instanceDirectory: instances,
    helpers: {
      isProcessAlive: pid => pid !== 504,
      processCommandLine: pid => lines[pid] ?? null,
      killProcessTree: pid => { killed.push(pid); return true; },
    },
  });
  assert.deepEqual(killed.sort(), [501, 505]);
  assert.equal(stopped, 2);
  assert.equal(fs.existsSync(path.join(instances, 'dead.json')), false);
  assert.equal(fs.existsSync(path.join(instances, 'reused.json')), true);
});

test('the launcher follows the chosen version, and falls back if that folder is gone', async t => {
  const directory = tempDir(t);
  const root = path.join(directory, 'root');
  const makePackage = (name) => {
    const dir = path.join(directory, name);
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: name }));
    fs.writeFileSync(path.join(dir, 'bin', 'flujo.mjs'), `console.log('running ${name}');\n`);
    return dir;
  };
  const one = makePackage('1.0.0');
  const two = makePackage('2.0.0');
  const paths = prepareManagedRoot(root, one);
  assert.equal(readCurrent(root).version, '1.0.0');
  const launch = () => new Promise(resolve => {
    const child = spawn(process.execPath, [paths.launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    child.on('exit', code => resolve({ code, out }));
  });
  assert.match((await launch()).out, /running 1\.0\.0/);
  writeCurrent(root, { version: '2.0.0', packageDir: two, previous: { version: '1.0.0', packageDir: one } });
  assert.match((await launch()).out, /running 2\.0\.0/);
  // Reinstalling must not put the old version back.
  prepareManagedRoot(root, one);
  assert.equal(readCurrent(root).version, '2.0.0');
  fs.rmSync(two, { recursive: true, force: true });
  const fallback = await launch();
  assert.match(fallback.out, /running 1\.0\.0/);
  assert.match(fallback.out, /previous one/);
  fs.rmSync(one, { recursive: true, force: true });
  assert.equal((await launch()).code, 78);
});

test('the Windows task runs as the user, not SYSTEM, and quotes paths safely', () => {
  const common = {
    name: 'pilot', userId: 'S-1-5-21-1-2-3-1001', nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    launcher: 'C:\\Flujo & Co\\launch.mjs', workingDirectory: 'C:\\Flujo & Co',
    serviceArgs: ['service', 'run', '--name', 'pilot', '--data-dir', 'C:\\My Data', '--port', '4400'],
    now: new Date(2026, 10, 4, 18, 5, 9),
  };
  const boot = taskXml({ ...common, mode: 'boot' });
  assert.match(boot, /<BootTrigger>/);
  assert.match(boot, /<LogonType>S4U<\/LogonType>/);
  assert.match(boot, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.doesNotMatch(boot, /S-1-5-18|SYSTEM|HighestAvailable/);
  assert.match(boot, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(boot, /C:\\Flujo &amp; Co\\launch\.mjs/);
  assert.match(boot, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(boot, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(boot, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(boot, /<Interval>PT5M<\/Interval>/);
  const logon = taskXml({ ...common, mode: 'logon' });
  assert.match(logon, /<LogonTrigger>/);
  assert.match(logon, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(logon, /conhost\.exe<\/Command>/);
  assert.match(logon, /--headless &quot;C:\\Program Files\\nodejs\\node\.exe&quot;/);
  const timer = taskXml({ ...common, mode: 'timer' });
  assert.match(timer, /<TimeTrigger>/);
  assert.match(timer, /<StartBoundary>2026-11-04T18:05:09<\/StartBoundary>/);
  assert.equal(localTimestamp(common.now), '2026-11-04T18:05:09');
  assert.equal(taskAction('boot', common).command, common.nodePath);
});

test('auto mode falls back one step at a time; a named mode does not fall back', t => {
  const directory = tempDir(t);
  const seenModes = [];
  const fakeRun = allowed => (command, args) => {
    if (command.endsWith('whoami.exe')) return { ok: true, stdout: '"pc\\moe","S-1-5-21-9-9-9-1001"\r\n' };
    const xml = fs.readFileSync(args[args.indexOf('/XML') + 1]);
    assert.deepEqual([...xml.subarray(0, 2)], [0xff, 0xfe], 'schtasks needs a UTF-16 byte order mark');
    const text = xml.subarray(2).toString('utf16le');
    const mode = text.includes('<BootTrigger>') ? 'boot' : text.includes('<LogonTrigger>') ? 'logon' : 'timer';
    seenModes.push(mode);
    return { ok: mode === allowed, stdout: '', stderr: '' };
  };
  const base = { name: 'pilot', nodePath: 'n', launcher: 'l', serviceArgs: [], workingDirectory: directory };
  assert.equal(installWindowsTask({ ...base, requestedMode: 'auto', run: fakeRun('boot') }).mode, 'boot');
  seenModes.length = 0;
  const fallback = installWindowsTask({ ...base, requestedMode: 'auto', run: fakeRun('logon') });
  assert.equal(fallback.mode, 'logon');
  assert.match(fallback.explanation, /administrator/);
  assert.deepEqual(seenModes, ['boot', 'logon']);
  assert.equal(installWindowsTask({ ...base, requestedMode: 'auto', run: fakeRun('timer') }).mode, 'timer');
  assert.throws(() => installWindowsTask({ ...base, requestedMode: 'boot', run: fakeRun('logon') }), /administrator rights/);
  assert.throws(() => installWindowsTask({ ...base, requestedMode: 'auto', run: fakeRun('none') }), /refused/);
  assert.deepEqual(fs.readdirSync(directory), [], 'no task definition is left behind');
});

test('the systemd unit restarts forever and escapes spaces and percent signs', () => {
  const unit = systemdUnit({
    name: 'pilot', nodePath: '/opt/node 22/bin/node', launcher: '/srv/flujo/launch.mjs',
    serviceArgs: ['service', 'run', '--data-dir', '/srv/100%/data'], workingDirectory: '/srv/flujo',
  });
  assert.match(unit, /ExecStart="\/opt\/node 22\/bin\/node" "\/srv\/flujo\/launch\.mjs" "service" "run" "--data-dir" "\/srv\/100%%\/data"/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /StartLimitIntervalSec=0/);
  assert.match(unit, /WantedBy=default\.target/);
  assert.doesNotMatch(unit, /^User=/m);
  const system = systemdUnit({ name: 'pilot', nodePath: 'n', launcher: 'l', serviceArgs: [], workingDirectory: '/', system: true, runAs: 'flujo' });
  assert.match(system, /^User=flujo$/m);
  assert.match(system, /WantedBy=multi-user\.target/);
});

test('on Linux, root must name an account, and missing systemd is reported honestly', t => {
  const homedir = tempDir(t);
  const base = { name: 'pilot', nodePath: 'n', launcher: 'l', serviceArgs: [], workingDirectory: '/', homedir, username: 'moe' };
  assert.throws(() => installSystemdUnit({ ...base, isRoot: true, run: () => ({ ok: true }) }), /--run-as/);
  assert.throws(() => installSystemdUnit({ ...base, isRoot: true, runAs: 'root', run: () => ({ ok: true }) }), /does not run as root/);
  const calls = [];
  const good = installSystemdUnit({ ...base, isRoot: false, run: (command, args) => { calls.push([command, ...args].join(' ')); return { ok: true }; } });
  assert.equal(good.mode, 'boot');
  assert.equal(good.enabled, true);
  assert.deepEqual(calls, ['systemctl --user daemon-reload', 'loginctl enable-linger moe', 'systemctl --user enable flujo-pilot.service']);
  assert.ok(fs.existsSync(unitPath('pilot', { system: false, homedir })));
  const noLinger = installSystemdUnit({ ...base, isRoot: false, run: command => ({ ok: command !== 'loginctl' }) });
  assert.equal(noLinger.mode, 'logon');
  assert.match(noLinger.explanation, /enable-linger moe/);
  const noSystemd = installSystemdUnit({ ...base, isRoot: false, run: () => ({ ok: false }) });
  assert.equal(noSystemd.enabled, false);
  assert.equal(noSystemd.mode, 'none');
});

/** A stand-in for bin/flujo.mjs: a tiny server that crashes when told to. */
const FAKE_FLUJO = `
import http from 'node:http';
import fs from 'node:fs';
const index = process.argv.indexOf('--port');
const port = Number(process.argv[index + 1]);
if (process.argv.includes('--no-open') === false) process.exit(55);
if (process.env.FAKE_START_LOG) fs.appendFileSync(process.env.FAKE_START_LOG, process.pid + '\\n');
http.createServer((request, response) => {
  if (request.url === '/crash') { response.end('bye'); setTimeout(() => process.exit(7), 20); return; }
  response.end('ok');
}).listen(port, '127.0.0.1', () => console.log('fake flujo listening on ' + port));
setInterval(() => {}, 1000);
`;

function freePort() {
  return new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startSupervisor({ root, data, port, extraEnv = {} }) {
  const script = path.join(root, 'run-supervisor.mjs');
  const importPath = path.join(repo, 'bin', 'cli', 'supervisor.mjs').replaceAll('\\', '/');
  fs.writeFileSync(script, `
import { runSupervisor } from 'file:///${importPath.replace(/^\/+/, '')}';
process.exit(await runSupervisor(JSON.parse(process.argv[2])));
`);
  const options = { name: 'test', dataDir: data, port, root, instanceDirectory: path.join(root, 'no-instances'), program: path.join(root, 'launch.mjs') };
  const child = spawn(process.execPath, [script, JSON.stringify(options)], {
    env: { ...process.env, ...extraEnv }, stdio: 'ignore', windowsHide: true,
  });
  return child;
}

test('real processes: restart after a crash, single supervisor, stop request stays, kill leaves no orphan', { timeout: 120_000 }, async t => {
  const directory = tempDir(t);
  const root = path.join(directory, 'root');
  const data = path.join(directory, 'data');
  fs.mkdirSync(data);
  const packageDir = path.join(directory, 'package');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(packageDir, 'bin', 'flujo.mjs'), FAKE_FLUJO);
  const paths = prepareManagedRoot(root, packageDir);
  const port = await freePort();
  const startLog = path.join(directory, 'starts.log');
  const env = { FAKE_START_LOG: startLog };
  const starts = () => (fs.existsSync(startLog) ? fs.readFileSync(startLog, 'utf8').trim().split('\n').length : 0);
  const answers = async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).ok; }
    catch { return false; }
  };
  const supervisor = startSupervisor({ root, data, port, extraEnv: env });
  t.after(() => {
    const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
    for (const pid of [supervisor.pid, state.childPid]) if (isProcessAlive(pid)) killProcessTree(pid, { signal: 'SIGKILL' });
  });
  await waitFor(answers);
  assert.equal(starts(), 1);
  assert.equal(fs.existsSync(paths.lock), true);

  // A second supervisor for the same instance leaves at once and changes nothing.
  const second = startSupervisor({ root, data, port, extraEnv: env });
  const secondExit = await new Promise(resolve => { second.on('exit', resolve); });
  assert.equal(secondExit, 0);
  assert.equal(starts(), 1);

  // Crash: FLUJO comes back with no help.
  await fetch(`http://127.0.0.1:${port}/crash`);
  await waitFor(() => starts() === 2);
  await waitFor(answers);
  let state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.equal(state.restarts, 1);
  assert.match(state.lastExit.description, /code 7/);

  // A stop request ends both programs, and nothing starts again by itself.
  fs.writeFileSync(paths.stopRequest, 'now');
  const code = await new Promise(resolve => { supervisor.on('exit', resolve); });
  assert.equal(code, 0);
  await waitFor(async () => !await answers());
  state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  assert.equal(state.childPid, null);
  assert.equal(fs.existsSync(paths.lock), false);
  const silent = startSupervisor({ root, data, port, extraEnv: env });
  assert.equal(await new Promise(resolve => { silent.on('exit', resolve); }), 0);
  assert.equal(starts(), 2);

  // Started again, the log holds what FLUJO printed plus the supervisor's notes.
  fs.rmSync(paths.stopRequest);
  const again = startSupervisor({ root, data, port, extraEnv: env });
  await waitFor(answers);
  assert.equal(starts(), 3);
  state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  const orphan = state.childPid;
  assert.ok(isProcessAlive(orphan));
  const logText = fs.readFileSync(paths.logFile, 'utf8');
  assert.match(logText, /fake flujo listening/);
  assert.match(logText, /Restart number 1/);

  // The supervisor dies without warning. On Windows the system ends its children
  // with it; on Linux FLUJO is left behind holding the port. Either way the next
  // supervisor must end up running FLUJO, not fail on a busy port forever.
  again.kill('SIGKILL');
  await new Promise(resolve => { again.on('exit', resolve); });
  const third = startSupervisor({ root, data, port, extraEnv: env });
  await waitFor(() => starts() === 4, 60_000);
  await waitFor(answers);
  assert.equal(isProcessAlive(orphan), false);
  fs.writeFileSync(paths.stopRequest, 'done');
  assert.equal(await new Promise(resolve => { third.on('exit', resolve); }), 0);
});

test('real processes: another program on the port is left alone and reported', { timeout: 60_000 }, async t => {
  const directory = tempDir(t);
  const root = path.join(directory, 'root');
  const packageDir = path.join(directory, 'package');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(packageDir, 'bin', 'flujo.mjs'), FAKE_FLUJO);
  const paths = prepareManagedRoot(root, packageDir);
  const foreign = http.createServer((request, response) => response.end('someone else'));
  const port = await new Promise(resolve => { foreign.listen(0, '127.0.0.1', () => resolve(foreign.address().port)); });
  t.after(() => foreign.close());
  const supervisor = startSupervisor({ root, data: directory, port });
  await waitFor(() => JSON.parse(fs.existsSync(paths.state) ? fs.readFileSync(paths.state, 'utf8') : '{}').lastProblem === 'port-in-use');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'someone else');
  fs.writeFileSync(paths.stopRequest, 'done');
  assert.equal(await new Promise(resolve => { supervisor.on('exit', resolve); }), 0);
  assert.match(fs.readFileSync(paths.logFile, 'utf8'), /used by another program/);
  assert.equal(rootPaths(root).logFile, paths.logFile);
});
