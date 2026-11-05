import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CHECKED_VARIABLE, main, protectSecret, readProtectedSecret, resolveUnlockSecret, secretCameFromFile, secretFileFor,
} from '../bin/cli/unlock-secret.mjs';

const dataDir = path.resolve(os.tmpdir(), 'flujo-data-for-test');

test('not opted in: any secret is removed, and nothing is read', () => {
  for (const source of [undefined, '', 'off', 'OFF']) {
    const env = { FLUJO_UNLOCK_SECRET_SOURCE: source, FLUJO_UNLOCK_SECRET: 'x', [CHECKED_VARIABLE]: 'y' };
    const result = resolveUnlockSecret(env, { readSecret: () => assert.fail('must not read') });
    assert.deepEqual(result, { enabled: false });
    assert.equal(env.FLUJO_UNLOCK_SECRET, undefined);
    assert.equal(env[CHECKED_VARIABLE], undefined);
  }
});

test('env source: passes on a secret from outside, refuses one from a .env file', () => {
  const env = { FLUJO_UNLOCK_SECRET_SOURCE: 'env', FLUJO_UNLOCK_SECRET: 'from-outside' };
  assert.deepEqual(resolveUnlockSecret(env), { enabled: true });
  assert.equal(env[CHECKED_VARIABLE], 'from-outside');
  assert.equal(env.FLUJO_UNLOCK_SECRET, undefined);

  const fromFile = { FLUJO_UNLOCK_SECRET_SOURCE: 'env', FLUJO_UNLOCK_SECRET: 'from-file' };
  const refused = resolveUnlockSecret(fromFile, { loadedFromFile: true });
  assert.match(refused.problem, /\.env file/);
  assert.equal(fromFile[CHECKED_VARIABLE], undefined);
  assert.equal(fromFile.FLUJO_UNLOCK_SECRET, undefined);
  assert.doesNotMatch(refused.problem, /from-file/);

  assert.match(resolveUnlockSecret({ FLUJO_UNLOCK_SECRET_SOURCE: 'env' }).problem, /No unlock secret/);
});

test('a value handed in as already checked is thrown away and replaced', () => {
  const env = { FLUJO_UNLOCK_SECRET_SOURCE: 'env', [CHECKED_VARIABLE]: 'forged' };
  assert.match(resolveUnlockSecret(env).problem, /No unlock secret/);
  assert.equal(env[CHECKED_VARIABLE], undefined);
});

test('an unknown source stays locked rather than guessing', () => {
  const env = { FLUJO_UNLOCK_SECRET_SOURCE: 'plaintext-please', FLUJO_UNLOCK_SECRET: 'x' };
  assert.match(resolveUnlockSecret(env).problem, /must be off, env or dpapi/);
  assert.equal(env[CHECKED_VARIABLE], undefined);
  assert.equal(env.FLUJO_UNLOCK_SECRET, undefined);
});

test('dpapi source: the file must be named, outside the data, and readable', () => {
  const base = { FLUJO_UNLOCK_SECRET_SOURCE: 'dpapi', FLUJO_DATA_DIR: dataDir };
  const read = () => 'opened';
  assert.match(resolveUnlockSecret({ ...base }, { platform: 'win32', readSecret: read }).problem, /full path/);
  assert.match(resolveUnlockSecret({ ...base, FLUJO_UNLOCK_SECRET_FILE: 'relative.json' }, { platform: 'win32', readSecret: read }).problem, /full path/);
  assert.match(resolveUnlockSecret({ ...base, FLUJO_UNLOCK_SECRET_FILE: path.join(dataDir, 'sub', 'secret.json') }, { platform: 'win32', readSecret: read }).problem, /outside the data directory/);
  const outside = path.resolve(os.tmpdir(), 'elsewhere', 'secret.json');
  assert.match(resolveUnlockSecret({ ...base, FLUJO_UNLOCK_SECRET_FILE: outside }, { platform: 'linux', readSecret: read }).problem, /only on Windows/);
  assert.match(resolveUnlockSecret({ ...base, FLUJO_UNLOCK_SECRET_FILE: outside }, { platform: 'win32', readSecret: () => null }).problem, /could not open/);
  const good = { ...base, FLUJO_UNLOCK_SECRET_FILE: outside, FLUJO_UNLOCK_SECRET: 'ignored' };
  assert.deepEqual(resolveUnlockSecret(good, { platform: 'win32', readSecret: read }), { enabled: true });
  assert.equal(good[CHECKED_VARIABLE], 'opened');
  assert.equal(good.FLUJO_UNLOCK_SECRET, undefined);
});

