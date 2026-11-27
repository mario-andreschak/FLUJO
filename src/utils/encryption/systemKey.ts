import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, hkdf, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { getDataDir } from '@/utils/paths';
import { createLogger } from '@/utils/logger';
import { open, seal } from './format';
import {
  detectSystemKeyStore, storeLabel, SystemKeyUnreadableError,
  type SystemKeyStore, type SystemKeyStoreKind,
} from './systemKeyStore';

const log = createLogger('utils/encryption/systemKey');
const hkdfAsync = promisify(hkdf);

/**
 * One system key per FLUJO data folder (#1443). It wraps the key that protects
 * saved credentials, like a password nobody has to type. The key itself lives
 * in the operating system's protected store; `<data>/keys/system-key.json`
 * only says where (and, on Windows, holds the copy that only this Windows user
 * can open).
 *
 * The same value is the owner's recovery key: typed into the unlock dialog it
 * opens the credentials when the system store cannot, and it is put back into
 * the store.
 *
 * Rules that keep access safe:
 * - A key is created only while no record exists, and the record is published
 *   only after the store handed the key back. Two processes elect one record.
 * - Once a record exists FLUJO never replaces its key with a new one: a lost
 *   key is a reason to ask for the recovery key, never to start over.
 * - A store that does not answer is tried again after a growing pause (2 s up
 *   to one minute), so nothing stays blocked until a restart.
 */

export const SYSTEM_KEY_DIRECTORY = 'keys';
const RECORD_FILE = 'system-key.json';
const RECORD_MAX_BYTES = 16 * 1024;
const SECRET = /^[A-Za-z0-9_-]{43,512}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const STORES: readonly SystemKeyStoreKind[] = ['windows', 'macos', 'linux'];
const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface SystemKeyRecord {
  version: 1;
  id: string;
  store: SystemKeyStoreKind;
  createdAt: number;
  /** Windows only: the key as protected by Windows for this user. */
  protectedCopy?: string;
  recoveryKeySavedAt?: number;
}

export type SystemKeyProblem = 'unavailable' | 'missing' | 'other-store';

export class SystemKeyError extends Error {
  constructor(readonly problem: SystemKeyProblem, readonly kind: SystemKeyStoreKind | null) {
    super(problemMessage(problem, kind));
    this.name = 'SystemKeyError';
  }
}

function problemMessage(problem: SystemKeyProblem, kind: SystemKeyStoreKind | null): string {
  const store = kind ? storeLabel(kind) : 'The system key store';
  if (problem === 'unavailable') {
    return `${store} did not hand over FLUJO's key just now. FLUJO keeps trying on its own. You can also unlock with your recovery key.`;
  }
  if (problem === 'other-store') {
    return `FLUJO's key is kept by ${store === 'Windows' ? store : store.replace(/^The /, 'the ')}, which is not available here. Unlock with your recovery key.`;
  }
  return `${store} no longer has FLUJO's key for this user account. This happens after a password reset, or when the FLUJO data folder comes from another computer. Unlock with your recovery key.`;
}

interface Failure { error: SystemKeyError; attempts: number; retryAt: number }
interface SystemKeyState {
  secrets: Map<string, string>;
  inflight: Map<string, Promise<string | null>>;
  failures: Map<string, Failure>;
}

declare global {
  var __flujo_system_key: SystemKeyState | undefined;
}

function state(): SystemKeyState {
  global.__flujo_system_key ??= { secrets: new Map(), inflight: new Map(), failures: new Map() };
  return global.__flujo_system_key;
}

function root(): string {
  return path.resolve(getDataDir());
}

export function systemKeyRecordPath(dataDir = root()): string {
  return path.join(dataDir, SYSTEM_KEY_DIRECTORY, RECORD_FILE);
}

