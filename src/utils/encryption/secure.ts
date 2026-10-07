import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadItem, saveItem, writeFileAtomic } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace, getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { createSession, getDekFromSession, invalidateSession, unlockServer, getServerDek, isServerLocked,
  recordWorkerTransferProvenance, getWorkerTransferProvenance } from './session';
import {
  DEFAULT_PASSWORD, decryptLegacy, keyId, metadataRevision, newKeyring, open, parseSessionKey, seal,
  serializeKeyring, unwrapKeyring, unwrapLegacyKey, wrapKeyring,
  type EncryptionMetadata, type EncryptionType, type Keyring,
} from './format';
import { assertCredentialMigrationReady, isCredentialMigrationPending } from './credentialMigrationState';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { readOperatorSecret } from './operatorSecret';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { getDataDir } from '@/utils/paths';
import { assertLinkFreeFileParent } from '@/backend/services/workspace/backupRestoreFs';
export { isValidEncryptionSessionKey } from './format';

const log = createLogger('utils/encryption/secure');
const DATA_PURPOSE = 'flujo:secret:v2';

export class EncryptionLockedError extends Error {
  constructor(message = 'Encryption is locked: unlock with your password before accessing secrets') {
    super(message);
    this.name = 'EncryptionLockedError';
    Object.setPrototypeOf(this, EncryptionLockedError.prototype);
  }
}

declare global {
  var __flujo_encryption_metadata_locks: Map<string, Promise<unknown>> | undefined;
}

/** Serialize initialization/migration/password changes, including across route bundles. */
async function withMetadataLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = global.__flujo_encryption_metadata_locks ??= new Map();
  const key = workspaceCacheKey('encryption-metadata');
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

