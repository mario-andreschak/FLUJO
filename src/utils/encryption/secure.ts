import path from 'node:path';
import { createHash } from 'node:crypto';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import type { EncryptionStatus } from '@/shared/types/encryption';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { createSession, getDekFromSession, invalidateSession, unlockServer, lockServer, getServerDek, isServerLocked } from './session';
import { hasOperatorPassphrase, isPrivatePassphrase, readOperatorPassphrase } from './privateProfile';
import { assertFreshEncryptionSetup, readCredentialJson } from './workspaceFiles';
import {
  DEFAULT_PASSWORD, decryptLegacy, keyId, newKeyring, open, parseSessionKey, seal,
  serializeKeyring, unwrapKeyring, unwrapLegacyKey, wrapKeyring,
  type EncryptionMetadata, type EncryptionType, type Keyring,
} from './format';
export { isValidEncryptionSessionKey } from './format';

const log = createLogger('utils/encryption/secure');
const DATA_PURPOSE = 'flujo:secret:v2';
const operatorUnlocks = new Map<string, string>();

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
  const current = previous.catch(() => undefined).then(async () => {
    const { withWorkspaceRuntimeLock } = await import('@/backend/services/enduringAgents/runtimeLock');
    return withWorkspaceRuntimeLock('encryption-metadata', async lock => {
      await lock.assertOwned();
      const result = await operation();
      await lock.assertOwned();
      return result;
    });
  });
  locks.set(key, current);
  try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
}

async function readMetadata(): Promise<EncryptionMetadata | null> {
  const metadataPath = path.join(getWorkspaceDataDir(), 'db', `${StorageKey.ENCRYPTION_KEY}.json`);
  let stored: unknown;
  try {
    stored = await readCredentialJson(metadataPath, 32_768);
  } catch {
    // The generic storage parser logs diagnostics and copies corrupt input.
    // Key metadata must fail closed without either payload-bearing side effect.
    throw new Error('Encryption metadata is invalid; restore a matching workspace backup');
  }
  if (stored === undefined) return null;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Invalid encryption metadata');
  const metadata = stored as EncryptionMetadata;
  if (![1, 2].includes(metadata.encryption_version)) throw new Error('Unsupported encryption metadata version');
  if (metadata.encryption_type !== undefined && !['default', 'user'].includes(metadata.encryption_type)) {
    throw new Error('Invalid encryption type');
  }
  return metadata;
}

async function persist(ring: Keyring, type: EncryptionType, password: string): Promise<EncryptionMetadata> {
  const metadata = await wrapKeyring(ring, type, password);
  // Atomic rename: no ciphertext is written under a new key until this succeeds.
  // Interrupted migration leaves either complete v1 or complete v2 metadata.
  await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
  return metadata;
}

async function metadataOrInitialize(): Promise<EncryptionMetadata> {
  const existing = await readMetadata();
  if (existing) return existing;
  if (!hasOperatorPassphrase()) throw new EncryptionLockedError('Encryption setup is required before saving credentials');
  await assertFreshEncryptionSetup();
  const password = await readOperatorPassphrase();
  const ring = newKeyring();
  const metadata = await persist(ring, 'user', password);
  unlockServer(serializeKeyring(ring));
  operatorUnlocks.set(workspaceCacheKey('operator-unlock'), operatorRevision(metadata, password));
  return metadata;
}

function operatorRevision(metadata: EncryptionMetadata, password: string): string {
  return createHash('sha256').update(JSON.stringify(metadata)).update('\0').update(password).digest('hex');
}

async function operatorKeys(metadata: EncryptionMetadata): Promise<Keyring> {
  const cache = workspaceCacheKey('operator-unlock');
  try {
    if (metadata.encryption_type !== 'user') throw new Error();
    const password = await readOperatorPassphrase();
    const revision = operatorRevision(metadata, password);
    const unlocked = getServerDek();
    if (operatorUnlocks.get(cache) === revision && unlocked) {
      const ring = parseSessionKey(unlocked);
      if ('activeKey' in ring && metadata.key_id === keyId(ring)) return ring;
    }
    const ring = await unwrapAndUpgrade(metadata, password);
    unlockServer(serializeKeyring(ring));
    operatorUnlocks.set(cache, revision);
    return ring;
  } catch {
    lockServer();
    operatorUnlocks.delete(cache);
    throw new EncryptionLockedError('Operator encryption secret is unavailable; restore it or complete the explicit migration');
  }
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
    return await withMetadataLock(async () => {
      const metadata = await metadataOrInitialize();
      if (hasOperatorPassphrase()) await operatorKeys(metadata);
      return true;
    });
  } catch { log.error('Could not initialize encryption metadata'); return false; }
}

