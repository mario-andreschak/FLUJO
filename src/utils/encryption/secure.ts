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
  DEFAULT_PASSWORD, KEY_PROTECTIONS, decryptLegacy, keyId, metadataRevision, newKeyring, open, parseSessionKey, seal,
  serializeKeyring, unwrapKeyring, unwrapLegacyKey, wrapKeyring,
  type EncryptionMetadata, type EncryptionType, type Keyring,
} from './format';
import {
  adoptSystemSecret, backupKeyFileBeforeMove, getSystemKeyStatus, getSystemSecret, normalizeRecoveryKey,
  SystemKeyError, systemKeyRetryAt,
} from './systemKey';
import { detectSystemKeyStore } from './systemKeyStore';
import { assertCredentialMigrationReady, isCredentialMigrationPending } from './credentialMigrationState';
import { withWorkspaceMutation } from '@/backend/services/workspace/workspaceMutationGate';
import { readOperatorSecret } from './operatorSecret';
import { invalidateOperatorKeyring, OperatorKeyringContextChangedError, verifiedOperatorKeyring } from './operatorKeyringCache';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { getDataDir } from '@/utils/paths';
import { assertLinkFreeFileParent } from '@/backend/services/workspace/backupRestoreFs';
import { findStoredCiphertext } from './storedCiphertext';
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

export class CredentialMigrationRequiredError extends Error {
  constructor() {
    super('Run credential migration preflight and confirm migration to retire the public-default active key before enabling private encryption.');
    this.name = 'CredentialMigrationRequiredError';
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
      || !KEY_PROTECTIONS.includes(metadata.key_protection))) throw new Error('Invalid key protection');
  return metadata;
}

function metadataFilePath(): string {
  return path.join(getWorkspaceDataDir(), 'db', `${StorageKey.ENCRYPTION_KEY}.json`);
}

async function persist(ring: Keyring, type: EncryptionType, password: string,
  protection?: EncryptionMetadata['key_protection'], fresh = false): Promise<EncryptionMetadata> {
  invalidateOperatorKeyring();
  await assertCredentialMigrationReady();
  return commitMetadata(await wrapKeyring(ring, type, password, protection), ring, fresh);
}

