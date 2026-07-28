/**
 * Regression tests for the `encryptApiKey` / `decryptApiKey` round-trip.
 *
 * `encryptApiKey` wraps its output in an `encrypted:` envelope, but
 * `decryptWithPassword` expects a bare `iv:ciphertext` pair and splits on ':'.
 * `decryptApiKey` used to hand the enveloped value straight through, so the split
 * produced THREE parts and decryption bailed out with "Invalid ciphertext format",
 * returning null. Callers that store an encrypted value and later decrypt it
 * as-is (the package-registry account service) therefore never got their token
 * back: publishing failed with "Sign in to the package registry before
 * publishing." even immediately after a successful login.
 *
 * Like the sibling encryption suites, these drive the REAL storage backend
 * against a throwaway temp data dir (via FLUJO_DATA_DIR) so the round-trip
 * exercises the real crypto path rather than a mock.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// The real crypto path runs PBKDF2 at 100k iterations, which is deliberately
// slow; give generous headroom over the suite default.
jest.setTimeout(60000);

let tmpDir: string;

type Encryption = typeof import('@/backend/services/model/encryption');

// Storage resolves its data dir at module load, so re-import after setting
// FLUJO_DATA_DIR.
async function loadEncryption(): Promise<Encryption> {
  jest.resetModules();
  return import('@/backend/services/model/encryption');
}

function clearGlobalEncryptionState(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_server_dek = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_encryption_sessions = undefined;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-apikey-'));
  process.env.FLUJO_DATA_DIR = tmpDir;
  clearGlobalEncryptionState();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  clearGlobalEncryptionState();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('encryptApiKey / decryptApiKey round-trip', () => {
  it('decrypts a value straight back from encryptApiKey (envelope included)', async () => {
    const { encryptApiKey, decryptApiKey } = await loadEncryption();

    const secret = 'eyJhbGciOiJIUzI1NiJ9.registry-access-token.signature';
    const stored = await encryptApiKey(secret);

    // Guard the precondition this regression is about: the stored form carries
    // the envelope, so it contains more than one ':' separator.
    expect(stored.startsWith('encrypted:')).toBe(true);

    await expect(decryptApiKey(stored)).resolves.toBe(secret);
  });

  it('still decrypts a bare iv:ciphertext value (callers that strip the envelope themselves)', async () => {
    const { encryptApiKey, decryptApiKey } = await loadEncryption();

    const secret = 'sk-test-bare-ciphertext-path';
    const stored = await encryptApiKey(secret);
    const bare = stored.substring('encrypted:'.length);

    await expect(decryptApiKey(bare)).resolves.toBe(secret);
  });

  it('round-trips a token containing colons', async () => {
    const { encryptApiKey, decryptApiKey } = await loadEncryption();

    // Colons inside the plaintext must not confuse the envelope handling.
    const secret = 'scheme:opaque:value:with:colons';
    const stored = await encryptApiKey(secret);

    await expect(decryptApiKey(stored)).resolves.toBe(secret);
  });

  it('unwraps the encrypted_failed marker without attempting decryption', async () => {
    const { decryptApiKey } = await loadEncryption();

    await expect(decryptApiKey('encrypted_failed:plain-value')).resolves.toBe('plain-value');
  });
});
