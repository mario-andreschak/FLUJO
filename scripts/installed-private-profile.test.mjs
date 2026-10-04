import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { establishInstalledPrivateProfile } from './installed-private-profile.mjs';

const ciphertext = `v2:${'a'.repeat(24)}:${'b'.repeat(32)}:AAAA`;

function fixture(t, fault = {}) {
  const sandbox = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'flujo-packed-artifacts-'));
  const dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir);
  t.after(() => {
    const resolved = fs.realpathSync.native(sandbox);
    if (path.dirname(resolved) !== fs.realpathSync.native(os.tmpdir())
        || !/^flujo-packed-artifacts-[A-Za-z0-9]+$/.test(path.basename(resolved))) throw new Error('Unsafe enrollment fixture cleanup');
    fs.rmSync(resolved, { recursive: true });
  });
  const calls = [];
  const state = { initialized: Boolean(fault.existingUser || fault.existingLegacy), locked: true, password: undefined };
  const metadataFile = path.join(dataDir, 'workspaces/default-workspace/db/encryption_key.json');
  const metadata = { encryption_version: fault.oldMetadata ? 1 : 2, encryption_type: 'user',
    kdf: 'pbkdf2-sha256', kdf_iterations: 600_000, key_id: 'a'.repeat(64), data_encryption_salt: 'a'.repeat(32),
    data_encryption_key: fault.plainMetadata ? 'synthetic-plaintext-key' : ciphertext };
  const json = (body, status = 200) => Response.json(body, { status });
  async function request(url, options = {}) {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:42001');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const input = options.body ? JSON.parse(options.body) : {};
    const action = input.action || 'cwd';
    calls.push(action);
    if (action === 'cwd') return state.locked && !fault.openFreshCwd ? json({ error: 'encryption_locked' }, 423) : json({ success: true });
    if (action === 'get_encryption_status') {
      if (fault.malformedStatus) return new Response('{"private":"synthetic-private-diagnostic', { status: 200 });
      if (fault.oversizedStatus) return json({ private: 'synthetic-private-diagnostic', padding: 'a'.repeat(20 * 1024) });
      return json({ initialized: state.initialized, type: fault.existingLegacy ? 'default' : state.initialized ? 'user' : null,
        locked: state.locked, recoveryRequired: Boolean(fault.recovery), protection: fault.operator ? 'operator' : 'interactive' });
    }
    if (action === 'initialize_default') return fault.publicSetup ? json({ success: true }) : json({ error: 'encryption_setup_required' }, 423);
    if (action === 'initialize') {
      if (fault.initialization) return json({ private: 'synthetic-private-diagnostic' }, 500);
      assert.equal(/^[A-Za-z0-9_-]{64}$/.test(input.password), true);
      state.password = input.password;
      state.initialized = true;
      if (fault.initializeUnlocks) state.locked = false;
      fs.mkdirSync(path.dirname(metadataFile), { recursive: true });
      fs.writeFileSync(metadataFile, fault.badMetadataJson ? '{"private":"synthetic-private-diagnostic'
        : JSON.stringify({ ...metadata, ...(fault.passwordInMetadata ? { leaked: input.password } : {}) }));
      return json({ success: true });
    }
    if (action === 'authenticate') {
      assert.equal(input.password === state.password, true);
      if (fault.authentication) return json({ private: 'synthetic-private-diagnostic' }, 401);
      if (!fault.authenticateLocked) state.locked = false;
      if (fault.authenticationRewritesMetadata) fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, key_id: 'b'.repeat(64) }));
      return json({ success: true, token: fault.invalidToken ? '' : 'synthetic-session-token-that-is-not-returned' });
    }
    if (action === 'encrypt') {
      assert.equal(state.locked, false);
      assert.equal(input.password, undefined);
      return json({ result: fault.plainCiphertext ? input.data : ciphertext });
    }
    throw new Error('Unexpected fixture action');
  }
  const waitFor = async (operation, accept) => {
    const value = await operation();
    assert.equal(accept(value), true);
    return value;
  };
  return { sandbox, dataDir, request, waitFor, calls, state, metadataFile };
}

test('fresh lock/public-setup denial precede private enrollment, authentication and tokenless v2 encryption', async t => {
  const owned = fixture(t);
  const result = await establishInstalledPrivateProfile('http://127.0.0.1:42001', owned);
  assert.equal(result.profile, 'interactive-user');
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(owned.calls, ['get_encryption_status', 'get_encryption_status', 'cwd', 'initialize_default',
    'get_encryption_status', 'initialize', 'get_encryption_status', 'cwd', 'authenticate', 'get_encryption_status', 'cwd', 'encrypt']);
  assert.equal(JSON.stringify(result).includes(owned.state.password), false);
  assert.equal(JSON.stringify(result).includes('synthetic-session-token'), false);
});