async function commitMetadata(metadata: EncryptionMetadata, ring: Keyring, fresh = false): Promise<EncryptionMetadata> {
  invalidateOperatorKeyring();
  await assertCredentialMigrationReady();
  if (fresh) {
    const final = metadataFilePath();
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

function missingMetadataMessage(file: string): string {
  return `Encrypted secrets were found in ${file}, but this workspace's key file db/encryption_key.json is missing, `
    + 'so they cannot be read. Put back db/encryption_key.json from the source workspace or a matching backup, '
    + 'or capture a new worker snapshot from a source that still has it.';
}

async function metadataOrInitialize(): Promise<EncryptionMetadata> {
  const existing = await readMetadata();
  if (existing) return existing;
  if (isWorkerMode()) {
    // A restored worker that never stored a secret gets the key its source would
    // create on first use. A new key must never hide secrets that are unreadable.
    const file = await findStoredCiphertext({ fresh: true });
    if (file) throw new EncryptionLockedError(missingMetadataMessage(file));
  }
  const secret = await readOperatorSecret();
  // A custom password is optional. Explicit operator provisioning still fails
  // closed in readOperatorSecret. Ordinary local use gets the system key when
  // this computer offers a protected store (#1443), else default encryption.
  if (secret) return persist(newKeyring(), 'user', secret, 'operator-file', true);
  const system = await systemSecretForNewKey();
  return system ? persist(newKeyring(), 'user', system, 'os-store', true)
    : persist(newKeyring(), 'default', DEFAULT_PASSWORD, undefined, true);
}

/** The system key may wrap new or default keys only where nobody else manages keys. */
function systemKeyAllowed(): boolean {
  return !isWorkerMode() && process.env.FLUJO_ENCRYPTION_SECRET_FILE === undefined;
}

async function systemSecretForNewKey(): Promise<string | null> {
  if (!systemKeyAllowed()) return null;
  try { return await getSystemSecret({ create: true }); }
  catch (error) {
    log.warn(`Using basic protection for now: ${error instanceof Error ? error.message : 'the system key store did not answer'}`);
    return null;
  }
}

function lockedBySystemKey(error: unknown): EncryptionLockedError {
  return new EncryptionLockedError(error instanceof SystemKeyError ? error.message
    : 'FLUJO could not reach the system key store. It keeps trying on its own. You can also unlock with your recovery key.');
}

function serverRingFor(metadata: EncryptionMetadata): Keyring | null {
  const serialized = getServerDek();
  if (!serialized) return null;
  try {
    const ring = parseSessionKey(serialized);
    return 'activeKey' in ring && ring.metadataRevision === metadataRevision(metadata) && keyId(ring) === metadata.key_id
      ? ring : null;
  } catch { return null; }
}

/**
 * Opens a workspace whose key is wrapped by the system key: from the unlocked
 * server state, else with the system key, which then unlocks the server. Runs
 * under the metadata lock.
 */
async function systemKeyring(metadata: EncryptionMetadata): Promise<Keyring> {
  const unlocked = serverRingFor(metadata);
  if (unlocked) return unlocked;
  if (isWorkerMode()) throw new EncryptionLockedError('Worker workspace encryption is locked. Unlock this workspace before running jobs.');
  let secret: string | null;
  try { secret = await getSystemSecret(); }
  catch (error) { throw lockedBySystemKey(error); }
  if (!secret) throw lockedBySystemKey(new SystemKeyError('missing', null));
  let ring: Keyring;
  try { ring = await unwrapKeyring(metadata, secret); }
  catch {
    throw new EncryptionLockedError('This workspace was protected by another FLUJO system key, for example on another computer. '
      + "Unlock it once with that recovery key; FLUJO then protects it with this computer's key.");
  }
  unlockServer(serializeKeyring(ring, metadataRevision(metadata)));
  return ring;
}

declare global {
  var __flujo_system_key_moves: Map<string, number> | undefined;
}
const MOVE_RETRY_MS = 60_000;

/**
 * Moves a default-protected workspace key under the system key (#1443). The
 * data key itself stays the same, so every stored secret, worker snapshot and
 * task payload stays readable. A sealed copy of the old key file is written
 * first; the new file replaces the old one in a single atomic step and is
 * opened before it is written. Runs under the metadata lock.
 */
async function moveToSystemKey(metadata: EncryptionMetadata): Promise<EncryptionMetadata | null> {
  if (!systemKeyAllowed() || metadata.encryption_type === 'user' || await isCredentialMigrationPending()) return null;
  const moves = global.__flujo_system_key_moves ??= new Map();
  const workspaceKey = workspaceCacheKey('system-key-move');
  if ((moves.get(workspaceKey) ?? 0) > Date.now() || !(await detectSystemKeyStore())) return null;
  let secret: string | null;
  try { secret = await getSystemSecret({ create: true }); }
  catch { return null; }
  if (!secret) return null;
  try {
    const ring = await unwrapAndUpgrade(metadata, DEFAULT_PASSWORD);
    const current = await readMetadata();
    if (!current || current.encryption_type === 'user') return null;
    const candidate = await wrapKeyring(ring, 'user', secret, 'os-store');
    if (keyId(await unwrapKeyring(candidate, secret)) !== keyId(ring)) throw new Error('The new key file did not open');
    await backupKeyFileBeforeMove(getCurrentWorkspace(), await fs.readFile(metadataFilePath()), secret);
    await commitMetadata(candidate, ring);
    const committed = await readMetadata();
    if (!committed || metadataRevision(committed) !== metadataRevision(candidate)) return null;
    unlockServer(serializeKeyring(ring, metadataRevision(committed)));
    moves.delete(workspaceKey);
    log.info(`Saved credentials of workspace "${getCurrentWorkspace()}" are now protected by the system key`);
    return committed;
  } catch (error) {
    moves.set(workspaceKey, Date.now() + MOVE_RETRY_MS);
    log.warn(`Could not move workspace "${getCurrentWorkspace()}" to the system key yet; trying again later`, error);
    return null;
  }
}

/**
 * Lock checks run on every request, so this returns at once while a move is
 * not possible or waits for its next try, and asks the store for the system
 * key before taking the metadata lock: a slow store never holds up requests.
 */
async function tryMoveToSystemKey(): Promise<boolean> {
  if (!systemKeyAllowed() || !(await detectSystemKeyStore())) return false;
  const now = Date.now();
  if ((global.__flujo_system_key_moves?.get(workspaceCacheKey('system-key-move')) ?? 0) > now
      || (systemKeyRetryAt() ?? 0) > now) return false;
  if (!(await getSystemSecret({ create: true }).catch(() => null))) return false;
  return withMetadataLock(async () => {
    const current = await readMetadata();
    return current !== null && current.encryption_type !== 'user' && (await moveToSystemKey(current)) !== null;
  }).catch(() => false);
}

/** A recovery key opened this workspace: put it back into the system store, or re-protect the workspace with this computer's key. */
async function unlockWithRecoveryKey(metadata: EncryptionMetadata, input: string): Promise<{ valid: boolean; token?: string }> {
  const secret = normalizeRecoveryKey(input);
  const ring = await unwrapKeyring(metadata, secret);
  let committed = metadata;
  const adopted = isWorkerMode() ? 'memory-only' : await adoptSystemSecret(secret).catch(() => 'memory-only' as const);
  if (adopted === 'different') {
    const own = await getSystemSecret().catch(() => null);
    if (own) {
      await commitMetadata(await wrapKeyring(ring, 'user', own, 'os-store'), ring);
      committed = (await readMetadata()) ?? metadata;
    }
  }
  const serialized = serializeKeyring(ring, metadataRevision(committed));
  unlockServer(serialized);
  return { valid: true, token: createSession(serialized) };
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
      if (metadata?.encryption_version === 2) throw new CredentialMigrationRequiredError();
      const ring = !metadata ? newKeyring() : newKeyring(await unwrapLegacyKey(metadata, DEFAULT_PASSWORD));
      const committed = await persist(ring, 'user', password, 'passphrase', !metadata);
      return committed.key_id === keyId(ring);
    });
  } catch (error) {
    if (error instanceof CredentialMigrationRequiredError) throw error;
    log.error('Could not initialize password encryption'); return false;
  }
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
      // A system key may wrap a key that was once publicly wrapped; a password goes through the migration that can replace it.
      if ((metadata.encryption_version === 2 && metadata.encryption_type !== 'user') || metadata.key_protection === 'os-store') {
        throw new CredentialMigrationRequiredError();
      }
      const password = metadata.key_protection === 'operator-file' ? await readOperatorSecret()
        : metadata.encryption_type === 'user' ? oldPassword : DEFAULT_PASSWORD;
      if (!password) return false;
      const ring = metadata.encryption_version === 2 ? await unwrapKeyring(metadata, password)
        : newKeyring(await unwrapLegacyKey(metadata, password));
      const committed = await persist(ring, 'user', newPassword, 'passphrase');
      if (getServerDek()) unlockServer(serializeKeyring(ring, metadataRevision(committed)));
      return true;
    });
  } catch (error) {
    if (error instanceof CredentialMigrationRequiredError) throw error;
    log.error('Could not change encryption password'); return false;
  }
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
          || (metadata.key_protection !== undefined && ring.metadataRevision === undefined)))
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
      return verifiedOperatorKeyring(metadata, readMetadata);
    }
    invalidateOperatorKeyring();
    if (metadata.key_protection === 'os-store') {
      if (passwordOrToken && !isToken) return unwrapKeyring(metadata, normalizeRecoveryKey(passwordOrToken));
      return systemKeyring(metadata);
    }
    if (metadata.encryption_type !== 'user') {
      const moved = await moveToSystemKey(metadata);
      return moved ? systemKeyring(moved) : unwrapAndUpgrade(metadata, DEFAULT_PASSWORD);
    }
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
  }).catch(error => {
    invalidateOperatorKeyring();
    if (error instanceof OperatorKeyringContextChangedError) throw new EncryptionLockedError(error.message);
    throw error;
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
      if (metadata.key_protection === 'os-store') return await unlockWithRecoveryKey(metadata, password);
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
    const ring = await verifiedOperatorKeyring(metadata, readMetadata);
    return serializeKeyring(ring, metadataRevision(metadata));
  }).catch(error => {
    invalidateOperatorKeyring();
    if (error instanceof OperatorKeyringContextChangedError) throw new EncryptionLockedError(error.message);
    throw error;
  });
}