function parseRecord(value: unknown): SystemKeyRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<SystemKeyRecord>;
  if (record.version !== 1 || typeof record.id !== 'string' || !ID.test(record.id)
      || !STORES.includes(record.store as SystemKeyStoreKind) || !Number.isSafeInteger(record.createdAt)
      || (record.protectedCopy !== undefined && (typeof record.protectedCopy !== 'string' || !/^[A-Za-z0-9+/=]{16,8192}$/.test(record.protectedCopy)))
      || (record.recoveryKeySavedAt !== undefined && !Number.isSafeInteger(record.recoveryKeySavedAt))) return null;
  return {
    version: 1, id: record.id, store: record.store as SystemKeyStoreKind, createdAt: record.createdAt as number,
    ...(record.protectedCopy ? { protectedCopy: record.protectedCopy } : {}),
    ...(record.recoveryKeySavedAt ? { recoveryKeySavedAt: record.recoveryKeySavedAt } : {}),
  };
}

type RecordRead = { kind: 'none' } | { kind: 'damaged' } | { kind: 'ok'; record: SystemKeyRecord };

async function readRecord(dataDir: string): Promise<RecordRead> {
  let text: string;
  try {
    const file = systemKeyRecordPath(dataDir);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return { kind: 'damaged' };
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    throw error;
  }
  try {
    const record = parseRecord(JSON.parse(text));
    return record ? { kind: 'ok', record } : { kind: 'damaged' };
  } catch {
    return { kind: 'damaged' };
  }
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows briefly locks a file that a virus scanner or indexer just opened. */
async function withFileRetry<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await task(); }
    catch (error) {
      if (attempt >= 5 || !RETRYABLE.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

/**
 * Writes the record completely beside its final name first. `create` publishes
 * it only if no record exists yet (an atomic hard link elects one writer) and
 * returns whichever record won; otherwise the record is replaced atomically.
 */
async function writeRecord(dataDir: string, record: SystemKeyRecord, create: boolean): Promise<SystemKeyRecord> {
  const final = systemKeyRecordPath(dataDir);
  await fs.mkdir(path.dirname(final), { recursive: true, mode: 0o700 });
  const staged = `${final}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(staged, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    if (!create) {
      await withFileRetry(() => fs.rename(staged, final));
      return record;
    }
    try { await fs.link(staged, final); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const winner = await readRecord(dataDir);
    if (winner.kind !== 'ok') throw new Error('The system key record could not be read back');
    return winner.record;
  } finally {
    await fs.unlink(staged).catch(() => undefined);
  }
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

async function loadFromStore(record: SystemKeyRecord, store: SystemKeyStore | null): Promise<string> {
  const platformStore: SystemKeyStoreKind | null = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
  if (!store) throw new SystemKeyError(record.store === platformStore ? 'unavailable' : 'other-store', record.store);
  if (store.kind !== record.store) throw new SystemKeyError('other-store', record.store);
  let secret: string | null;
  try { secret = await store.load(record.id, record.protectedCopy); }
  catch (error) {
    throw new SystemKeyError(error instanceof SystemKeyUnreadableError ? 'missing' : 'unavailable', record.store);
  }
  if (!secret || !SECRET.test(secret)) throw new SystemKeyError('missing', record.store);
  return secret;
}

async function createInStore(dataDir: string, store: SystemKeyStore): Promise<string> {
  const id = randomUUID();
  const secret = newSecret();
  const protectedCopy = await store.save(id, secret);
  if (await store.load(id, protectedCopy) !== secret) throw new SystemKeyError('unavailable', store.kind);
  const winner = await writeRecord(dataDir, {
    version: 1, id, store: store.kind, createdAt: Date.now(), ...(protectedCopy ? { protectedCopy } : {}),
  }, true);
  if (winner.id === id) {
    log.info(`Created FLUJO's system key in ${storeLabel(store.kind)}`);
    return secret;
  }
  return loadFromStore(winner, store);
}

async function loadOrCreate(dataDir: string, create: boolean): Promise<string | null> {
  const read = await readRecord(dataDir);
  const store = await detectSystemKeyStore();
  if (read.kind === 'ok') return loadFromStore(read.record, store);
  // A damaged record still means a key existed: never start over on top of it.
  if (read.kind === 'damaged') throw new SystemKeyError('missing', store?.kind ?? null);
  if (!create || !store) return null;
  try { return await createInStore(dataDir, store); }
  catch (error) {
    if (error instanceof SystemKeyError) throw error;
    throw new SystemKeyError('unavailable', store.kind);
  }
}

function remember(dataDir: string, error: SystemKeyError): void {
  const failures = state().failures;
  const attempts = (failures.get(dataDir)?.attempts ?? 0) + 1;
  const pause = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (attempts - 1));
  failures.set(dataDir, { error, attempts, retryAt: Date.now() + pause });
}

