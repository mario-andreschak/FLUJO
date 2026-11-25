import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  defaultDriveHome, evidencePath, isOwnedDataDir, main, parseArgs, parseViewport, routeUrl, stateFileFor, stopPlan, validateSteps,
} from './flujo-drive.mjs';

const SCRIPT = fileURLToPath(new URL('./flujo-drive.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('arguments split into command, positional values and options', () => {
  assert.deepEqual(parseArgs(['click', '/flows', '--role', 'button', '--name', 'New agent', '--full', '--viewport=360x800']), {
    command: 'click',
    positional: ['/flows'],
    options: { role: 'button', name: 'New agent', full: true, viewport: '360x800' },
  });
});

test('viewports and routes are checked before a browser starts', () => {
  assert.deepEqual(parseViewport('360x800'), { width: 360, height: 800 });
  assert.throws(() => parseViewport('wide'), /1280x720/);
  assert.equal(routeUrl('http://127.0.0.1:4317/', '/roles/new'), 'http://127.0.0.1:4317/roles/new');
  assert.equal(routeUrl('http://127.0.0.1:4317/', 'chat'), 'http://127.0.0.1:4317/chat');
  assert.throws(() => routeUrl('http://127.0.0.1:4317/', 'https://example.com/'), /Pass a route/);
  assert.throws(() => routeUrl('http://127.0.0.1:4317/', 'C:/Program Files/Git/flows'), /Git Bash rewrites/);
});

test('relative evidence paths land in the evidence folder outside the repository', () => {
  assert.equal(evidencePath('flows/after.png', '/tmp/evidence'), path.join('/tmp/evidence', 'flows/after.png'));
  const absolute = path.resolve('/elsewhere/after.png');
  assert.equal(evidencePath(absolute, '/tmp/evidence'), absolute);
});

test('steps files are validated with a message that names the step', () => {
  assert.doesNotThrow(() => validateSteps([{ do: 'goto', route: '/flows' }, { do: 'click', role: 'button', name: 'Save' }, { do: 'shot', out: 'a.png' }]));
  assert.throws(() => validateSteps([]), /non-empty/);
  assert.throws(() => validateSteps([{ do: 'hover' }]), /step 1: "do" must be one of/);
  assert.throws(() => validateSteps([{ do: 'goto', route: '/' }, { do: 'fill', label: 'Name' }]), /step 2 \(fill\) needs "value"/);
  assert.doesNotThrow(() => validateSteps([{ do: 'drop-file', role: 'heading', name: 'MCP servers', file: 'a.mcpb' }]));
  assert.throws(() => validateSteps([{ do: 'choose-file', role: 'menuitem', name: 'MCP bundle' }]), /step 1 \(choose-file\) needs "file"/);
});

test('commands with missing options fail before launching a browser', async () => {
  await assert.rejects(main(['shot', '/flows'], () => {}), /--out/);
  await assert.rejects(main(['click', '/flows', '--role', 'button'], () => {}), /--role and --name/);
  const lines = [];
  assert.equal(await main([], (line) => lines.push(line)), 0);
  assert.match(lines.join('\n'), /Usage: node scripts\/flujo-drive\.mjs/);
});

test('the state and evidence folder is private to the user, never the shared temp folder', () => {
  assert.equal(defaultDriveHome({}, 'linux', '/home/ana'), path.join('/home/ana', '.cache', 'flujo-drive'));
  assert.equal(defaultDriveHome({ XDG_CACHE_HOME: '/srv/cache' }, 'linux', '/home/ana'), path.join('/srv/cache', 'flujo-drive'));
  const local = path.join('/Users', 'ana', 'AppData', 'Local');
  assert.equal(defaultDriveHome({ LOCALAPPDATA: local }, 'win32', path.join('/Users', 'ana')), path.join(local, 'flujo-drive'));
  assert.equal(defaultDriveHome({ FLUJO_DRIVE_HOME: '/custom/drive' }, 'linux', '/home/ana'), path.resolve('/custom/drive'));
});

test('only a data folder this tool created in the temp folder counts as its own', () => {
  const temp = os.tmpdir();
  const created = mkdtempSync(path.join(temp, 'flujo-drive-data-'));
  try {
    assert.equal(isOwnedDataDir(created, temp), true);
    assert.equal(isOwnedDataDir(temp, temp), false);
    assert.equal(isOwnedDataDir(os.homedir(), temp), false);
    assert.equal(isOwnedDataDir(path.join(created, 'nested'), temp), false);
    assert.equal(isOwnedDataDir(path.join(created, '..', 'important'), temp), false);
    assert.equal(isOwnedDataDir('flujo-drive-data-abc123', temp), false);
    assert.equal(isOwnedDataDir(undefined, temp), false);
  } finally {
    rmSync(created, { recursive: true, force: true });
  }
});

test('stop ignores a process id that would signal more than one process', () => {
  assert.deepEqual(stopPlan({ pid: 0, ownsDataDir: true, dataDir: os.homedir() }), { pid: undefined, dataDir: undefined });
  assert.deepEqual(stopPlan({ pid: -5 }), { pid: undefined, dataDir: undefined });
  assert.deepEqual(stopPlan({ pid: '42' }), { pid: undefined, dataDir: undefined });
  assert.equal(stopPlan({ pid: 42 }).pid, 42);
});

test('stop never deletes a folder it did not create, whatever the state file says', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'flujo-drive-test-'));
  try {
    const home = path.join(sandbox, 'home');
    const precious = path.join(sandbox, 'precious');
    mkdirSync(home);
    mkdirSync(precious);
    writeFileSync(path.join(precious, 'keep.txt'), 'keep');
    const finished = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(stateFileFor(ROOT, home), JSON.stringify({ pid: finished.pid, dataDir: precious, ownsDataDir: true }));
    const result = spawnSync(process.execPath, [SCRIPT, 'stop'], {
      env: { ...process.env, FLUJO_DRIVE_HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(path.join(precious, 'keep.txt')), true);
    assert.match(result.stdout, /precious is not a data folder this tool created.*left in place/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('each checkout keeps its own state file', () => {
  const home = path.join('/home', 'ana', '.cache', 'flujo-drive');
  const one = stateFileFor('/work/flujo', home, 'linux');
  assert.equal(path.dirname(one), home);
  assert.equal(stateFileFor('/work/flujo/', home, 'linux'), one);
  assert.notEqual(stateFileFor('/work/flujo-worktree', home, 'linux'), one);
  assert.equal(stateFileFor('C:\\Work\\FLUJO', home, 'win32'), stateFileFor('c:\\work\\flujo', home, 'win32'));
});

test('stop in one checkout leaves an instance started from another checkout alone', () => {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'flujo-drive-test-'));
  try {
    const home = path.join(sandbox, 'home');
    const theirs = path.join(sandbox, 'flujo-drive-data-abc123');
    mkdirSync(home);
    mkdirSync(theirs);
    const shared = path.join(home, 'instance.json');
    const finished = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(shared, JSON.stringify({ pid: finished.pid, dataDir: theirs, ownsDataDir: true, root: path.join(sandbox, 'other-checkout') }));
    const result = spawnSync(process.execPath, [SCRIPT, 'stop'], { env: { ...process.env, FLUJO_DRIVE_HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to stop/);
    assert.equal(existsSync(shared), true);
    assert.equal(existsSync(theirs), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
