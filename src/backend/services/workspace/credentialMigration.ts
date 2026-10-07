import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, pbkdf2, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { StorageKey } from '@/shared/types/storage';
import { getCurrentWorkspace, getWorkspaceDataDir } from '@/utils/workspace';
import { getDataDir } from '@/utils/paths';
import { readPlainFile } from '@/utils/readPlainFile';
import { CREDENTIAL_STORE_NAMES, credentialMigrationPath, isCredentialMigrationPending } from '@/utils/encryption/credentialMigrationState';
import { DEFAULT_PASSWORD, KDF_ITERATIONS, decryptLegacy, newKeyring, open, seal, unwrapKeyring, unwrapLegacyKey, wrapKeyring, type EncryptionMetadata, type Keyring } from '@/utils/encryption/format';
import { MAX_TRANSFER_BYTES, openRecipientTransfer, sealRecipientTransfer } from '@/utils/encryption/recipientTransfer';
import { encodeOAuthValue, OAUTH_CREDENTIAL_FORMAT, readSourceOAuthValue } from '@/utils/encryption/oauthCredentialEnvelope';
import { readOperatorSecret } from '@/utils/encryption/operatorSecret';
import { lockServer } from '@/utils/encryption/session';
import { CREDENTIAL_TRANSFER_STORES, transformCredentialValues, validateCredentialRecord } from './credentialTransfer';
import { assertLinkFreeFileParent, atomicWriteWithoutLinks } from './backupRestoreFs';
import { withWorkspaceRecoveryCapture } from './workspaceMutationGate';
import { isWorkerMode } from './workerMode';