/**
 * The system key of this data folder. `null` means none was set up yet (or,
 * with `create`, that this computer offers no system store). Throws a
 * `SystemKeyError` with a plain explanation when a set-up key cannot be read.
 */
export async function getSystemSecret(options: { create?: boolean } = {}): Promise<string | null> {
  const dataDir = root();
  const current = state();
  const cached = current.secrets.get(dataDir);
  if (cached) return cached;
  const failure = current.failures.get(dataDir);
  if (failure && Date.now() < failure.retryAt) throw failure.error;
  const flight = `${dataDir}\0${options.create === true}`;
  let attempt = current.inflight.get(flight);
  if (!attempt) {
    attempt = loadOrCreate(dataDir, options.create === true);
    current.inflight.set(flight, attempt);
    attempt.then(() => undefined, () => undefined).finally(() => {
      if (current.inflight.get(flight) === attempt) current.inflight.delete(flight);
    });
  }
  try {
    const secret = await attempt;
    if (secret) { current.secrets.set(dataDir, secret); current.failures.delete(dataDir); }
    return secret;
  } catch (error) {
    const reported = error instanceof SystemKeyError ? error : new SystemKeyError('unavailable', null);
    if (!current.failures.has(dataDir) || Date.now() >= (current.failures.get(dataDir)?.retryAt ?? 0)) remember(dataDir, reported);
    throw reported;
  }
}

/** When FLUJO will look in the system store again after a failure, or `null`. */
export function systemKeyRetryAt(): number | null {
  return state().failures.get(root())?.retryAt ?? null;
}

/** Spaces and line breaks that come with a copied or printed recovery key do not count. */
export function normalizeRecoveryKey(input: string): string {
  return input.replace(/\s+/g, '');
}

export type AdoptResult = 'kept' | 'restored' | 'memory-only' | 'different';

/**
 * Called after a recovery key opened a workspace. Puts the key back into the
 * system store when the store lost it, so the next start needs no recovery key.
 * A store that holds a different working key keeps it (`different`): that key
 * still opens the other workspaces of this data folder.
 */
