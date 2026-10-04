import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fileReader from './read-bounded-file.cjs';

const responseLimit = 16 * 1024;

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Installed private-profile response is unavailable.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > responseLimit) throw new Error('Installed private-profile response exceeds its limit.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch { throw new Error('Installed private-profile response is invalid.'); }
  finally { await reader.cancel().catch(() => {}); }
}

async function assertOwnedDataRoot(sandbox, dataDir) {
  const temporary = await fs.realpath(os.tmpdir());
  const owned = await fs.realpath(sandbox);
  const data = await fs.realpath(dataDir);
  const ownedEntry = await fs.lstat(sandbox);
  const dataEntry = await fs.lstat(dataDir);
  if (path.dirname(owned) !== temporary || !/^flujo-packed-artifacts-[A-Za-z0-9]+$/.test(path.basename(owned))
      || owned !== path.resolve(sandbox) || !ownedEntry.isDirectory() || ownedEntry.isSymbolicLink()
      || data !== path.join(owned, 'data') || data !== path.resolve(dataDir)
      || !dataEntry.isDirectory() || dataEntry.isSymbolicLink()) {
    throw new Error('Private enrollment requires the owned artifact fixture.');
  }
}

/** Enroll only a fresh, owned installed fixture through its real local HTTP API. */
export async function establishInstalledPrivateProfile(baseUrl, { sandbox, dataDir, request = fetch, waitFor }) {
  await assertOwnedDataRoot(sandbox, dataDir);
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
      || base.pathname !== '/' || base.username || base.password || base.search || base.hash) {
    throw new Error('Private enrollment requires the owned local artifact endpoint.');
  }
  async function action(name, fields = {}) {
    const response = await request(new URL('/api/encryption/secure', base), { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, ...fields }),
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    });
    return { status: response.status, body: await boundedJson(response) };
  }
  function assertStatus(body, initialized, locked) {
    if (body?.initialized !== initialized || body?.type !== (initialized ? 'user' : null)
        || body?.locked !== locked || body?.recoveryRequired !== false || body?.protection !== 'interactive') {
      throw new Error('Installed private-profile state did not match the fixture.');
    }
  }
  async function status() {
    const result = await action('get_encryption_status');
    if (result.status !== 200) throw new Error(`Installed private-profile status returned ${result.status}.`);
    return result.body;
  }
  async function assertCwdLocked() {
    const response = await request(new URL('/api/cwd', base), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (response.status !== 423 || (await boundedJson(response))?.error !== 'encryption_locked') {
      throw new Error('Installed private-profile lock did not deny the effect route.');
    }
  }
  await waitFor(async () => (await action('get_encryption_status')).status, value => value === 200,
    'installed FLUJO encryption status');
  assertStatus(await status(), false, true);
  await assertCwdLocked();
  const publicSetup = await action('initialize_default');
  if (publicSetup.status !== 423 || publicSetup.body?.error !== 'encryption_setup_required') {
    throw new Error('Fresh installed fixture accepted public-password setup.');
  }
  assertStatus(await status(), false, true);
  const password = randomBytes(48).toString('base64url');
  const initialized = await action('initialize', { password });
  if (initialized.status !== 200 || initialized.body?.success !== true) {
    throw new Error('Fresh installed private enrollment failed.');
  }
  assertStatus(await status(), true, true);
  await assertCwdLocked();
  function metadataDigest() {
    try {
      const bytes = fileReader.readBoundedFileSync(path.join(dataDir, 'workspaces/default-workspace/db/encryption_key.json'), 64 * 1024);
      const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (metadata?.encryption_version !== 2 || metadata?.encryption_type !== 'user'
          || metadata?.kdf !== 'pbkdf2-sha256' || metadata?.kdf_iterations !== 600_000
          || !/^[a-f0-9]{64}$/.test(metadata?.key_id ?? '') || !/^[a-f0-9]{32}$/.test(metadata?.data_encryption_salt ?? '')
          || !/^v2:[a-f0-9]{24}:[a-f0-9]{32}:[A-Za-z0-9+/]+={0,2}$/.test(metadata?.data_encryption_key ?? '')
          || bytes.includes(Buffer.from(password))) throw new Error('Installed private key metadata is invalid.');
      return createHash('sha256').update(bytes).digest('hex');
    } catch { throw new Error('Installed private key metadata is invalid.'); }
  }
  const enrolledMetadata = metadataDigest();
  async function authenticate() {
    const result = await action('authenticate', { password });
    if (result.status !== 200 || result.body?.success !== true || typeof result.body?.token !== 'string'
        || result.body.token.length < 16 || result.body.token.length > 512) {
      throw new Error('Installed private authentication failed.');
    }
    assertStatus(await status(), true, false);
    await waitFor(async () => (await request(new URL('/api/cwd', base), {
      signal: AbortSignal.timeout(10_000), redirect: 'error',
    })).status, value => value === 200, 'unlocked installed FLUJO readiness');
  }
  await authenticate();
  if (metadataDigest() !== enrolledMetadata) throw new Error('Installed authentication replaced private key metadata.');
  const plaintext = 'installed-private-profile-synthetic-value';
  const encrypted = await action('encrypt', { data: plaintext });
  if (encrypted.status !== 200 || typeof encrypted.body?.result !== 'string'
      || !/^v2:[a-f0-9]{24}:[a-f0-9]{32}:[A-Za-z0-9+/]+={0,2}$/.test(encrypted.body.result)
      || encrypted.body.result.includes(plaintext) || encrypted.body.result.includes(password)) {
    throw new Error('Installed authenticated encryption did not return v2 ciphertext.');
  }
  // The synthetic passphrase/token never appear in a receipt or returned data.
  return Object.freeze({ profile: 'interactive-user', reauthenticateAfterRestart: async () => {
    await waitFor(async () => (await action('get_encryption_status')).status, value => value === 200,
      'restarted installed FLUJO encryption status');
    assertStatus(await status(), true, true);
    await assertCwdLocked();
    if (metadataDigest() !== enrolledMetadata) throw new Error('Restarted installed private key metadata changed.');
    await authenticate();
    if (metadataDigest() !== enrolledMetadata) throw new Error('Installed authentication replaced private key metadata.');
  } });
}