/** Snapshot capture for a workspace protected by the system key: the keyring, bound to the captured metadata. */
export async function getSystemKeyWorkerBootstrapKey(capturedMetadata: EncryptionMetadata): Promise<string> {
  return withMetadataLock(async () => {
    await assertCredentialMigrationReady();
    const metadata = await readMetadata();
    if (!metadata || metadata.key_protection !== 'os-store'
        || metadataRevision(metadata) !== metadataRevision(capturedMetadata)) {
      throw new EncryptionLockedError('Worker snapshot encryption metadata changed');
    }
    return serializeKeyring(await systemKeyring(metadata), metadataRevision(metadata));
  });
}

/** The owner types a password to unlock (not a system key or an operator file). */
export async function isUserEncryptionEnabled(): Promise<boolean> {
  const metadata = await readMetadata();
  return metadata?.encryption_type === 'user' && (metadata.key_protection ?? 'passphrase') === 'passphrase';
}

/** Credentials can stay locked until a password, a recovery key or the system key opens them. */
export async function hasUnlockStep(): Promise<boolean> {
  const metadata = await readMetadata();
  return metadata?.encryption_type === 'user' && metadata.key_protection !== 'operator-file';
}

async function encryptionLockState(): Promise<boolean> {
  if (await isCredentialMigrationPending()) { invalidateOperatorKeyring(); return true; }
  let metadata = await readMetadata();
  if (!metadata && process.env.FLUJO_ENCRYPTION_SECRET_FILE !== undefined) {
    try { metadata = await withMetadataLock(metadataOrInitialize); } catch { return true; }
  }
  if (!metadata) {
    invalidateOperatorKeyring();
    // Without key metadata there is nothing to unlock. Only a worker that already
    // holds secrets it cannot read stays locked; see describeWorkerEncryptionLock.
    return isWorkerMode() && (await findStoredCiphertext()) !== null;
  }
  if (metadata.encryption_type !== 'user' && await tryMoveToSystemKey()) metadata = await readMetadata() ?? metadata;
  if (metadata.key_protection === 'os-store') {
    invalidateOperatorKeyring();
    if (serverRingFor(metadata)) return false;
    if (isWorkerMode()) return true;
    if (!(await getSystemSecret().catch(() => null))) return true;
    try {
      await withMetadataLock(async () => {
        const current = await readMetadata();
        if (current?.key_protection === 'os-store') await systemKeyring(current);
      });
      return false;
    } catch { return true; }
  }
  const cached = getServerDek();
  if (cached) {
    try {
      const ring = parseSessionKey(cached);
      if ('activeKey' in ring && ring.metadataRevision !== undefined
          && ring.metadataRevision !== metadataRevision(metadata)) { invalidateOperatorKeyring(); return true; }
    } catch { invalidateOperatorKeyring(); return true; }
  }
  if (metadata.key_protection === 'operator-file') {
    try {
      if (await transferredWorkerKeys(metadata)) return false;
      await verifiedOperatorKeyring(metadata, readMetadata);
      return false;
    } catch { invalidateOperatorKeyring(); return true; }
  }
  invalidateOperatorKeyring();
  return (await isUserEncryptionEnabled()) && isServerLocked();
}