export async function adoptSystemSecret(secret: string): Promise<AdoptResult> {
  if (!SECRET.test(secret)) throw new Error('Invalid recovery key');
  const dataDir = root();
  const current = state();
  const cached = current.secrets.get(dataDir);
  if (cached) return cached === secret ? 'kept' : 'different';
  current.failures.delete(dataDir);
  let problem: SystemKeyProblem | null = null;
  try {
    const stored = await getSystemSecret();
    if (stored) return stored === secret ? 'kept' : 'different';
  } catch (error) {
    problem = error instanceof SystemKeyError ? error.problem : 'unavailable';
  }
  const keepInMemory = (): AdoptResult => {
    current.secrets.set(dataDir, secret);
    current.failures.delete(dataDir);
    return 'memory-only';
  };
  // An unreachable store may still hold another working key: do not overwrite it.
  if (problem === 'unavailable') return keepInMemory();
  const store = await detectSystemKeyStore();
  if (!store) return keepInMemory();
  try {
    const read = await readRecord(dataDir);
    const id = read.kind === 'ok' && read.record.store === store.kind ? read.record.id : randomUUID();
    const protectedCopy = await store.save(id, secret);
    if (await store.load(id, protectedCopy) !== secret) return keepInMemory();
    await writeRecord(dataDir, {
      version: 1, id, store: store.kind, createdAt: read.kind === 'ok' ? read.record.createdAt : Date.now(),
      ...(protectedCopy ? { protectedCopy } : {}), recoveryKeySavedAt: Date.now(),
    }, false);
    current.secrets.set(dataDir, secret);
    current.failures.delete(dataDir);
    log.info(`Put FLUJO's system key back into ${storeLabel(store.kind)}`);
    return 'restored';
  } catch {
    log.warn('Could not put the recovery key back into the system store; it works until FLUJO restarts');
    return keepInMemory();
  }
}

export interface SystemKeyStatus {
  /** The store this computer offers, or `null`. */
  available: SystemKeyStoreKind | null;
  /** Where this data folder's key is kept, or `null` when none was set up. */
  keptIn: SystemKeyStoreKind | null;
  recoveryKeySaved: boolean;
}

export async function getSystemKeyStatus(): Promise<SystemKeyStatus> {
  const [store, read] = await Promise.all([detectSystemKeyStore(), readRecord(root()).catch(() => ({ kind: 'damaged' as const }))]);
  return {
    available: store?.kind ?? null,
    keptIn: read.kind === 'ok' ? read.record.store : null,
    recoveryKeySaved: read.kind === 'ok' && read.record.recoveryKeySavedAt !== undefined,
  };
}

const BACKUP_DIRECTORY = 'before-system-key';
const BACKUP_PURPOSE = 'flujo:key-file-backup:v1';

async function backupKey(secret: string): Promise<string> {
  return Buffer.from(await hkdfAsync('sha256', secret, 'flujo-system-key', BACKUP_PURPOSE, 32)).toString('hex');
}

/**
 * Keeps the workspace key file exactly as it was before the move to the system
 * key, sealed with the system key so the copy does not undo the protection.
 * Written before the move and never replaced: the name is the content's hash.
 */
export async function backupKeyFileBeforeMove(workspace: string, keyFile: Buffer, secret: string): Promise<string> {
  const digest = createHash('sha256').update(keyFile).digest('hex').slice(0, 16);
  const directory = path.join(root(), SYSTEM_KEY_DIRECTORY, BACKUP_DIRECTORY);
  const file = path.join(directory, `${encodeURIComponent(workspace)}-${digest}.json`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    version: 1, workspace, createdAt: Date.now(), file: 'db/encryption_key.json',
    sealed: seal(keyFile.toString('base64'), await backupKey(secret), `${BACKUP_PURPOSE}:${workspace}`),
  }, null, 2);
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return file;
}

/** Opens a backup written by `backupKeyFileBeforeMove`: the key file bytes as they were. */
export async function openKeyFileBackup(file: string, secret: string): Promise<Buffer> {
  const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { version?: unknown; workspace?: unknown; sealed?: unknown };
  if (parsed.version !== 1 || typeof parsed.workspace !== 'string' || typeof parsed.sealed !== 'string') {
    throw new Error('Not a FLUJO key file backup');
  }
  return Buffer.from(open(parsed.sealed, await backupKey(secret), `${BACKUP_PURPOSE}:${parsed.workspace}`), 'base64');
}

/** The owner confirmed they keep the recovery key somewhere safe. */
export async function markRecoveryKeySaved(): Promise<boolean> {
  const dataDir = root();
  const read = await readRecord(dataDir);
  if (read.kind !== 'ok') return false;
  await writeRecord(dataDir, { ...read.record, recoveryKeySavedAt: Date.now() }, false);
  return true;
}
