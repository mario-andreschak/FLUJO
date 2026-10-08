import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertPackagedBinary, isolatedNativeEnv } from './antigravity-cli-test-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the pinned production native executable verifies its receipt and launches without authentication', () => {
  const application = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(application.dependencies['@flujo-ai/antigravity-cli'], 'file:packages/antigravity-cli');
  assert.equal(application.bin['flujo-agy'], 'packages/antigravity-cli/bin.cjs');
  assert.ok(!application.dependencies['@google/gemini-cli'], 'The replaced Gemini CLI must not ship');
  const { wrapper, packageRoot } = assertPackagedBinary(path.join(root, 'package.json'));
  const artifacts = JSON.parse(readFileSync(path.join(packageRoot, 'artifacts.json'), 'utf8'));
  assert.equal(wrapper.version, '1.2.13');
  assert.deepEqual(Object.keys(artifacts.platforms).sort(), [
    'darwin_amd64', 'darwin_arm64', 'linux_amd64', 'linux_amd64_musl',
    'linux_arm64', 'linux_arm64_musl', 'windows_amd64', 'windows_arm64',
  ]);
  for (const artifact of Object.values(artifacts.platforms)) {
    assert.match(artifact.sha512, /^[a-f0-9]{128}$/);
    assert.equal(new URL(artifact.url).hostname, 'storage.googleapis.com');
    assert.ok(new URL(artifact.url).pathname.includes('/antigravity-cli/' + artifacts.build + '/'));
  }
});

test('missing or counterfeit native caches fail instead of resolving a PATH executable', () => {
  const { wrapper, packageRoot, binary } = assertPackagedBinary(path.join(root, 'package.json'));
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'flujo-antigravity-cache-check-'));
  try {
    const owned = path.join(sandbox, 'wrapper');
    const fakePath = path.join(sandbox, 'path');
    mkdirSync(owned);
    mkdirSync(fakePath);
    for (const name of ['index.cjs', 'artifacts.json']) {
      copyFileSync(path.join(packageRoot, name), path.join(owned, name));
    }
    writeFileSync(path.join(fakePath, process.platform === 'win32' ? 'agy.cmd' : 'agy'), 'counterfeit');
    const script = 'try { require(process.argv[1]).resolveBinary(); process.exitCode = 2; } catch (error) { process.stdout.write(error.message); }';
    const env = { ...isolatedNativeEnv(sandbox), PATH: fakePath, AGY_BINARY: binary };
    const run = () => spawnSync(process.execPath, ['-e', script, path.join(owned, 'index.cjs')], {
      env, encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000,
    });
    let result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /missing or changed/);
    const cache = path.join(owned, '.cache', wrapper.version, wrapper.platformKey());
    mkdirSync(cache, { recursive: true });
    writeFileSync(path.join(cache, process.platform === 'win32' ? 'agy.exe' : 'agy'), 'counterfeit');
    copyFileSync(wrapper.paths().receipt, path.join(cache, 'verified.json'));
    result = run();
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /missing or changed/);
  } finally {
    assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith('flujo-antigravity-cache-check-'));
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('a cache-directory link cannot import or overwrite a native runtime outside its package', () => {
  const { wrapper, packageRoot } = assertPackagedBinary(path.join(root, 'package.json'));
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'flujo-antigravity-link-check-'));
  try {
    const owned = path.join(sandbox, 'wrapper');
    const versionCache = path.join(owned, '.cache', wrapper.version);
    mkdirSync(versionCache, { recursive: true });
    for (const name of ['index.cjs', 'install.cjs', 'artifacts.json']) {
      copyFileSync(path.join(packageRoot, name), path.join(owned, name));
    }
    symlinkSync(wrapper.paths().directory, path.join(versionCache, wrapper.platformKey()), process.platform === 'win32' ? 'junction' : 'dir');
    const script = 'require(process.argv[1]).install().then(() => { process.exitCode = 2; }, error => { process.stdout.write(error.message); });';
    const result = spawnSync(process.execPath, ['-e', script, path.join(owned, 'install.cjs')], {
      env: isolatedNativeEnv(sandbox), encoding: 'utf8', shell: false, windowsHide: true, timeout: 10_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, 'Installer followed a linked cache: ' + result.stderr);
    assert.match(result.stdout, /cache|package|link/i);
    assertPackagedBinary(path.join(root, 'package.json'));
  } finally {
    assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()));
    assert.ok(path.basename(sandbox).startsWith('flujo-antigravity-link-check-'));
    rmSync(sandbox, { recursive: true, force: true });
  }
});
