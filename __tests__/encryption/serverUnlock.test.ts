/**
 * Tests for issue #76 (Stage 1/4 of the #16 custom-encryption fix):
 * server-held unlock state & removal of the silent DEFAULT-DEK fallback.
 *
 * These drive the REAL storage backend against a throwaway temp data dir (via
 * FLUJO_DATA_DIR) so the encrypt -> store -> decrypt round-trips exercise the
 * real crypto and metadata paths. The global-backed server unlock state is
 * cleared between tests so each starts locked/clean.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

type Secure = typeof import('@/utils/encryption/secure');
type Session = typeof import('@/utils/encryption/session');
type Backend = typeof import('@/utils/storage/backend');
type Resolve = typeof import('@/backend/utils/resolveGlobalVars');

// (Re)import the encryption modules against the current temp dir. Storage
// resolves its data dir at module load, so we must reset + re-import after
// FLUJO_DATA_DIR is set. All modules share one registry per call so the
// global-backed state and storage instance are consistent.
async function loadModules(): Promise<{
  secure: Secure;
  session: Session;
  backend: Backend;
  resolve: Resolve;
}> {
  jest.resetModules();
  const secure = await import('@/utils/encryption/secure');
  const session = await import('@/utils/encryption/session');
  const backend = await import('@/utils/storage/backend');
  const resolve = await import('@/backend/utils/resolveGlobalVars');
  return { secure, session, backend, resolve };
}

function clearGlobalEncryptionState(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_server_dek = undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__flujo_encryption_sessions = undefined;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-enc-'));
  process.env.FLUJO_DATA_DIR = tmpDir;
  clearGlobalEncryptionState();
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  clearGlobalEncryptionState();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('USER encryption with server unlock state', () => {
  it('round-trips encrypt -> decrypt through tokenless calls once unlocked', async () => {
    const { secure, session } = await loadModules();
    expect(await secure.initializeEncryption('correct horse')).toBe(true);

    // Locked initially (fresh process, no unlock).
    expect(session.isServerLocked()).toBe(true);

    // Authenticate -> sets the server unlock state and returns a session token.
    const token = await secure.authenticate('correct horse');
    expect(token).toBeTruthy();
    expect(session.isServerLocked()).toBe(false);
    expect(session.getServerDek()).toBeTruthy();

    // Tokenless encrypt/decrypt now use the correct USER DEK.
    const enc = await secure.encryptWithPassword('my-secret-value');
    expect(enc).toBeTruthy();
    const dec = await secure.decryptWithPassword(enc as string);
    expect(dec).toBe('my-secret-value');
  });

  it('throws EncryptionLockedError on encrypt/decrypt while locked (never DEFAULT-DEK output)', async () => {
    const { secure, session } = await loadModules();
    await secure.initializeEncryption('pw');

    // Unlock, produce a ciphertext, then re-lock the server.
    await secure.authenticate('pw');
    const enc = await secure.encryptWithPassword('secret');
    expect(enc).toBeTruthy();
    session.lockServer();
    expect(session.isServerLocked()).toBe(true);

    await expect(secure.encryptWithPassword('secret')).rejects.toBeInstanceOf(secure.EncryptionLockedError);
    await expect(secure.decryptWithPassword(enc as string)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
  });

  it('honours an explicit password even when the server is locked', async () => {
    const { secure, session } = await loadModules();
    await secure.initializeEncryption('pw');
    expect(session.isServerLocked()).toBe(true);

    // Passing the password explicitly derives the USER DEK without unlocking.
    const enc = await secure.encryptWithPassword('data', 'pw');
    expect(enc).toBeTruthy();
    const dec = await secure.decryptWithPassword(enc as string, 'pw');
    expect(dec).toBe('data');
  });

  it('keeps the server unlocked with no expiry (until explicitly locked)', async () => {
    const { secure, session } = await loadModules();
    await secure.initializeEncryption('pw');
    await secure.authenticate('pw');

    const dek = session.getServerDek();
    expect(dek).toBeTruthy();
    // No expiry: state is unchanged after time passes (state object holds a raw
    // DEK string, not a timestamped session) and only lockServer clears it.
    expect(session.isServerLocked()).toBe(false);
    expect(session.getServerDek()).toBe(dek);
    session.lockServer();
    expect(session.isServerLocked()).toBe(true);
    expect(session.getServerDek()).toBeNull();
  });

  it('rejects a wrong password (does not unlock)', async () => {
    const { secure, session } = await loadModules();
    await secure.initializeEncryption('pw');
    const token = await secure.authenticate('wrong');
    expect(token).toBeNull();
    expect(session.isServerLocked()).toBe(true);
  });
});

describe('DEFAULT encryption mode is unchanged', () => {
  it('round-trips without any password and never throws the locked error', async () => {
    const { secure } = await loadModules();
    expect(await secure.initializeDefaultEncryption()).toBe(true);

    const enc = await secure.encryptWithPassword('hello world');
    expect(enc).toBeTruthy();
    const dec = await secure.decryptWithPassword(enc as string);
    expect(dec).toBe('hello world');
  });

  it('initializes default encryption on the fly when no metadata exists', async () => {
    const { secure } = await loadModules();
    // No initialize* call: getDEK should lazily set up DEFAULT encryption.
    const enc = await secure.encryptWithPassword('lazy-default');
    expect(enc).toBeTruthy();
    const dec = await secure.decryptWithPassword(enc as string);
    expect(dec).toBe('lazy-default');
  });
});

describe('resolveGlobalVars honours the server unlock state', () => {
  it('decrypts an encrypted global variable when unlocked and leaks nothing when locked', async () => {
    const { secure, session, backend, resolve } = await loadModules();
    const { StorageKey } = await import('@/shared/types/storage');

    await secure.initializeEncryption('pw');
    await secure.authenticate('pw');

    const enc = await secure.encryptWithPassword('super-secret-key');
    expect(enc).toBeTruthy();

    await backend.saveItem(StorageKey.GLOBAL_ENV_VARS, {
      MY_SECRET: { value: `encrypted:${enc}`, metadata: { isSecret: true } },
    });

    // Unlocked: resolves to the plaintext.
    const resolved = await resolve.resolveGlobalVars('${global:MY_SECRET}');
    expect(resolved).toBe('super-secret-key');

    // Locked: must NOT leak plaintext or emit DEFAULT-DEK garbage. The resolver
    // catches the locked error and keeps the unresolved reference.
    session.lockServer();
    const lockedResult = await resolve.resolveGlobalVars('${global:MY_SECRET}');
    expect(lockedResult).not.toBe('super-secret-key');
    expect(lockedResult).toBe('${global:MY_SECRET}');
  });
});