const PURPOSE = 'flujo:secret:v2';
const MAX_RECORD_BYTES = 5 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const derivePlanKey = promisify(pbkdf2);
type Protection = 'passphrase' | 'operator-file';
type Entry = { before: string; after: string; beforeHash: string; afterHash: string };
type Journal = { version: 1; workspace: string; id: string; createdAt: number; protection: Protection; entries: Record<string, Entry> };
export type CredentialMigrationCode = 'SOURCE_INVALID' | 'SOURCE_CHANGED' | 'RECOVERY_INVALID' | 'MIGRATION_PENDING' | 'PROFILE_UNAVAILABLE' | 'LIMIT_EXCEEDED';
export class CredentialMigrationError extends Error {
  constructor(readonly code: CredentialMigrationCode, readonly store?: string) {
    super(code === 'MIGRATION_PENDING' ? 'Resume or roll back the pending migration with its recovery passphrase.'
      : code === 'SOURCE_CHANGED' ? 'Credential files changed. Restore matching files from backup before resuming or rolling back.'
        : code === 'SOURCE_INVALID' ? 'Preflight failed. Restore matching metadata or repair the indicated store from a trusted backup; no source files were changed.'
          : code === 'LIMIT_EXCEEDED' ? 'Credential backup exceeds the bounded migration limit. Preserve source files and reduce store size through a trusted export before retrying.'
            : code === 'PROFILE_UNAVAILABLE' ? 'Provide a private recovery passphrase and the independent operator mount when that profile is selected.'
            : 'Recovery journal or passphrase is invalid. Preserve the journal and restore a matching trusted backup.');
    this.name = 'CredentialMigrationError';
  }
}
export interface CredentialMigrationOptions {
  sourcePassphrase?: string;
  recoveryPassphrase: string;
  protection?: Protection;
  /** Explicit retirement for keys that may have been publicly wrapped historically. */
  retireActiveKey?: boolean;
  signal?: AbortSignal;
  /** Fault injection only; never sourced from an HTTP request. */
  checkpoint?: (step: 'journal_written' | 'record_written' | 'before_commit', store?: string) => Promise<void>;
}
export interface CredentialMigrationInventory {
  planToken: string;
  stores: Array<{ store: string; credentials: number; plaintext: number; v1: number; v2: number; failedPlaintext: number }>;
  protection: Protection;
  retireActiveKey: boolean;
  activeKeyWillChange: boolean;
}
function fileFor(store: string) { return path.join(getWorkspaceDataDir(), 'db', `${store}.json`); }
async function readFile(file: string, maxBytes = MAX_RECORD_BYTES): Promise<Buffer> {
  return readPlainFile(file, { maxBytes, verifyPath: () => assertLinkFreeFileParent(getDataDir(), file) });
}
function validateOptions(options: CredentialMigrationOptions) {
  const value = options.recoveryPassphrase;
  if (typeof value !== 'string' || value.length < 16 || Buffer.byteLength(value) > 1024 || value === DEFAULT_PASSWORD
      || !['passphrase', 'operator-file'].includes(options.protection ?? 'passphrase')
      || (options.retireActiveKey !== undefined && typeof options.retireActiveKey !== 'boolean') || isWorkerMode()) throw new CredentialMigrationError('PROFILE_UNAVAILABLE');
}
async function prepare(options: CredentialMigrationOptions, planSalt = randomBytes(16)): Promise<{ journal: Journal; inventory: CredentialMigrationInventory }> {
  validateOptions(options);
  if (await isCredentialMigrationPending()) throw new CredentialMigrationError('MIGRATION_PENDING');
  const before = new Map<string, Buffer>();
  const after = new Map<string, Buffer>();
  try {
    let metadataBytes: Buffer;
    try { metadataBytes = await readFile(fileFor(StorageKey.ENCRYPTION_KEY)); }
    catch { throw new CredentialMigrationError('SOURCE_INVALID', StorageKey.ENCRYPTION_KEY); }
    before.set(StorageKey.ENCRYPTION_KEY, metadataBytes);
    let metadata: EncryptionMetadata;
    let ring: Keyring;
    let publiclyWrapped = false;
    try {
      metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes));
      if (!metadata || ![1, 2].includes(metadata.encryption_version)
          || (metadata.encryption_type !== undefined && !['default', 'user'].includes(metadata.encryption_type))) throw new Error();
      const sourcePassword = metadata.key_protection === 'operator-file' ? readOperatorSecret()
        : metadata.encryption_type === 'user' ? options.sourcePassphrase : DEFAULT_PASSWORD;
      if (!sourcePassword) throw new Error();
      publiclyWrapped = sourcePassword === DEFAULT_PASSWORD;
      ring = metadata.encryption_version === 2 ? await unwrapKeyring(metadata, sourcePassword)
        : newKeyring(await unwrapLegacyKey(metadata, sourcePassword));
    } catch { throw new CredentialMigrationError('SOURCE_INVALID', StorageKey.ENCRYPTION_KEY); }
    const protection = options.protection ?? 'passphrase';
    const targetPassword = protection === 'operator-file' ? readOperatorSecret() : options.recoveryPassphrase;
    if (!targetPassword) throw new CredentialMigrationError('PROFILE_UNAVAILABLE');
    // A copied public-default wrapper already exposes its active DEK. Rewrapping
    // that key cannot protect future ciphertext; retire it for all live writes.
    // Retain the v1 read key only for the declared legacy compatibility contract.
    const activeKeyWillChange = publiclyWrapped || options.retireActiveKey === true;
    const targetRing = activeKeyWillChange ? newKeyring(ring.legacyKey) : ring;
    const targetMetadata = await wrapKeyring(targetRing, 'user', targetPassword, protection);
    after.set(StorageKey.ENCRYPTION_KEY, Buffer.from(JSON.stringify(targetMetadata)));
    const stores: CredentialMigrationInventory['stores'] = [];
    for (const store of CREDENTIAL_TRANSFER_STORES) {
      options.signal?.throwIfAborted();
      let bytes: Buffer;
      try { bytes = await readFile(fileFor(store)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new CredentialMigrationError('SOURCE_INVALID', store);
      }
      before.set(store, bytes);
      const count = { store, credentials: 0, plaintext: 0, v1: 0, v2: 0, failedPlaintext: 0 };
      try {
        const value = validateCredentialRecord(store, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        const convert = async (text: string, credential: boolean): Promise<string> => {
          const ciphertext = text.startsWith('encrypted:') ? text.slice('encrypted:'.length)
            : text.startsWith('v2:') || /^[a-f0-9]{32}:[A-Za-z0-9+/]+={0,2}$/.test(text) ? text : undefined;
          if (!text || /^\$\{global:[^}]+\}$/.test(text) || (!credential && ciphertext === undefined && !text.startsWith('encrypted_failed:'))) return text;
          let plaintext: string;
          if (text.startsWith('encrypted_failed:')) { plaintext = text.slice('encrypted_failed:'.length); count.failedPlaintext++; }
          else if (ciphertext !== undefined) {
            if (ciphertext.startsWith('v2:')) { plaintext = open(ciphertext, ring.activeKey, PURPOSE); count.v2++; }
            else { if (!ring.legacyKey) throw new Error(); plaintext = decryptLegacy(ciphertext, ring.legacyKey); count.v1++; }
          } else { plaintext = text; count.plaintext++; }
          const encrypted = seal(plaintext, targetRing.activeKey, PURPOSE);
          if (open(encrypted, targetRing.activeKey, PURPOSE) !== plaintext) throw new Error();
          count.credentials++;
          return `encrypted:${encrypted}`;
        };
        const migrated = store === StorageKey.GLOBAL_ENV_VARS
          ? Object.fromEntries(await Promise.all(Object.entries(value as Record<string, unknown>).map(async ([name, item]) => {
            const converted = await transformCredentialValues(item, convert, true, 0, true);
            if (typeof converted === 'string') return [name, { value: converted, metadata: { isSecret: true } }];
            if (!converted || typeof converted !== 'object' || typeof (converted as Record<string, unknown>).value !== 'string') throw new Error();
            return [name, { ...(converted as Record<string, unknown>), metadata: { isSecret: true } }];
          }))) : await transformCredentialValues(value, convert, false, 0, true, store === StorageKey.MCP_SERVERS ? async (kind, stored) => {
          const sdk = await readSourceOAuthValue(kind, stored, getCurrentWorkspace(), async ciphertext => {
            if (ciphertext.startsWith('v2:')) return open(ciphertext, ring.activeKey, PURPOSE);
            if (!ring.legacyKey) throw new Error(); return decryptLegacy(ciphertext, ring.legacyKey);
          });
          const serialized = encodeOAuthValue(kind, sdk, getCurrentWorkspace());
          const ciphertext = seal(serialized, targetRing.activeKey, PURPOSE);
          if (open(ciphertext, targetRing.activeKey, PURPOSE) !== serialized) throw new Error();
          count.credentials++;
          return { format: OAUTH_CREDENTIAL_FORMAT, ciphertext };
        } : undefined);
        after.set(store, Buffer.from(JSON.stringify(migrated)));
        stores.push(count);
      } catch { throw new CredentialMigrationError('SOURCE_INVALID', store); }
    }
    const entries = Object.fromEntries([...before].map(([store, bytes]) => [store, {
      before: bytes.toString('base64'), after: after.get(store)!.toString('base64'), beforeHash: hash(bytes), afterHash: hash(after.get(store)!),
    }]));
    // The browser receives a salted, recovery-authenticated plan, never a bare
    // deterministic fingerprint of potentially plaintext legacy credentials.
    const planKey = await derivePlanKey(options.recoveryPassphrase, planSalt, KDF_ITERATIONS, 32, 'sha256');
    let planToken: string;
    try {
      const mac = createHmac('sha256', planKey).update(JSON.stringify([
        'flujo:credential-migration:plan:v2', getCurrentWorkspace(), path.resolve(getWorkspaceDataDir()), protection, options.retireActiveKey === true,
        Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([store, entry]) => [store, entry.beforeHash]),
      ])).digest();
      planToken = planSalt.toString('hex') + mac.subarray(0, 16).toString('hex');
    } finally { planKey.fill(0); }
    const journal: Journal = { version: 1, workspace: getCurrentWorkspace(), id: randomUUID(), createdAt: Date.now(), protection, entries };
    if (Buffer.byteLength(JSON.stringify(journal)) > MAX_TRANSFER_BYTES) throw new CredentialMigrationError('LIMIT_EXCEEDED');
    return { journal, inventory: { planToken, stores, protection, retireActiveKey: options.retireActiveKey === true, activeKeyWillChange } };
  } finally { planSalt.fill(0); for (const bytes of [...before.values(), ...after.values()]) bytes.fill(0); }
}
export async function preflightCredentialMigration(options: CredentialMigrationOptions): Promise<CredentialMigrationInventory> {
  return withWorkspaceRecoveryCapture(async () => (await prepare(options)).inventory, { signal: options.signal });
}
async function syncParent() {
  if (process.platform === 'win32') return;
  const directory = path.dirname(credentialMigrationPath());
  await assertLinkFreeFileParent(getDataDir(), path.join(directory, 'probe'));
  const before = await fs.lstat(directory, { bigint: true });
  const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await parent.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.mode !== before.mode || opened.uid !== before.uid || opened.gid !== before.gid) throw new CredentialMigrationError('SOURCE_CHANGED');
    await assertLinkFreeFileParent(getDataDir(), path.join(directory, 'probe'));
    const current = await fs.lstat(directory, { bigint: true });
    if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new CredentialMigrationError('SOURCE_CHANGED');
    await parent.sync();
  } finally { await parent.close(); }
}
async function validateCurrent(journal: Journal, exactSide?: 'before' | 'after') {
  for (const [store, entry] of Object.entries(journal.entries)) {
    let bytes: Buffer;
    try { bytes = await readFile(fileFor(store), MAX_TRANSFER_BYTES); }
    catch { throw new CredentialMigrationError('SOURCE_CHANGED', store); }
    try { const digest = hash(bytes); if (exactSide ? digest !== entry[`${exactSide}Hash`] : digest !== entry.beforeHash && digest !== entry.afterHash) throw new CredentialMigrationError('SOURCE_CHANGED', store); }
    finally { bytes.fill(0); }
  }
}
async function readJournal(passphrase: string): Promise<Journal> {
  let bytes: Buffer | undefined;
  let plaintext: Buffer | undefined;
  try {
    bytes = await readFile(credentialMigrationPath(), MAX_TRANSFER_BYTES + 56);
    plaintext = await openRecipientTransfer(bytes, passphrase);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as Journal;
    if (!value || value.version !== 1 || value.workspace !== getCurrentWorkspace() || !/^[a-f0-9-]{36}$/.test(value.id)
        || !Number.isSafeInteger(value.createdAt) || !['passphrase', 'operator-file'].includes(value.protection)
        || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)
        || !Object.hasOwn(value.entries, StorageKey.ENCRYPTION_KEY)
        || Object.keys(value.entries).some(store => !(CREDENTIAL_STORE_NAMES as readonly string[]).includes(store))) throw new Error();
    for (const entry of Object.values(value.entries)) {
      if (!entry || typeof entry.before !== 'string' || typeof entry.after !== 'string'
          || !/^[a-f0-9]{64}$/.test(entry.beforeHash) || !/^[a-f0-9]{64}$/.test(entry.afterHash)) throw new Error();
      for (const side of ['before', 'after'] as const) {
        const decoded = Buffer.from(entry[side], 'base64');
        try { if (decoded.toString('base64') !== entry[side] || hash(decoded) !== entry[`${side}Hash`]) throw new Error(); }
        finally { decoded.fill(0); }
      }
    }
    return value;
  } catch { throw new CredentialMigrationError('RECOVERY_INVALID'); }
  finally { bytes?.fill(0); plaintext?.fill(0); }
}
async function applyJournal(journal: Journal, rollback: boolean, options: CredentialMigrationOptions) {
  await validateCurrent(journal); // Check the entire inventory before replacing any file.
  if (!rollback) {
    const target = Buffer.from(journal.entries[StorageKey.ENCRYPTION_KEY].after, 'base64');
    try {
      const password = journal.protection === 'operator-file' ? readOperatorSecret() : options.recoveryPassphrase;
      if (!password) throw new Error();
      await unwrapKeyring(JSON.parse(target.toString('utf8')), password);
    } catch { throw new CredentialMigrationError('PROFILE_UNAVAILABLE'); }
    finally { target.fill(0); }
  }
  const side = rollback ? 'before' : 'after';
  const stores = Object.keys(journal.entries).filter(store => store !== StorageKey.ENCRYPTION_KEY);
  stores.push(StorageKey.ENCRYPTION_KEY); // Metadata changes only after all record replacements.
  for (const store of stores) {
    options.signal?.throwIfAborted();
    const bytes = Buffer.from(journal.entries[store][side], 'base64');
    try {
      await atomicWriteWithoutLinks(getDataDir(), fileFor(store), bytes, { mode: 0o600 });
      const actual = await readFile(fileFor(store), MAX_TRANSFER_BYTES);
      try { if (!actual.equals(bytes)) throw new CredentialMigrationError('SOURCE_CHANGED', store); }
      finally { actual.fill(0); }
    } finally { bytes.fill(0); }
    await options.checkpoint?.('record_written', store);
  }
  await options.checkpoint?.('before_commit');
  options.signal?.throwIfAborted();
  await validateCurrent(journal, side);
  if (JSON.stringify(await readJournal(options.recoveryPassphrase)) !== JSON.stringify(journal)) throw new CredentialMigrationError('RECOVERY_INVALID');
  const pending = credentialMigrationPath();
  await assertLinkFreeFileParent(getDataDir(), pending);
  // This single rename publishes the logical transaction; pending readers and
  // writers remain denied until every record and metadata byte is verified.
  await fs.rename(pending, path.join(path.dirname(pending), `.credential-migration.${journal.id}.${rollback ? 'rolled-back' : 'committed'}`));
  await syncParent();
  lockServer();
  const prior = JSON.parse(Buffer.from(journal.entries[StorageKey.ENCRYPTION_KEY].before, 'base64').toString('utf8')) as EncryptionMetadata;
  return { status: rollback ? 'rolled-back' : 'committed', protection: rollback
    ? prior.key_protection ?? (prior.encryption_type === 'user' ? 'passphrase' : 'legacy-default') : journal.protection, stores: stores.length } as const;
}
export async function migrateCredentials(options: CredentialMigrationOptions, expectedPlanToken: string) {
  return withWorkspaceRecoveryCapture(async () => {
    if (typeof expectedPlanToken !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPlanToken)) throw new CredentialMigrationError('SOURCE_CHANGED');
    const { journal, inventory } = await prepare(options, Buffer.from(expectedPlanToken.slice(0, 32), 'hex'));
    if (!timingSafeEqual(Buffer.from(inventory.planToken, 'hex'), Buffer.from(expectedPlanToken, 'hex'))) throw new CredentialMigrationError('SOURCE_CHANGED');
    const plaintext = Buffer.from(JSON.stringify(journal));
    let envelope: Buffer;
    try { envelope = await sealRecipientTransfer(plaintext, options.recoveryPassphrase); }
    finally { plaintext.fill(0); }
    const pending = credentialMigrationPath();
    try {
      // Coherent capture serializes registered writers across OS processes.
      if (await isCredentialMigrationPending()) throw new CredentialMigrationError('MIGRATION_PENDING');
      await atomicWriteWithoutLinks(getDataDir(), pending, envelope, { mode: 0o600 });
      await syncParent();
      const written = await readJournal(options.recoveryPassphrase);
      if (written.id !== journal.id) throw new CredentialMigrationError('RECOVERY_INVALID');
    } finally { envelope.fill(0); }
    lockServer();
    await options.checkpoint?.('journal_written');
    return applyJournal(journal, false, options);
  }, { signal: options.signal });
}
export async function recoverCredentialMigration(options: CredentialMigrationOptions, rollback = false) {
  validateOptions(options);
  return withWorkspaceRecoveryCapture(async () => applyJournal(await readJournal(options.recoveryPassphrase), rollback, options), { signal: options.signal });
}