test('restart requires an observed USER lock and reuses the private passphrase without replacing metadata', async t => {
  const owned = fixture(t);
  const result = await establishInstalledPrivateProfile('http://127.0.0.1:42001', owned);
  const before = fs.readFileSync(owned.metadataFile);
  owned.state.locked = true;
  await result.reauthenticateAfterRestart();
  assert.equal(owned.state.locked, false);
  assert.deepEqual(fs.readFileSync(owned.metadataFile), before);
  assert.equal(owned.calls.filter(name => name === 'initialize').length, 1);
  assert.equal(owned.calls.filter(name => name === 'authenticate').length, 2);
});

for (const fault of ['existingUser', 'existingLegacy', 'recovery', 'operator', 'openFreshCwd', 'publicSetup']) {
  test(`unsafe pre-enrollment state ${fault} denies before a private initialize request`, async t => {
    const owned = fixture(t, { [fault]: true });
    await assert.rejects(establishInstalledPrivateProfile('http://127.0.0.1:42001', owned));
    assert.equal(owned.calls.includes('initialize'), false);
  });
}

for (const fault of ['initialization', 'initializeUnlocks', 'oldMetadata', 'plainMetadata', 'passwordInMetadata', 'badMetadataJson',
  'authentication', 'authenticationRewritesMetadata', 'invalidToken', 'authenticateLocked', 'plainCiphertext', 'malformedStatus', 'oversizedStatus']) {
  test(`invalid enrollment/auth/response ${fault} fails with a fixed diagnostic`, async t => {
    const owned = fixture(t, { [fault]: true });
    await assert.rejects(establishInstalledPrivateProfile('http://127.0.0.1:42001', owned), error => {
      assert.equal(error.message.includes('synthetic-private-diagnostic'), false);
      if (owned.state.password) assert.equal(error.message.includes(owned.state.password), false);
      return true;
    });
  });
}

test('a surviving unlocked process cannot qualify the restart lock', async t => {
  const owned = fixture(t);
  const result = await establishInstalledPrivateProfile('http://127.0.0.1:42001', owned);
  await assert.rejects(result.reauthenticateAfterRestart(), /state did not match/);
  assert.equal(owned.calls.filter(name => name === 'authenticate').length, 1);
});

test('changed durable key metadata refuses restart authentication', async t => {
  const owned = fixture(t);
  const result = await establishInstalledPrivateProfile('http://127.0.0.1:42001', owned);
  owned.state.locked = true;
  const metadata = JSON.parse(fs.readFileSync(owned.metadataFile, 'utf8'));
  fs.writeFileSync(owned.metadataFile, JSON.stringify({ ...metadata, key_id: 'b'.repeat(64) }));
  await assert.rejects(result.reauthenticateAfterRestart(), /metadata changed/);
  assert.equal(owned.calls.filter(name => name === 'authenticate').length, 1);
});

test('an unrelated data directory refuses every request before enrollment', async t => {
  const owned = fixture(t);
  const other = path.join(owned.sandbox, 'other');
  fs.mkdirSync(other);
  await assert.rejects(establishInstalledPrivateProfile('http://127.0.0.1:42001', { ...owned, dataDir: other }), /owned artifact fixture/);
  assert.equal(owned.calls.length, 0);
});

test('a regular file at the owned data path refuses every request before enrollment', async t => {
  const owned = fixture(t);
  fs.rmdirSync(owned.dataDir);
  fs.writeFileSync(owned.dataDir, 'synthetic-data-file');
  await assert.rejects(establishInstalledPrivateProfile('http://127.0.0.1:42001', owned), /owned artifact fixture/);
  assert.equal(owned.calls.length, 0);
});

for (const base of ['https://127.0.0.1:42001', 'http://external.invalid', 'http://127.0.0.1:42001/path',
  'http://user:password@127.0.0.1:42001', 'http://127.0.0.1:42001?query=1']) {
  test(`unowned endpoint ${base} refuses every request`, async t => {
    const owned = fixture(t);
    await assert.rejects(establishInstalledPrivateProfile(base, owned), /owned local artifact endpoint/);
    assert.equal(owned.calls.length, 0);
  });
}