/** Existing USER metadata must never be overwritten by a second initialization. */
export async function initializeEncryption(password: string): Promise<boolean> {
  if (!isPrivatePassphrase(password)) return false;
  try {
    return await withMetadataLock(async () => {
      const metadata = await readMetadata();
      if (metadata?.encryption_type === 'user') return false;
      if (!metadata) await assertFreshEncryptionSetup();
      const ring = !metadata ? newKeyring()
        : metadata.encryption_version === 2 ? await unwrapKeyring(metadata, DEFAULT_PASSWORD)
          : newKeyring(await unwrapLegacyKey(metadata, DEFAULT_PASSWORD));
      await persist(ring, 'user', password);
      return true;
    });
  } catch { log.error('Could not initialize password encryption'); return false; }
}

export async function migrateToUserEncryption(password: string): Promise<boolean> {
  if (await isUserEncryptionEnabled()) return true;
  return initializeEncryption(password);
}

export async function changeEncryptionPassword(oldPassword: string, newPassword: string): Promise<boolean> {
  if (!isPrivatePassphrase(newPassword)) return false;
  try {
    return await withMetadataLock(async () => {
      const metadata = await readMetadata();
      if (!metadata) return false;
      const password = metadata.encryption_type === 'user' ? oldPassword : DEFAULT_PASSWORD;
      const ring = metadata.encryption_version === 2 ? await unwrapKeyring(metadata, password)
        : newKeyring(await unwrapLegacyKey(metadata, password));
      await persist(ring, 'user', newPassword);
      if (getServerDek()) unlockServer(serializeKeyring(ring));
      return true;
    });
  } catch { log.error('Could not change encryption password'); return false; }
}

async function getKeys(passwordOrToken?: string, isToken = false): Promise<Keyring | { legacyKey: string }> {
  return withMetadataLock(async () => {
    const metadata = await metadataOrInitialize();
    if (hasOperatorPassphrase() && metadata.encryption_type !== 'user') {
      throw new EncryptionLockedError('Explicit migration is required for public-password metadata');
    }
    if (hasOperatorPassphrase() && (!passwordOrToken || isToken)) return operatorKeys(metadata);
    if (metadata.encryption_type !== 'user') return unwrapAndUpgrade(metadata, DEFAULT_PASSWORD);
    // An explicit password is verified even if the process is already unlocked.
    if (passwordOrToken && !isToken) return unwrapAndUpgrade(metadata, passwordOrToken);
    const serialized = isToken && passwordOrToken ? getDekFromSession(passwordOrToken) : getServerDek();
    if (!serialized) throw new EncryptionLockedError();
    const ring = parseSessionKey(serialized);
    if (metadata.encryption_version === 2 && (!('activeKey' in ring) || keyId(ring) !== metadata.key_id)) {
      throw new EncryptionLockedError('Encryption metadata changed; unlock this workspace again');
    }
    return ring;
  });
}

/** Every successful new write uses authenticated encryption with 32 random key bytes. */
export async function encryptWithPassword(text: string, passwordOrToken?: string, isToken = false): Promise<string | null> {
  try {
    const ring = await getKeys(passwordOrToken, isToken);
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
      if (!metadata || metadata.encryption_type !== 'user') return { valid: false };
      const ring = await unwrapAndUpgrade(metadata, password);
      const serialized = serializeKeyring(ring);
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

export async function isUserEncryptionEnabled(): Promise<boolean> {
  return (await readMetadata())?.encryption_type === 'user';
}

export async function isEncryptionLocked(): Promise<boolean> {
  const metadata = await readMetadata();
  if (!metadata) {
    if (!hasOperatorPassphrase()) return true;
    return !await initializeDefaultEncryption();
  }
  if (hasOperatorPassphrase()) {
    try { await withMetadataLock(() => operatorKeys(metadata)); return false; }
    catch { return true; }
  }
  return metadata.encryption_type === 'user' && isServerLocked();
}

export async function getEncryptionType(): Promise<EncryptionType | null> {
  const metadata = await readMetadata();
  return metadata ? metadata.encryption_type ?? 'default' : null;
}

export async function getEncryptionStatus(): Promise<EncryptionStatus> {
  return withMetadataLock<EncryptionStatus>(async () => {
    let metadata = await readMetadata();
    let recoveryRequired = false;
    if (!metadata) {
      try { await assertFreshEncryptionSetup(); }
      catch { recoveryRequired = true; }
    }
    const operator = hasOperatorPassphrase();
    let locked = !metadata || (metadata.encryption_type === 'user' && isServerLocked());
    if (operator && !recoveryRequired) {
      try {
        metadata ??= await metadataOrInitialize();
        await operatorKeys(metadata);
        locked = false;
      } catch { locked = true; }
    }
    const type = metadata ? metadata.encryption_type ?? 'default' : null;
    return { initialized: !!metadata, type, locked, recoveryRequired,
      protection: operator ? 'operator' : type === 'default' ? 'legacy' : 'interactive' };
  });
}