export async function isEncryptionLocked(): Promise<boolean> {
  try { return await encryptionLockState(); }
  catch (error) { invalidateOperatorKeyring(); throw error; }
}

/** Plain words for a locked worker's status: what is missing and how to fix it. */
export async function describeWorkerEncryptionLock(): Promise<string> {
  const file = await readMetadata().then(metadata => metadata ? null : findStoredCiphertext()).catch(() => null);
  return file ? missingMetadataMessage(file)
    : 'Worker workspace encryption is locked. Unlock this workspace before running jobs.';
}

export async function getEncryptionType(): Promise<EncryptionType | null> {
  const metadata = await readMetadata();
  return metadata ? metadata.encryption_type ?? 'default' : null;
}

export async function getEncryptionStatus() {
  if (await isCredentialMigrationPending()) return { initialized: true, locked: true, protection: 'migration-pending' };
  const locked = await isEncryptionLocked();
  const metadata = await readMetadata();
  const protection = !metadata
    ? process.env.FLUJO_ENCRYPTION_SECRET_FILE !== undefined ? 'operator-file' : 'uninitialized'
    : metadata.key_protection ?? (metadata.encryption_type === 'user' ? 'passphrase' : 'legacy-default');
  const systemKey = await systemKeyStatusFor(protection, locked);
  return { initialized: metadata !== null, locked, protection, ...(systemKey ? { systemKey } : {}) };
}

/** What Settings and the unlock dialog say about the system key, in plain words; nothing where it plays no part. */
async function systemKeyStatusFor(protection: string, locked: boolean) {
  const status = await getSystemKeyStatus().catch(() => null);
  if (!status || (!status.available && !status.keptIn && protection !== 'os-store')) return null;
  const problem = protection === 'os-store' && locked
    ? await getSystemSecret().then(() => null, error => lockedBySystemKey(error).message) : null;
  return { ...status, problem, retryAt: problem ? systemKeyRetryAt() : null };
}