async function readMetadata(): Promise<EncryptionMetadata | null> {
  const stored = await loadItem<unknown>(StorageKey.ENCRYPTION_KEY, null);
  if (stored === null || stored === undefined) {
    // Generic storage treats empty/whitespace files and JSON null as absent.
    // Key metadata cannot use that recovery policy: minting a replacement key
    // would make the workspace's existing ciphertext permanently unreadable.
    const metadataPath = path.join(getWorkspaceDataDir(), 'db', `${StorageKey.ENCRYPTION_KEY}.json`);
    try {
      await fs.lstat(metadataPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    throw new Error('Existing encryption metadata is empty or invalid; restore it from a matching workspace backup');
  }
  if (typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid encryption metadata');
  const metadata = stored as EncryptionMetadata;
  if (![1, 2].includes(metadata.encryption_version)) throw new Error('Unsupported encryption metadata version');
  if (metadata.encryption_type !== undefined && !['default', 'user'].includes(metadata.encryption_type)) {
    throw new Error('Invalid encryption type');
  }
  if (metadata.key_protection !== undefined && (metadata.encryption_type !== 'user'
      || !['passphrase', 'operator-file'].includes(metadata.key_protection))) throw new Error('Invalid key protection');
  return metadata;
}

async function persist(ring: Keyring, type: EncryptionType, password: string,
  protection?: EncryptionMetadata['key_protection'], fresh = false): Promise<EncryptionMetadata> {
  await assertCredentialMigrationReady();
  const metadata = await wrapKeyring(ring, type, password, protection);
  if (fresh) {
    const final = path.join(getWorkspaceDataDir(), 'db', `${StorageKey.ENCRYPTION_KEY}.json`);
    const staged = `${final}.initial.${randomUUID()}`;
    try {
      await writeFileAtomic(staged, JSON.stringify(metadata));
      // An atomic no-replace hard link elects one key across separate OS processes.
      // The staged record is complete and synced before it can become visible.
      try { await fs.link(staged, final); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const committed = await readMetadata();
      if (!committed) throw new Error('Private encryption initialization did not commit');
      return committed;
    } finally {
      try { await fs.unlink(staged); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  // Atomic rename: no ciphertext is written under a new key until this succeeds.
  // Interrupted migration leaves either complete v1 or complete v2 metadata.
  await withWorkspaceMutation(async () => {
    await assertCredentialMigrationReady();
    const current = await readMetadata();
    // A v1 upgrader admitted after bulk migration must not overwrite the newly
    // committed v2 key with its independently generated random key.
    if (current?.encryption_version === 2 && current.key_id !== keyId(ring)) {
      throw new EncryptionLockedError('Encryption key changed; retry using current metadata');
    }
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  });
  return metadata;
}

async function metadataOrInitialize(): Promise<EncryptionMetadata> {
  const existing = await readMetadata();
  if (existing) return existing;
  const secret = readOperatorSecret();
  if (!secret) throw new EncryptionLockedError('Initialize private encryption with a passphrase or operator secret before saving credentials');
  return persist(newKeyring(), 'user', secret, 'operator-file', true);
}

/** Upgrade metadata only; keep v1 ciphertext decryptable without a bulk rewrite. */
async function unwrapAndUpgrade(metadata: EncryptionMetadata, password: string): Promise<Keyring> {
  if (metadata.encryption_version === 2) return unwrapKeyring(metadata, password);
  const legacyKey = await unwrapLegacyKey(metadata, password);
  const ring = newKeyring(legacyKey);
  await persist(ring, metadata.encryption_type ?? 'default', password);
  return ring;
}

export async function initializeDefaultEncryption(): Promise<boolean> {
  try {
    return await withMetadataLock(async () => { await metadataOrInitialize(); return true; });
  } catch { log.error('Could not initialize encryption metadata'); return false; }
}

/** Existing USER metadata must never be overwritten by a second initialization. */
export async function initializeEncryption(password: string): Promise<boolean> {
  if (!password || password === DEFAULT_PASSWORD) return false;
  try {
    return await withMetadataLock(async () => {
      const metadata = await readMetadata();
      if (metadata?.encryption_type === 'user') return false;
      const ring = !metadata ? newKeyring()
        : metadata.encryption_version === 2 ? await unwrapKeyring(metadata, DEFAULT_PASSWORD)
          : newKeyring(await unwrapLegacyKey(metadata, DEFAULT_PASSWORD));
      const committed = await persist(ring, 'user', password, 'passphrase', !metadata);
      return committed.key_id === keyId(ring);
    });
  } catch { log.error('Could not initialize password encryption'); return false; }
}

export async function migrateToUserEncryption(password: string): Promise<boolean> {
  if (await isUserEncryptionEnabled()) return true;
  return initializeEncryption(password);
}

export async function changeEncryptionPassword(oldPassword: string, newPassword: string): Promise<boolean> {
  if (!newPassword || newPassword === DEFAULT_PASSWORD) return false;
  try {
    return await withMetadataLock(async () => {
      const metadata = await readMetadata();
      if (!metadata) return false;
      const password = metadata.key_protection === 'operator-file' ? readOperatorSecret()
        : metadata.encryption_type === 'user' ? oldPassword : DEFAULT_PASSWORD;
      if (!password) return false;
      const ring = metadata.encryption_version === 2 ? await unwrapKeyring(metadata, password)
        : newKeyring(await unwrapLegacyKey(metadata, password));
      const committed = await persist(ring, 'user', newPassword, 'passphrase');
      if (getServerDek()) unlockServer(serializeKeyring(ring, metadataRevision(committed)));
      return true;
    });
  } catch { log.error('Could not change encryption password'); return false; }
}

async function workerRootIdentity(root: string) {
  const expected = path.resolve(getWorkspaceDataDir());
  if (path.resolve(root) !== expected) throw new EncryptionLockedError('Worker transfer root mismatch');
  await assertLinkFreeFileParent(getDataDir(), path.join(expected, 'probe'));
  const stat = await fs.lstat(expected, { bigint: true });
  const canonical = await fs.realpath(expected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(expected, canonical) !== '') {
    throw new EncryptionLockedError('Worker transfer root is unavailable');
  }
  return { root: canonical, rootDevice: stat.dev.toString(), rootInode: stat.ino.toString() };
}

/** Called only after authenticated restore validates its private bootstrap file. */
export async function unlockValidatedWorkerTransfer(serializedKey: string, context: { workspace: string; root: string }): Promise<void> {
  await withMetadataLock(async () => {
    if (!isWorkerMode() || context.workspace !== getCurrentWorkspace() || await isCredentialMigrationPending()) {
      throw new EncryptionLockedError('Worker transfer is unavailable');
    }
    const identity = await workerRootIdentity(context.root);
    const metadata = await readMetadata();
    const ring = parseSessionKey(serializedKey);
    if (!metadata || metadata.encryption_type !== 'user'
        || (metadata.key_protection === 'operator-file' && metadata.encryption_version !== 2)
        || (metadata.encryption_version === 2 && (!('activeKey' in ring) || keyId(ring) !== metadata.key_id
          || (ring.metadataRevision !== undefined && ring.metadataRevision !== metadataRevision(metadata))
          || ((metadata.key_protection === 'operator-file' || metadata.key_protection === 'passphrase')
            && ring.metadataRevision === undefined)))
        || (metadata.encryption_version === 1 && !('legacyKey' in ring))) {
      throw new EncryptionLockedError('Worker transfer does not match encryption metadata');
    }
    const after = await workerRootIdentity(context.root);
    if (JSON.stringify(after) !== JSON.stringify(identity)) throw new EncryptionLockedError('Worker transfer root changed');
    unlockServer(serializedKey);
    if (metadata.key_protection === 'operator-file' && 'activeKey' in ring) recordWorkerTransferProvenance({
      workspace: context.workspace, ...identity, keyId: keyId(ring), metadataRevision: metadataRevision(metadata),
    });
  });
}

async function transferredWorkerKeys(metadata: EncryptionMetadata): Promise<Keyring | null> {
  if (!isWorkerMode() || process.env.FLUJO_ENCRYPTION_SECRET_FILE !== undefined) return null;
  const provenance = getWorkerTransferProvenance();
  if (!provenance || provenance.workspace !== getCurrentWorkspace()
      || metadata.key_protection !== 'operator-file' || metadata.encryption_type !== 'user'
      || provenance.metadataRevision !== metadataRevision(metadata) || provenance.keyId !== metadata.key_id) return null;
  const identity = await workerRootIdentity(provenance.root);
  if (identity.root !== provenance.root || identity.rootDevice !== provenance.rootDevice || identity.rootInode !== provenance.rootInode) return null;
  const serialized = getServerDek();
  if (!serialized) return null;
  const ring = parseSessionKey(serialized);
  return 'activeKey' in ring && ring.metadataRevision === provenance.metadataRevision
    && keyId(ring) === provenance.keyId ? ring : null;
}

async function getKeys(passwordOrToken?: string, isToken = false, allowInitialize = false): Promise<Keyring | { legacyKey: string }> {
  return withMetadataLock(async () => {
    if (await isCredentialMigrationPending()) throw new EncryptionLockedError('Credential migration is pending; resume or roll back it before unlocking');
    const metadata = allowInitialize ? await metadataOrInitialize() : await readMetadata();
    if (!metadata) throw new EncryptionLockedError('Restore matching encryption metadata before decrypting credentials');
    if (metadata.key_protection === 'operator-file') {
      const transferred = await transferredWorkerKeys(metadata);
      if (transferred) return transferred;
      const secret = readOperatorSecret();
      if (!secret) throw new EncryptionLockedError('Private encryption operator secret is unavailable');
      // Re-read the independent mount even after the process was unlocked.
      return unwrapKeyring(metadata, secret);
    }
    if (metadata.encryption_type !== 'user') return unwrapAndUpgrade(metadata, DEFAULT_PASSWORD);
    // An explicit password is verified even if the process is already unlocked.
    if (passwordOrToken && !isToken) return unwrapAndUpgrade(metadata, passwordOrToken);
    const serialized = isToken && passwordOrToken ? getDekFromSession(passwordOrToken) : getServerDek();
    if (!serialized) throw new EncryptionLockedError();
    const ring = parseSessionKey(serialized);
    if ('activeKey' in ring && ((ring.metadataRevision !== undefined
        && ring.metadataRevision !== metadataRevision(metadata))
      || (metadata.key_protection === 'passphrase' && ring.metadataRevision === undefined))) {
      throw new EncryptionLockedError('Encryption metadata changed; unlock this workspace again');
    }
    if (metadata.encryption_version === 2 && (!('activeKey' in ring) || keyId(ring) !== metadata.key_id)) {
      throw new EncryptionLockedError('Encryption metadata changed; unlock this workspace again');
    }
    return ring;
  });
}

/** Every successful new write uses authenticated encryption with 32 random key bytes. */
export async function encryptWithPassword(text: string, passwordOrToken?: string, isToken = false): Promise<string | null> {
  try {
    const ring = await getKeys(passwordOrToken, isToken, true);
    if (!('activeKey' in ring)) {
      throw new EncryptionLockedError('Unlock with your password to upgrade legacy encryption before saving secrets');
    }
    return seal(text, ring.activeKey, DATA_PURPOSE);
  } catch (error) {
    if (error instanceof EncryptionLockedError) throw error;
    log.error('Secret encryption failed; no plaintext value will be saved');
    return null;
  }
}

export async function decryptWithPassword(ciphertext: string, passwordOrToken?: string, isToken = false): Promise<string | null> {
  try {
    const ring = await getKeys(passwordOrToken, isToken);
    if (ciphertext.startsWith('v2:')) {
      if (!('activeKey' in ring)) return null;
      return open(ciphertext, ring.activeKey, DATA_PURPOSE);
    }
    if (!ring.legacyKey) return null;
    return decryptLegacy(ciphertext, ring.legacyKey);
  } catch (error) {
    if (error instanceof EncryptionLockedError) throw error;
    log.error('Secret decryption failed: invalid credentials, metadata or ciphertext');
    return null;
  }
}

export async function verifyPassword(password: string): Promise<{ valid: boolean; token?: string }> {
  try {
    return await withMetadataLock(async () => {
      const metadata = await readMetadata();
      if (!metadata || metadata.encryption_type !== 'user' || metadata.key_protection === 'operator-file') return { valid: false };
      const ring = await unwrapAndUpgrade(metadata, password);
      const committed = await readMetadata();
      if (!committed || committed.key_id !== keyId(ring)) return { valid: false };
      const serialized = serializeKeyring(ring, metadataRevision(committed));
      unlockServer(serialized);
      return { valid: true, token: createSession(serialized) };
    });
  } catch { return { valid: false }; }
}

export async function authenticate(password: string): Promise<string | null> {
  const result = await verifyPassword(password);
  return result.valid ? result.token ?? null : null;
}

export async function logout(token: string): Promise<boolean> {
  invalidateSession(token);
  return true;
}

export async function isEncryptionInitialized(): Promise<boolean> {
  return (await readMetadata()) !== null;
}

/** Deliberate worker transfer only: authenticate the independent mount or exact
 * validated worker provenance against captured metadata, without a UI session. */
export async function getOperatorWorkerBootstrapKey(capturedMetadata: EncryptionMetadata): Promise<string> {
  return withMetadataLock(async () => {
    await assertCredentialMigrationReady();
    const metadata = await readMetadata();
    if (!metadata || metadata.key_protection !== 'operator-file'
        || metadataRevision(metadata) !== metadataRevision(capturedMetadata)) {
      throw new EncryptionLockedError('Worker snapshot encryption metadata changed');
    }
    const transferred = await transferredWorkerKeys(metadata);
    if (transferred) return serializeKeyring(transferred, metadataRevision(metadata));
    const secret = readOperatorSecret();
    if (!secret) throw new EncryptionLockedError('Private encryption operator secret is unavailable');
    const ring = await unwrapKeyring(metadata, secret);
    return serializeKeyring(ring, metadataRevision(metadata));
  });
}

export async function isUserEncryptionEnabled(): Promise<boolean> {
  const metadata = await readMetadata();
  return metadata?.encryption_type === 'user' && metadata.key_protection !== 'operator-file';
}

export async function isEncryptionLocked(): Promise<boolean> {
  if (await isCredentialMigrationPending()) return true;
  let metadata = await readMetadata();
  if (!metadata && process.env.FLUJO_ENCRYPTION_SECRET_FILE !== undefined) {
    try { metadata = await withMetadataLock(metadataOrInitialize); } catch { return true; }
  }
  if (!metadata) return true;
  const cached = getServerDek();
  if (cached) {
    try {
      const ring = parseSessionKey(cached);
      if ('activeKey' in ring && ring.metadataRevision !== undefined
          && ring.metadataRevision !== metadataRevision(metadata)) return true;
    } catch { return true; }
  }
  if (metadata.key_protection === 'operator-file') {
    try {
      if (await transferredWorkerKeys(metadata)) return false;
      const secret = readOperatorSecret();
      if (!secret) return true;
      await unwrapKeyring(metadata, secret);
      return false;
    } catch { return true; }
  }
  return (await isUserEncryptionEnabled()) && isServerLocked();
}

export async function getEncryptionType(): Promise<EncryptionType | null> {
  const metadata = await readMetadata();
  return metadata ? metadata.encryption_type ?? 'default' : null;
}

export async function getEncryptionStatus() {
  if (await isCredentialMigrationPending()) return { initialized: true, locked: true, protection: 'migration-pending' };
  const locked = await isEncryptionLocked();
  const metadata = await readMetadata();
  return { initialized: metadata !== null, locked, protection: !metadata
    ? process.env.FLUJO_ENCRYPTION_SECRET_FILE !== undefined ? 'operator-file' : 'uninitialized'
    : metadata.key_protection ?? (metadata.encryption_type === 'user' ? 'passphrase' : 'legacy-default') };
}
