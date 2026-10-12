import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const probe = fileURLToPath(new URL('./probe-filesystem-identity.mjs', import.meta.url));
const namespaceHook = String.raw`
import { promises as fs, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mkdtemp = fs.mkdtemp.bind(fs), lstat = fs.lstat.bind(fs), open = fs.open.bind(fs);
const unlink = fs.unlink.bind(fs), rmdir = fs.rmdir.bind(fs);
const parent = path.resolve(process.env.TEMP), mode = process.env.PROBE_CONTROL_MODE;
let root, rootIdentity, leaf, original, unexpected, namedCalls = 0, openCalls = 0;
let triggered = false, unlinkCalls = 0, rmdirCalls = 0;
fs.mkdtemp = async (...args) => {
  const value = await mkdtemp(...args);
  if (path.dirname(path.resolve(args[0])) === parent
      && path.basename(args[0]).startsWith('flujo-owned-fs-identity-')) {
    root = value; rootIdentity = await lstat(root, { bigint: true });
    leaf = path.join(root, 'owned-' + (process.env.PROBE_CONTROL_INDEX ?? '0') + '.json');
  }
  return value;
};
async function substitute() {
  if (path.dirname(root) !== parent || path.dirname(leaf) !== root) throw new Error('Fixture boundary changed');
  const now = await lstat(root, { bigint: true });
  if (!now.isDirectory() || now.isSymbolicLink()
      || ['dev', 'ino', 'mode', 'uid', 'gid'].some(field => now[field] !== rootIdentity[field])) throw new Error('Fixture directory changed');
  if (mode === 'parent') {
    original = root + '.original-directory';
    const foreign = path.join(parent, 'foreign-fixture-directory');
    if (path.dirname(original) !== parent || path.dirname(foreign) !== parent
        || existsSync(original) || existsSync(foreign)) throw new Error('Move destinations are not fresh');
    await fs.rename(root, original);
    await fs.mkdir(foreign);
    unexpected = path.join(foreign, path.basename(leaf));
    await fs.writeFile(unexpected, '{"unexpected":true}\n', { flag: 'wx', mode: 0o600 });
    await fs.symlink(foreign, root, process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    original = leaf + '.original'; unexpected = leaf;
    if (path.dirname(original) !== root || existsSync(original)) throw new Error('Leaf destination is not fresh');
    await fs.rename(leaf, original);
    await fs.writeFile(leaf, '{"unexpected":true}\n', { flag: 'wx', mode: 0o600 });
  }
  triggered = true;
}
fs.open = async (target, ...args) => {
  const selected = (mode === 'reader' || mode === 'parent') && leaf && path.resolve(target) === leaf;
  const second = selected && ++openCalls === 2;
  if (mode === 'reader' && second) await substitute();
  const handle = await open(target, ...args);
  if (mode === 'parent' && second) {
    const close = handle.close.bind(handle);
    handle.close = async (...values) => {
      const value = await close(...values);
      await substitute();
      return value;
    };
  }
  return handle;
};
fs.lstat = async (target, ...args) => {
  const actual = await lstat(target, ...args);
  if (mode === 'leaf' && leaf && path.resolve(target) === leaf
      && ++namedCalls === Number(process.env.PROBE_CONTROL_NAMED_COUNT)) await substitute();
  return actual;
};
fs.unlink = async (...args) => { unlinkCalls++; return unlink(...args); };
fs.rmdir = async (...args) => { rmdirCalls++; return rmdir(...args); };
process.on('exit', () => writeFileSync(process.env.PROBE_CONTROL_MARKER, JSON.stringify({ root,
  original, unexpected, triggered, unlinkCalls, rmdirCalls,
  originalPresent: original ? existsSync(original) : false,
  unexpectedPresent: unexpected ? existsSync(unexpected) : false })));
`;

async function runProbe({ mode = 'none', namedCount = 0, index = 0 } = {}) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-fs-probe-test-'));
  const markerPath = path.join(fixture, 'marker.json');
  const hookPath = path.join(fixture, 'hook.mjs');
  await fs.writeFile(hookPath, namespaceHook);
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(hookPath).href, probe],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, TEMP: fixture, TMP: fixture, TMPDIR: fixture,
      PROBE_CONTROL_MARKER: markerPath, PROBE_CONTROL_MODE: mode,
      PROBE_CONTROL_NAMED_COUNT: String(namedCount), PROBE_CONTROL_INDEX: String(index) } });
  assert.ifError(result.error);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  const control = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  assert.equal(path.dirname(path.resolve(control.root)), fixture);
  assert.equal(report.cleanupPolicy, 'retain-probe-files');
  assert.equal(report.cleanupAttempted, false);
  assert.equal(report.cleanupCompleted, false);
  assert.equal(report.cleanupFailure, null);
  assert.equal(report.installedStartupQualified, false);
  assert.equal(control.unlinkCalls, 0);
  assert.equal(control.rmdirCalls, 0);
  // Retain fixtures under the same policy. The probe never grants a later
  // pathname deletion authority over a sampled inode.
  return { result, report, control };
}

test('collects six native samples and explicitly retains its diagnostic files', async () => {
  const observed = await runProbe();
  assert.equal(observed.result.status, 0);
  assert.equal(observed.report.samples.length, 6);
  assert.equal(observed.report.identityContractSatisfied, true);
  assert.deepEqual((await fs.readdir(observed.control.root)).sort(),
    Array.from({ length: 6 }, (_, index) => 'owned-' + index + '.json'));
});

test('retains both leaves when a post-close pathname change fails the comparison', async () => {
  const observed = await runProbe({ mode: 'leaf', namedCount: 2 });
  assert.equal(observed.result.status, 1);
  assert.equal(observed.report.identityContractSatisfied, false);
  assert.equal(observed.control.triggered, true);
  assert.equal(observed.control.originalPresent, true);
  assert.equal(observed.control.unexpectedPresent, true);
});

test('performs no deletion when a leaf changes after its last sampled stat', async () => {
  const observed = await runProbe({ mode: 'leaf', namedCount: 3 });
  assert.equal(observed.result.status, 0);
  assert.equal(observed.report.identityContractSatisfied, true);
  assert.equal(observed.control.triggered, true);
  assert.equal(observed.control.originalPresent, true);
  assert.equal(observed.control.unexpectedPresent, true);
});

test('refuses a late parent redirect and retains both physical namespaces', async () => {
  const observed = await runProbe({ mode: 'parent', namedCount: 3, index: 5 });
  assert.equal(observed.result.status, 1);
  assert.equal(observed.report.samples.length, 6);
  assert.equal(observed.report.identityContractSatisfied, false);
  assert.equal(observed.report.probeFailure, 'probe-directory-changed');
  assert.equal(observed.control.triggered, true);
  assert.equal(observed.control.originalPresent, true);
  assert.equal(observed.control.unexpectedPresent, true);
});

test('rejects a substituted read-only descriptor before sampling or reading it', async () => {
  const observed = await runProbe({ mode: 'reader' });
  assert.equal(observed.result.status, 1);
  assert.equal(observed.report.samples.length, 0);
  assert.equal(observed.report.identityContractSatisfied, false);
  assert.equal(observed.report.probeFailure, 'descriptor-binding');
  assert.equal(observed.control.triggered, true);
  assert.equal(observed.control.originalPresent, true);
  assert.equal(observed.control.unexpectedPresent, true);
});