test('finds a secret in loaded .env files, by what the files actually held', () => {
  assert.equal(secretCameFromFile({ loadedEnvFiles: [{ env: { OTHER: '1' } }, { env: { FLUJO_UNLOCK_SECRET: 'x' } }] }), true);
  assert.equal(secretCameFromFile({ loadedEnvFiles: [{ env: { OTHER: '1' } }] }), false);
  assert.equal(secretCameFromFile(undefined), false);
});

test('an unreadable or foreign file is simply not a secret', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-unlock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const never = { run: () => assert.fail('nothing should reach Windows') };
  assert.equal(readProtectedSecret(path.join(directory, 'missing.json'), never), null);
  const broken = path.join(directory, 'broken.json');
  fs.writeFileSync(broken, 'not json');
  assert.equal(readProtectedSecret(broken, never), null);
  fs.writeFileSync(broken, JSON.stringify({ format: 'other', scope: 'user', blob: 'x' }));
  assert.equal(readProtectedSecret(broken, never), null);
  fs.writeFileSync(broken, JSON.stringify({ format: 'flujo-unlock-secret', scope: 'everyone', blob: 'x' }));
  assert.equal(readProtectedSecret(broken, never), null);
  fs.writeFileSync(broken, 'x'.repeat(70_000));
  assert.equal(readProtectedSecret(broken, never), null);
});

test('real Windows DPAPI: both scopes open again, the blob is not the secret, tampering fails', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-dpapi-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = 'süper geheim 123 "quoted" \\ back';
  for (const scope of ['user', 'machine']) {
    const blob = protectSecret(secret, scope);
    assert.ok(blob);
    assert.equal(Buffer.from(blob, 'base64').toString('utf8').includes('geheim'), false);
    const file = path.join(directory, `${scope}.json`);
    fs.writeFileSync(file, JSON.stringify({ format: 'flujo-unlock-secret', version: 1, scope, blob }));
    assert.equal(readProtectedSecret(file), secret);
    const damaged = Buffer.from(blob, 'base64');
    damaged[damaged.length - 5] ^= 0xff;
    fs.writeFileSync(file, JSON.stringify({ format: 'flujo-unlock-secret', version: 1, scope, blob: damaged.toString('base64') }));
    assert.equal(readProtectedSecret(file), null);
  }
});

test('the command stores, checks and clears, and never prints the secret', { skip: process.platform !== 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flujo-unlock-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const printed = [];
  const original = console.log;
  console.log = (...args) => printed.push(args.join(' '));
  t.after(() => { console.log = original; });
  const secret = 'never-print-this-value';
  const args = ['--name', 'pilot', '--root', root];
  assert.equal(await main(['set', ...args, '--scope', 'user'], { readInput: () => secret }), 0);
  assert.equal(await main(['check', ...args]), 0);
  const stored = fs.readFileSync(secretFileFor(root), 'utf8');
  assert.equal(stored.includes(secret), false);
  assert.equal(readProtectedSecret(secretFileFor(root)), secret);
  assert.equal(printed.join('\n').includes(secret), false);
  await assert.rejects(() => main(['set', ...args], { readInput: () => '' }), /No secret/);
  await assert.rejects(() => main(['set', ...args, '--scope', 'world'], { readInput: () => 'x' }), /--scope/);
  assert.equal(await main(['clear', ...args]), 0);
  assert.equal(fs.existsSync(secretFileFor(root)), false);
  assert.equal(await main(['check', ...args]), 1);
});
