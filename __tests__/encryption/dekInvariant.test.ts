/**
 * Regression tests for issue #81: lock in the single-DEK invariant.
 *
 * FLUJO's mode transitions (`migrateToUserEncryption`, `changeEncryptionPassword`)
 * only ever RE-WRAP the DEK — they never rotate the DEK value that actually
 * encrypts data. Consequently stored ciphertexts survive both transitions with
 * NO data re-encryption. This is what made the closed issue #79 (a full
 * re-encrypt / "mixed-DEK repair" pass) unnecessary and risky.
 *
 * These tests fail loudly if a future change starts rotating the DEK on a
 * transition without also re-encrypting stored secrets — i.e. if the invariant
 * the code comments rely on is broken.
 *
 * Like the sibling encryption suites, these drive the REAL storage backend
 * against a throwaway temp data dir (via FLUJO_DATA_DIR) so the round-trips
 * exercise the real crypto + metadata paths.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Each test runs several PBKDF2(100k-iteration) derivations through the real
// crypto path, which is deliberately slow; give generous headroom over the
// suite default so CI variance doesn't flake these out.
jest.setTimeout(60000);

let tmpDir: string;

type Secure = typeof import('@/utils/encryption/secure');
type Session = typeof import('@/utils/encryption/session');

// (Re)import the encryption modules against the current temp dir. Storage
// resolves its data dir at module load, so we must reset + re-import after
// FLUJO_DATA_DIR is set.
async function loadModules(): Promise<{ secure: Secure; session: Session }> {
  jest.resetModules();
  const secure = await import('@/utils/encryption/secure');
  const session = await import('@/utils/encryption/session');
  return { secure, session };
}

function clearGlobalEncryptionState(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_server_dek = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_encryption_sessions = undefined;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-dek-'));
  process.env.FLUJO_DATA_DIR = tmpDir;
  clearGlobalEncryptionState();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  clearGlobalEncryptionState();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('single-DEK invariant: default -> user migration', () => {
  it('keeps a secret encrypted in DEFAULT mode decryptable after migrating to USER mode', async () => {
    const { secure, session } = await loadModules();

    // Start in DEFAULT mode and encrypt a secret (tokenless, no password).
    expect(await secure.initializeDefaultEncryption()).toBe(true);
    const ciphertext = await secure.encryptWithPassword('default-mode-secret');
    expect(ciphertext).toBeTruthy();

    // Migrate to USER encryption. This must NOT re-encrypt stored data — it only
    // re-wraps the DEK — so the ciphertext produced above stays valid.
    expect(await secure.migrateToUserEncryption('correct horse')).toBe(true);
    expect(await secure.isUserEncryptionEnabled()).toBe(true);

    // Unlock with the new password and decrypt the OLD (default-mode) ciphertext
    // tokenlessly via the server unlock state. Same DEK => still decrypts.
    const token = await secure.authenticate('correct horse');
    expect(token).toBeTruthy();
    expect(session.isServerLocked()).toBe(false);

    const decrypted = await secure.decryptWithPassword(ciphertext as string);
    expect(decrypted).toBe('default-mode-secret');
  });

  it('also decrypts the pre-migration ciphertext with an explicit password (no unlock state)', async () => {
    const { secure } = await loadModules();

    await secure.initializeDefaultEncryption();
    const ciphertext = await secure.encryptWithPassword('another-secret');
    expect(ciphertext).toBeTruthy();

    await secure.migrateToUserEncryption('pw');

    // Passing the password explicitly derives the (unchanged) USER DEK without
    // touching the server unlock state.
    const decrypted = await secure.decryptWithPassword(ciphertext as string, 'pw');
    expect(decrypted).toBe('another-secret');
  });
});

describe('single-DEK invariant: password change', () => {
  it('keeps stored secrets decryptable after changeEncryptionPassword', async () => {
    const { secure } = await loadModules();

    // Set up USER encryption and store a couple of secrets under the old password.
    expect(await secure.initializeEncryption('old-password')).toBe(true);
    const secretA = await secure.encryptWithPassword('value-A', 'old-password');
    const secretB = await secure.encryptWithPassword('value-B', 'old-password');
    expect(secretA).toBeTruthy();
    expect(secretB).toBeTruthy();

    // Change the password. Only the DEK wrapping changes; the DEK is preserved.
    expect(await secure.changeEncryptionPassword('old-password', 'new-password')).toBe(true);

    // The old password no longer works...
    expect(await secure.authenticate('old-password')).toBeNull();

    // ...but the same ciphertexts still decrypt under the NEW password.
    const decA = await secure.decryptWithPassword(secretA as string, 'new-password');
    const decB = await secure.decryptWithPassword(secretB as string, 'new-password');
    expect(decA).toBe('value-A');
    expect(decB).toBe('value-B');
  });

  it('rejects the old password after the change', async () => {
    const { secure, session } = await loadModules();

    await secure.initializeEncryption('first');
    await secure.changeEncryptionPassword('first', 'second');

    // Wrong (old) password: no unlock.
    expect(await secure.authenticate('first')).toBeNull();
    expect(session.isServerLocked()).toBe(true);

    // New password unlocks.
    expect(await secure.authenticate('second')).toBeTruthy();
    expect(session.isServerLocked()).toBe(false);
  });
});
