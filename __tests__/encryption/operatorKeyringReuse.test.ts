import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionMetadata } from '@/utils/encryption/format';

// Instrument counts while executing the canonical, unmodified 600k KDF path.
jest.mock('@/utils/encryption/format', () => {
  const actual = jest.requireActual('@/utils/encryption/format');
  return { ...actual, unwrapKeyring: jest.fn(actual.unwrapKeyring) };
});

jest.setTimeout(60_000);
let root: string;
let secretFile: string;
let saved: Record<string, string | undefined>;

function reset() {
  global.__flujo_server_dek = undefined;
  global.__flujo_server_deks_by_workspace = undefined;
  global.__flujo_encryption_sessions = undefined;
  global.__flujo_encryption_sessions_by_workspace = undefined;
  global.__flujo_encryption_metadata_locks = undefined;
  delete (global as unknown as { __flujo_verified_operator_keyring?: unknown }).__flujo_verified_operator_keyring;
}

async function modules() {
  return {
    secure: await import('@/utils/encryption/secure'),
    format: await import('@/utils/encryption/format'),
    storage: await import('@/utils/storage/backend'),
    session: await import('@/utils/encryption/session'),
    workspace: await import('@/utils/workspace'),
  };
}

beforeEach(async () => {
  saved = Object.fromEntries(['FLUJO_DATA_DIR', 'FLUJO_PARENT_DATA_DIR', 'FLUJO_ENCRYPTION_SECRET_FILE',
    'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY'].map(key => [key, process.env[key]]));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-operator-reuse-'));
  process.env.FLUJO_DATA_DIR = path.join(root, 'data');
  for (const key of ['FLUJO_PARENT_DATA_DIR', 'FLUJO_WORKER_MODE', 'FLUJO_WORKER_SNAPSHOT_KEY']) delete process.env[key];
  secretFile = path.join(root, 'operator-secret');
  await fs.writeFile(secretFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
  process.env.FLUJO_ENCRYPTION_SECRET_FILE = secretFile;
  jest.resetModules();
  reset();
});

afterEach(async () => {
  jest.restoreAllMocks();
  reset();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('reuses only a verified operator keyring while rereading metadata and the protected mount on every access', async () => {
  const { secure, format, workspace } = await modules();
  await secure.initializeDefaultEncryption();
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  const opened = jest.spyOn(fsSync, 'openSync');
  const loaded = jest.spyOn(fs, 'readFile');
  const metadataFile = path.join(workspace.getWorkspaceDataDir(), 'db', `${StorageKey.ENCRYPTION_KEY}.json`);
  const ciphertext = (await secure.encryptWithPassword('disposable-operator-fixture'))!;
  for (let repeat = 0; repeat < 3; repeat++) {
    const mountReads = opened.mock.calls.filter(([file]) => file === secretFile).length;
    const metadataReads = loaded.mock.calls.filter(([file]) => file === metadataFile).length;
    expect(await secure.isEncryptionLocked()).toBe(false);
    expect(await secure.decryptWithPassword(ciphertext)).toBe('disposable-operator-fixture');
    expect(opened.mock.calls.filter(([file]) => file === secretFile).length).toBeGreaterThan(mountReads);
    expect(loaded.mock.calls.filter(([file]) => file === metadataFile).length).toBeGreaterThan(metadataReads);
  }
  // Counts only: never dump unwrap arguments/results, mounted secrets or data keys.
  expect(unwrap.mock.calls.length).toBe(1);
});

test('alternating initialized workspaces each keeps independent verified reuse', async () => {
  const { secure, format, workspace } = await modules();
  await secure.initializeDefaultEncryption();
  await workspace.runWithWorkspace('alternate', () => secure.initializeDefaultEncryption());
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  for (const selected of ['default-workspace', 'default-workspace', 'alternate', 'alternate', 'default-workspace', 'default-workspace']) {
    expect(await workspace.runWithWorkspace(selected, () => secure.isEncryptionLocked())).toBe(false);
  }
  // Each profile must earn its own verified unwrap; another profile does not evict it.
  expect(unwrap.mock.calls.length).toBe(2);
});

test.each(['missing', 'changed', 'hardlink', 'parent-link', 'inside-data'])(
  'a warmed operator key cannot authorize a %s mount', async variant => {
    const { secure, workspace } = await modules();
    const ciphertext = (await secure.encryptWithPassword('disposable-operator-fixture'))!;
    const original = await fs.readFile(secretFile);
    if (variant === 'missing') await fs.unlink(secretFile);
    if (variant === 'changed') await fs.writeFile(secretFile, randomBytes(32).toString('base64url'));
    if (variant === 'hardlink') await fs.link(secretFile, `${secretFile}.alias`);
    if (variant === 'parent-link') {
      const linked = path.join(root, 'linked');
      await fs.symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
      process.env.FLUJO_ENCRYPTION_SECRET_FILE = path.join(linked, 'operator-secret');
    }
    if (variant === 'inside-data') {
      const inside = path.join(workspace.getWorkspaceDataDir(), 'operator-secret');
      await fs.writeFile(inside, original, { mode: 0o600 });
      process.env.FLUJO_ENCRYPTION_SECRET_FILE = inside;
    }
    expect(await secure.isEncryptionLocked()).toBe(true);
    let opened = false;
    try { opened = (await secure.decryptWithPassword(ciphertext)) !== null; } catch { /* denied */ }
    expect(opened).toBe(false);
  });

test.each(['wrapper', 'salt', 'kdf', 'iterations', 'key', 'profile', 'extra'])(
  'checks complete fresh metadata after warm reuse when %s changes', async variant => {
    const { secure, storage, format } = await modules();
    const ciphertext = (await secure.encryptWithPassword('disposable-operator-fixture'))!;
    const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
    const changed = { ...metadata } as EncryptionMetadata & { extra?: string };
    if (variant === 'wrapper') changed.data_encryption_key += 'invalid';
    if (variant === 'salt') changed.data_encryption_salt = '00'.repeat(16);
    if (variant === 'kdf') changed.kdf = 'unsupported';
    if (variant === 'iterations') changed.kdf_iterations = 1;
    if (variant === 'key') changed.key_id = '00'.repeat(32);
    if (variant === 'profile') changed.key_protection = 'passphrase';
    if (variant === 'extra') changed.extra = 'complete-revision-change';
    await storage.saveItem(StorageKey.ENCRYPTION_KEY, changed);
    const unwrap = jest.mocked(format.unwrapKeyring);
    unwrap.mockClear();
    const locked = await secure.isEncryptionLocked();
    if (variant === 'extra') {
      expect(locked).toBe(false);
      expect(unwrap.mock.calls.length).toBe(1);
    } else {
      expect(locked).toBe(true);
      let opened = false;
      try { opened = (await secure.decryptWithPassword(ciphertext)) !== null; } catch { /* denied */ }
      expect(opened).toBe(false);
    }
  });

test('migration, explicit lock and session revocation invalidate reuse before a fresh verified unwrap', async () => {
  const { secure, format, session, workspace } = await modules();
  await secure.encryptWithPassword('disposable-operator-fixture');
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  const marker = path.join(workspace.getWorkspaceDataDir(), 'db', '.credential-migration.pending');
  await fs.writeFile(marker, 'pending');
  expect(await secure.isEncryptionLocked()).toBe(true);
  await fs.unlink(marker);
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(1);
  session.lockServer();
  expect(await secure.isEncryptionLocked()).toBe(false); // The current mount can authorize a new unwrap.
  expect(unwrap.mock.calls.length).toBe(2);
  const token = session.createSession('disposable-invalid-session');
  session.invalidateSession(token);
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(3);
});

test('identical copied metadata and the same mount do not carry cache authority across workspaces or data roots', async () => {
  const { secure, format, storage, workspace } = await modules();
  await secure.encryptWithPassword('disposable-operator-fixture');
  const metadata = await storage.loadItem(StorageKey.ENCRYPTION_KEY, null);
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  await workspace.runWithWorkspace('another-workspace', async () => {
    await storage.saveItem(StorageKey.ENCRYPTION_KEY, metadata);
    expect(await secure.isEncryptionLocked()).toBe(false);
  });
  expect(unwrap.mock.calls.length).toBe(1);
  process.env.FLUJO_DATA_DIR = path.join(root, 'other-data');
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(2);
});

test.each(['lock', 'mount', 'metadata', 'migration'])(
  'an in-flight authenticated unwrap cannot publish or authorize after %s changes', async variant => {
    const { secure, format, storage, session, workspace } = await modules();
    await secure.initializeDefaultEncryption();
    const unwrap = jest.mocked(format.unwrapKeyring);
    const canonical = jest.requireActual<typeof format>('@/utils/encryption/format').unwrapKeyring;
    unwrap.mockImplementationOnce(async (metadata, secret) => {
      const ring = await canonical(metadata, secret);
      if (variant === 'lock') session.lockServer();
      if (variant === 'mount') await fs.writeFile(secretFile, randomBytes(32).toString('base64url'));
      if (variant === 'metadata') await storage.saveItem(StorageKey.ENCRYPTION_KEY, { ...metadata, key_id: '00'.repeat(32) });
      if (variant === 'migration') await fs.writeFile(path.join(workspace.getWorkspaceDataDir(), 'db', '.credential-migration.pending'), 'pending');
      return ring;
    });
    expect(await secure.isEncryptionLocked()).toBe(true);
    if (variant === 'lock') {
      unwrap.mockClear();
      expect(await secure.isEncryptionLocked()).toBe(false);
      expect(unwrap.mock.calls.length).toBe(1); // The rejected result was never retained.
    }
  });

test('another workspace lock cannot revoke this workspace verification or its warmed entry', async () => {
  const { secure, format, session, workspace } = await modules();
  await secure.initializeDefaultEncryption();
  const unwrap = jest.mocked(format.unwrapKeyring);
  const canonical = jest.requireActual<typeof format>('@/utils/encryption/format').unwrapKeyring;
  unwrap.mockImplementationOnce(async (metadata, secret) => {
    const ring = await canonical(metadata, secret);
    workspace.runWithWorkspace('unrelated', () => session.lockServer());
    return ring;
  });
  expect(await secure.isEncryptionLocked()).toBe(false);
  unwrap.mockClear();
  workspace.runWithWorkspace('unrelated', () => session.lockServer());
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(0);
});

test.each(['lock', 'failed metadata'])('another initialized workspace %s cannot revoke this workspace entry', async variant => {
  const { secure, format, storage, session, workspace } = await modules();
  await secure.initializeDefaultEncryption();
  await workspace.runWithWorkspace('alternate', () => secure.initializeDefaultEncryption());
  expect(await secure.isEncryptionLocked()).toBe(false);
  await workspace.runWithWorkspace('alternate', async () => {
    expect(await secure.isEncryptionLocked()).toBe(false);
    if (variant === 'lock') session.lockServer();
    else {
      const metadata = (await storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!;
      await storage.saveItem(StorageKey.ENCRYPTION_KEY, { ...metadata, key_id: '00'.repeat(32) });
      expect(await secure.isEncryptionLocked()).toBe(true);
    }
  });
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(0);
});

test('observing an expired session revokes its issuing workspace while another verified entry remains usable', async () => {
  const intervals = jest.spyOn(global, 'setInterval').mockReturnValue({ unref: jest.fn() } as unknown as ReturnType<typeof setInterval>);
  const { secure, format, session, workspace } = await modules();
  for (const selected of ['expired', 'active']) await workspace.runWithWorkspace(selected, async () => {
    await secure.initializeDefaultEncryption();
    const token = session.createSession('disposable-session');
    if (selected === 'expired') {
      global.__flujo_encryption_sessions_by_workspace!.get(selected)!.get(token)!.createdAt = Date.now() - 3 * 60 * 60 * 1000;
    }
    expect(await secure.isEncryptionLocked()).toBe(false);
  });
  const cleanup = intervals.mock.calls.find(([, delay]) => delay === 60 * 60 * 1000)?.[0];
  expect(typeof cleanup).toBe('function');
  if (typeof cleanup !== 'function') throw new Error('Session cleanup callback missing');
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  cleanup(); // The caller remains in the default workspace.
  expect(await workspace.runWithWorkspace('active', () => secure.isEncryptionLocked())).toBe(false);
  expect(unwrap.mock.calls.length).toBe(0);
  expect(await workspace.runWithWorkspace('expired', () => secure.isEncryptionLocked())).toBe(false);
  expect(unwrap.mock.calls.length).toBe(1);
});

test('a changed but valid mount record forces a new verified unwrap rather than using file age', async () => {
  const { secure, format } = await modules();
  await secure.encryptWithPassword('disposable-operator-fixture');
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  const secret = await fs.readFile(secretFile);
  const replacement = `${secretFile}.replacement`;
  await fs.writeFile(replacement, Buffer.concat([secret, Buffer.from('\n')]), { mode: 0o600 });
  await fs.rename(replacement, secretFile);
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(1);
});

test('a failed fresh metadata read revokes the old cached result before matching metadata is restored', async () => {
  const { secure, storage, format } = await modules();
  await secure.encryptWithPassword('disposable-operator-fixture');
  const metadata = await storage.loadItem(StorageKey.ENCRYPTION_KEY, null);
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, {});
  await expect(secure.isEncryptionLocked()).rejects.toThrow('metadata');
  await storage.saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  const unwrap = jest.mocked(format.unwrapKeyring);
  unwrap.mockClear();
  expect(await secure.isEncryptionLocked()).toBe(false);
  expect(unwrap.mock.calls.length).toBe(1);
});

test('a matching generic server key never substitutes for an unavailable operator mount', async () => {
  const { secure, session } = await modules();
  const ciphertext = (await secure.encryptWithPassword('disposable-operator-fixture'))!;
  const serialized = await secure.getOperatorWorkerBootstrapKey(
    (await (await modules()).storage.loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null))!);
  delete process.env.FLUJO_ENCRYPTION_SECRET_FILE;
  session.unlockServer(serialized);
  expect(await secure.isEncryptionLocked()).toBe(true);
  await expect(secure.decryptWithPassword(ciphertext)).rejects.toBeInstanceOf(secure.EncryptionLockedError);
});

const posixTest = process.platform === 'win32' ? test.skip : test;
posixTest('a warmed operator key cannot bypass changed POSIX mount permissions', async () => {
  const { secure } = await modules();
  await secure.encryptWithPassword('disposable-operator-fixture');
  await fs.chmod(secretFile, 0o644);
  expect(await secure.isEncryptionLocked()).toBe(true);
});
