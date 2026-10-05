import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const probe = fileURLToPath(new URL('./probe-filesystem-identity.mjs', import.meta.url));
const replacementHook = String.raw`
import { promises as fs, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mkdtemp = fs.mkdtemp.bind(fs), lstat = fs.lstat.bind(fs), unlink = fs.unlink.bind(fs);
const parent = path.resolve(process.env.TEMP);
let root, leaf, namedCalls = 0, replacementCreated = false, replacementDeleted = false;
fs.mkdtemp = async (...args) => {
  const value = await mkdtemp(...args);
  if (path.dirname(path.resolve(args[0])) === parent
      && path.basename(args[0]).startsWith('flujo-owned-fs-identity-')) {
    root = value; leaf = path.join(root, 'owned-0.json');
  }
  return value;
};
fs.lstat = async (target, ...args) => {
  if (leaf && path.resolve(target) === leaf && ++namedCalls === 2) {
    if (path.dirname(root) !== parent) throw new Error('Fixture boundary changed');
    await fs.rename(leaf, leaf + '.original');
    await fs.writeFile(leaf, '{"probe":true}\n', { flag: 'wx', mode: 0o600 });
    replacementCreated = true;
  }
  return lstat(target, ...args);
};
fs.unlink = async (target, ...args) => {
  const value = await unlink(target, ...args);
  if (replacementCreated && path.resolve(target) === leaf) replacementDeleted = true;
  return value;
};
process.on('exit', () => writeFileSync(process.env.PROBE_CONTROL_MARKER, JSON.stringify({ root,
  replacementCreated, replacementDeleted, replacementStillPresent: leaf ? existsSync(leaf) : false,
  originalStillPresent: leaf ? existsSync(leaf + '.original') : false })));
`;

async function runProbe(t, controlled) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-fs-probe-test-'));
  const markerPath = path.join(fixture, 'marker.json');
  const hookPath = path.join(fixture, 'hook.mjs');
  if (controlled) await fs.writeFile(hookPath, replacementHook);
  const result = spawnSync(process.execPath,
    controlled ? ['--import', pathToFileURL(hookPath).href, probe] : [probe],
    { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, TEMP: fixture, TMP: fixture, TMPDIR: fixture, PROBE_CONTROL_MARKER: markerPath } });
  assert.ifError(result.error);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  const control = controlled ? JSON.parse(await fs.readFile(markerPath, 'utf8')) : undefined;
  let passed = false;
  t.after(async () => {
    // Failed fixtures retain their evidence. Successful tests delete only their
    // explicitly created leaves; an unexpected entry makes rmdir refuse.
    if (!passed) return;
    if (control?.root) {
      const child = path.resolve(control.root);
      assert.equal(path.dirname(child), fixture);
      assert.ok(path.basename(child).startsWith('flujo-owned-fs-identity-'));
      const identity = await fs.lstat(child);
      assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
      for (const leaf of ['owned-0.json', 'owned-0.json.original']) await fs.unlink(path.join(child, leaf));
      await fs.rmdir(child);
    }
    if (controlled) { await fs.unlink(hookPath); await fs.unlink(markerPath); }
    await fs.rmdir(fixture);
  });
  return { result, report, control, passed: () => { passed = true; } };
}

test('collects six native samples and cleans its ordinary owned files', async t => {
  const observed = await runProbe(t, false);
  assert.equal(observed.result.status, 0);
  assert.equal(observed.report.samples.length, 6);
  assert.equal(observed.report.identityContractSatisfied, true);
  assert.equal(observed.report.cleanupCompleted, true);
  assert.equal(observed.report.installedStartupQualified, false);
  observed.passed();
});

test('preserves a post-close pathname replacement while refusing its identity', async t => {
  const observed = await runProbe(t, true);
  assert.equal(observed.result.status, 1);
  assert.equal(observed.report.identityContractSatisfied, false);
  assert.equal(observed.report.cleanupCompleted, false);
  assert.equal(observed.report.cleanupFailure, 'probe-unknown-entry-preserved');
  assert.equal(observed.report.installedStartupQualified, false);
  assert.equal(observed.control.replacementCreated, true);
  assert.equal(observed.control.replacementDeleted, false);
  assert.equal(observed.control.replacementStillPresent, true);
  assert.equal(observed.control.originalStillPresent, true);
  observed.passed();
});
