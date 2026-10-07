import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPrivateSmokeEnv, waitFor } from './smoke-mcp-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '__tests__/encryption/fixtures/private-profile-child.cjs');
const typescript = path.join(root, 'node_modules/typescript/lib/typescript.js');

async function withSandbox(operation) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const sandbox = await fs.mkdtemp(path.join(temporaryRoot, 'flujo-private-smoke-test-'));
  try { await operation(sandbox); }
  finally {
    const identity = await fs.lstat(sandbox);
    assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
    assert.equal(path.dirname(sandbox), temporaryRoot);
    assert.equal(await fs.realpath(sandbox), sandbox);
    await fs.rm(sandbox, { recursive: true, force: true });
  }
}

function probe(env, input, commit = false) {
  const result = spawnSync(process.execPath, [fixture, root, typescript], {
    env, input: `${JSON.stringify(input)}\n${commit ? 'commit\n' : ''}`, encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('{'));
  assert.ok(line, 'The real private-profile source child must return its result.');
  return JSON.parse(line);
}

test('the smoke profile mounts a private external secret and works across real encryption processes', async () => {
  await withSandbox(async sandbox => {
    const dataDir = path.join(sandbox, 'data');
    await fs.mkdir(dataDir);
    const env = await createPrivateSmokeEnv(sandbox, dataDir, {
      FLUJO_OWNER_AUTH_FILE: path.join(sandbox, 'unrelated-owner-policy'), FLUJO_EXPOSURE_MODE: 'public',
      FLUJO_PARENT_DATA_DIR: path.join(sandbox, 'unrelated-parent-data'),
    });
    assert.equal(env.FLUJO_EXPOSURE_MODE, 'localhost');
    assert.equal(env.FLUJO_OWNER_AUTH_FILE, undefined);
    assert.equal(env.FLUJO_PARENT_DATA_DIR, undefined);
    const secretFile = env.FLUJO_ENCRYPTION_SECRET_FILE;
    assert.equal(path.dirname(secretFile), sandbox);
    assert.ok(!secretFile.startsWith(`${dataDir}${path.sep}`));
    const secretHandle = await fs.open(secretFile, 'r');
    try {
      const stat = await secretHandle.stat();
      assert.ok(stat.isFile());
      assert.equal(stat.nlink, 1);
      if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
      assert.match(await secretHandle.readFile('utf8'), /^[A-Za-z0-9_-]{64}$/);
    } finally { await secretHandle.close(); }
    const value = 'synthetic-private-smoke-credential';
    const { ciphertext } = probe(env, { operation: 'mint', value }, true);
    assert.equal(typeof ciphertext, 'string');
    assert.notEqual(ciphertext, value);
    assert.equal(probe(env, { operation: 'recover', ciphertexts: [ciphertext], expected: [value] }).recovered, true);
    const wrongSecret = path.join(sandbox, 'wrong-secret');
    await fs.writeFile(wrongSecret, 'x'.repeat(64), { mode: 0o600, flag: 'wx' });
    assert.equal(probe({ ...env, FLUJO_ENCRYPTION_SECRET_FILE: wrongSecret }, {
      operation: 'recover', ciphertexts: [ciphertext], expected: [value],
    }).recovered, false);
    await assert.rejects(createPrivateSmokeEnv(sandbox, dataDir), { code: 'EEXIST' });
  });
});

test('readiness reports the observed locked status rather than an obsolete connection error', async () => {
  let calls = 0;
  await assert.rejects(waitFor(async () => {
    if (calls++ === 0) throw new Error('initial connection refusal');
    return 423;
  }, status => status === 200, 'private profile readiness', 250), error => {
    assert.match(error.message, /Last HTTP status: 423/);
    assert.ok(!error.message.includes('initial connection refusal'));
    return true;
  });
});

test('readiness still requires the successful status after a locked response', async () => {
  let calls = 0;
  assert.equal(await waitFor(async () => ++calls === 1 ? 423 : 200,
    status => status === 200, 'private profile readiness', 1_000), 200);
  assert.equal(calls, 2);
});
