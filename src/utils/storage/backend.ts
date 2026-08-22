import { promises as fs } from 'fs';
import path from 'path';
import { StorageKey } from '../../shared/types/storage';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('utils/storage/backend');

// Current storage directory. Resolved from the data dir (see utils/paths) so a
// packaged install (npm/Docker) can keep db/ outside the read-only app install;
// defaults to the app dir, so a git checkout is unchanged (<repo>/db).
//
// Workspaces (#406): db/ now lives inside the SELECTED workspace, i.e.
// <data root>/workspaces/<workspace>/db. These are deliberately functions, not
// module-level constants: the workspace is per-request ambient context, so a
// constant captured at import time would pin the whole process to whichever
// workspace happened to be resolved first.
const storageDir = () => path.join(getWorkspaceDataDir(), 'db');
// Old storage directory (for checking). Pre-dates both the data dir and
// workspaces, so it stays at the installation root.
const oldStorageDir = () => path.join(getDataDir(), '.next', 'storage');
const getFilePath = (key: StorageKey) => path.join(storageDir(), `${key}.json`);

// Ensure storage directory exists
async function ensureStorageDir() {
  const STORAGE_DIR = storageDir();
  const OLD_STORAGE_DIR = oldStorageDir();
  try {
    await fs.access(STORAGE_DIR);
    log.verbose(`Storage directory exists: ${STORAGE_DIR}`); // Changed to verbose
  } catch {
    log.debug(`Creating storage directory: ${STORAGE_DIR}`); // Changed to debug
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
  
  // Check if old storage directory exists and log a warning
  try {
    await fs.access(OLD_STORAGE_DIR);
    log.warn(`Old storage directory found: ${OLD_STORAGE_DIR}. This may cause data inconsistency issues.`); // Changed to warn
  } catch {
    // Old directory doesn't exist, which is good
  }
}

/**
 * Verify storage system initialization and integrity
 * This should be called during application startup
 */
export async function verifyStorage(): Promise<void> {
  log.debug('Verifying storage system initialization'); // Changed to debug
  
  // Ensure storage directory exists
  await ensureStorageDir();
  
  // Check each storage key
  for (const key of Object.values(StorageKey)) {
    try {
      const filePath = getFilePath(key);
      let exists = false;
      
      try {
        await fs.access(filePath);
        exists = true;
      } catch {
        // File doesn't exist yet, which is normal for new installations
      }
      
      log.debug(`Storage check: ${key} - ${exists ? 'File exists' : 'File does not exist yet'}`); // Changed to debug
      
      // Check if the file exists in the old location but not in the new location
      const oldFilePath = path.join(oldStorageDir(), `${key}.json`);
      try {
        await fs.access(oldFilePath);
        if (!exists) {
          log.warn(`Found ${key} in old storage location but not in new location. This may cause data loss.`);
        } else {
          log.warn(`Found ${key} in both old and new storage locations. This may cause data inconsistency.`);
        }
      } catch {
        // File doesn't exist in old location, which is expected
      }
    } catch (error) {
      log.error(`Storage verification failed for ${key}:`, error);
    }
  }
  
  log.debug('Storage verification completed'); // Changed to debug
}

// --- Crash/race-safe writes ------------------------------------------------
// A plain fs.writeFile truncates the target before writing, so a crash or two
// concurrent writes can leave a half-written or empty file on disk — which the
// reader then chokes on ("Unexpected end of JSON input"). To avoid that we:
//   1. Write to a unique temp file in the same directory, then rename it onto
//      the target. rename() is atomic within a filesystem, so a reader always
//      sees either the previous complete file or the new complete one.
//   2. Serialize writes per key with an in-process promise chain, so two
//      concurrent saveItem calls for the same key can't interleave their
//      temp-file/rename steps (last write wins cleanly).

// Per-key write chains so same-key writes run one at a time. Different keys
// still write concurrently.
const writeChains = new Map<string, Promise<unknown>>();
// Monotonic counter to keep temp file names unique within this process.
let tmpCounter = 0;

// Windows has no share-mode equivalent of POSIX's "rename over an open file is
// fine": libuv opens files WITHOUT FILE_SHARE_DELETE, so while any reader in
// any process holds the target open — including our own concurrent
// loadItem/loadCollectionItem calls — MoveFileEx refuses to replace it and
// rename fails with EPERM. Measured on a plain fs.readFile poller against this
// exact write path, ~85% of renames fail on the first try; the conflict clears
// as soon as the reader's handle closes, which is typically single-digit
// milliseconds. So the rename is retried rather than treated as fatal.
//
// The schedule is front-loaded (first retry after ~5ms, not 25ms) because most
// conflicts are one read away from clearing, then backs off exponentially so a
// genuinely busy file does not spin. Jitter keeps two writers racing for the
// same target from re-colliding in lockstep on every attempt.
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_RENAME_ATTEMPTS = 15;
const MAX_RENAME_BACKOFF_MS = 100;

async function renameWithRetry(tmpPath: string, filePath: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (attempt >= MAX_RENAME_ATTEMPTS || !code || !RETRYABLE_RENAME_CODES.has(code)) {
        throw renameError;
      }
      const backoff = Math.min(MAX_RENAME_BACKOFF_MS, 5 * 2 ** (attempt - 1));
      await new Promise(resolve => setTimeout(resolve, backoff + Math.random() * 10));
    }
  }
}

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  // Temp file lives next to the target (same filesystem) so rename is atomic.
  const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpCounter}`;
  try {
    await fs.writeFile(tmpPath, data);
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    // Best-effort cleanup so a failed write doesn't leave temp files behind.
    try { await fs.unlink(tmpPath); } catch { /* temp file may not exist */ }
    throw error;
  }
}

export async function saveItem<T>(key: StorageKey, value: T): Promise<void> {
  const filePath = getFilePath(key);
  // Serialize against any in-flight write for the same key. We chain off the
  // previous write (ignoring its outcome) so a failure doesn't wedge the key.
  // The chain is keyed per workspace (#406): the same StorageKey in two
  // workspaces is two different files and must not serialize against — or, far
  // worse, be deduplicated with — each other.
  const chainKey = workspaceCacheKey('item', key);
  const previous = writeChains.get(chainKey) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior write's error is surfaced to its own caller */ })
    .then(() => writeFileAtomic(filePath, JSON.stringify(value, null, 2)));
  writeChains.set(chainKey, run);

  try {
    await run;
    log.verbose(`Successfully saved item to: ${filePath}`); // Changed to verbose
  } catch (error) {
    log.error(`Error saving item with key "${key}" to ${filePath}:`, error);
    throw error; // Re-throw the error after logging
  } finally {
    // Drop the chain entry once it's the tail, so the map doesn't grow forever.
    if (writeChains.get(chainKey) === run) {
      writeChains.delete(chainKey);
    }
  }
}

export async function loadItem<T>(key: StorageKey, defaultValue: T): Promise<T> {
  try {
    await ensureStorageDir();
    const filePath = getFilePath(key);
    const content = await fs.readFile(filePath, 'utf-8');

    // An empty/whitespace-only file is almost always a botched/interrupted
    // write (the symptom the atomic write above prevents going forward), not
    // real corruption worth a hard error. Treat it as absent and return the
    // default so the caller can re-create it cleanly.
    if (content.trim().length === 0) {
      log.warn(`Item with key "${key}" at ${filePath} is empty; treating as missing and returning default.`);
      return defaultValue;
    }

    try {
      const parsedContent = JSON.parse(content);
      log.verbose(`Successfully loaded item from: ${filePath}`);
      return parsedContent;
    } catch (error) {
      // If JSON parsing fails, this is a critical error - don't return default
      const parseError = error as Error;
      log.error(`CRITICAL: Failed to parse JSON from ${filePath}:`, parseError);
      
      // Create a backup of the corrupted file before throwing
      const backupPath = `${filePath}.corrupted.${Date.now()}.bak`;
      try {
        await fs.writeFile(backupPath, content);
        log.info(`Created backup of corrupted file at: ${backupPath}`);
      } catch (backupError) {
        log.error(`Failed to create backup of corrupted file:`, backupError);
      }
      
      // Throw a more descriptive error
      throw new Error(`Failed to parse JSON from ${filePath}. A backup has been created at ${backupPath}. Original error: ${parseError.message}`);
    }
  } catch (error) {
    // Only return default if the file doesn't exist (ENOENT)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.verbose(`Item with key "${key}" not found at ${getFilePath(key)}, returning default.`);
      return defaultValue;
    }
    
    // For all other errors (file access issues, parsing errors, etc.), log and throw
    log.error(`CRITICAL: Error loading item with key "${key}" from ${getFilePath(key)}:`, error);
    throw error; // Re-throw the error instead of returning default
  }
}

export async function clearItem(key: StorageKey): Promise<void> {
  const filePath = getFilePath(key);
  try {
    await fs.unlink(filePath);
    log.verbose(`Successfully cleared item: ${filePath}`); // Added verbose log
  } catch (error) {
    // Ignore if file doesn't exist (ENOENT)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Error clearing item with key "${key}" at ${filePath}:`, error);
    } else {
        log.verbose(`Item with key "${key}" not found at ${filePath}, nothing to clear.`); // Verbose for non-existent file
    }
  }
}

// --- Per-item collections --------------------------------------------------
// Some stores (flows, and already conversations) are better kept as one file
// per item under db/<collection>/<id>.json than as one big array file: a write
// touches only the changed item (no whole-file rewrite / write amplification),
// and a single corrupt file can only take down that one item instead of the
// whole collection. These helpers mirror saveItem/loadItem/clearItem but operate
// on an individual item within a named collection directory, reusing the same
// atomic-write + per-key serialization machinery as the single-file API.

// Item ids become file names, and ids can originate from API callers (e.g. a
// flow POSTed to the public API), so they MUST be validated before being used
// to build a path — otherwise an id like `../../evil` would escape the
// collection directory (path traversal).
const SAFE_COLLECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export function assertSafeCollectionId(id: string): void {
  if (typeof id !== 'string' || !SAFE_COLLECTION_ID.test(id)) {
    throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
  }
}

const getCollectionDir = (collection: string) => path.join(storageDir(), collection);
const getCollectionItemPath = (collection: string, id: string) =>
  path.join(getCollectionDir(collection), `${id}.json`);

export const PERSONA_SHARDED_COLLECTIONS = [
  'persona-memories',
  'persona-mailbox',
  'persona-work-items',
  'persona-activities',
  'persona-lease-history',
] as const;
export type PersonaShardedCollection = typeof PERSONA_SHARDED_COLLECTIONS[number];
const PERSONA_SHARDED_COLLECTION_SET = new Set<string>(PERSONA_SHARDED_COLLECTIONS);

function assertPersonaShardedCollection(collection: string): asserts collection is PersonaShardedCollection {
  if (!PERSONA_SHARDED_COLLECTION_SET.has(collection)) {
    throw new Error(`Unsupported Persona-sharded collection: ${JSON.stringify(collection)}`);
  }
}

function assertContainedPath(parentPath: string, childPath: string): void {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Persona shard path escapes its collection: ${childPath}`);
  }
}

export function getLegacyCollectionItemPath(
  collection: PersonaShardedCollection,
  recordId: string,
): string {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(recordId);
  return getCollectionItemPath(collection, recordId);
}

export function getShardedCollectionItemPath(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
): string {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  const collectionDir = getCollectionDir(collection);
  const itemPath = path.join(collectionDir, personaId, `${recordId}.json`);
  assertContainedPath(collectionDir, itemPath);
  return itemPath;
}

async function lstatOrNull(filePath: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertLinkFreeDirectory(
  collection: PersonaShardedCollection,
  personaId: string,
  create: boolean,
): Promise<string | null> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  const collectionDir = getCollectionDir(collection);
  const shardDir = path.join(collectionDir, personaId);
  assertContainedPath(collectionDir, shardDir);

  if (create) await fs.mkdir(collectionDir, { recursive: true });
  const collectionStats = await lstatOrNull(collectionDir);
  if (!collectionStats) return null;
  if (!collectionStats.isDirectory() || collectionStats.isSymbolicLink()) {
    throw new Error(`Persona collection path is not a link-free directory: ${collectionDir}`);
  }

  if (create) {
    try {
      await fs.mkdir(shardDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const shardStats = await lstatOrNull(shardDir);
  if (!shardStats) return null;
  if (!shardStats.isDirectory() || shardStats.isSymbolicLink()) {
    throw new Error(`Persona shard is not a link-free directory: ${shardDir}`);
  }

  const [canonicalCollection, canonicalShard] = await Promise.all([
    fs.realpath(collectionDir),
    fs.realpath(shardDir),
  ]);
  assertContainedPath(canonicalCollection, canonicalShard);
  return shardDir;
}

type TextFileWithStats = {
  content: string;
  mtimeMs: number;
  sizeBytes: number;
};

async function readTextWithStatsOrNull(filePath: string): Promise<TextFileWithStats | null> {
  const stats = await lstatOrNull(filePath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Persona record path is not a regular link-free file: ${filePath}`);
  }
  return {
    content: await fs.readFile(filePath, 'utf8'),
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
  };
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  return (await readTextWithStatsOrNull(filePath))?.content ?? null;
}

function parsePersonaShardRecord<T>(
  content: string,
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid JSON in Persona record ${JSON.stringify(`${collection}/${personaId}/${recordId}`)}: `
      + (error as Error).message,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Persona record ${JSON.stringify(recordId)} is not an object.`);
  }
  const candidate = value as { id?: unknown; personaId?: unknown };
  if (candidate.id !== recordId || candidate.personaId !== personaId) {
    throw new Error(
      `Persona record ${JSON.stringify(recordId)} does not match requested Persona `
      + `${JSON.stringify(personaId)}.`,
    );
  }
  return value as T;
}

export class PersonaShardCollisionError extends Error {
  readonly code = 'PERSONA_SHARD_COLLISION' as const;

  constructor(
    readonly collection: PersonaShardedCollection,
    readonly personaId: string,
    readonly recordId: string,
  ) {
    super(
      `Conflicting flat and sharded copies exist for `
      + `${JSON.stringify(`${collection}/${personaId}/${recordId}`)}.`,
    );
    this.name = 'PersonaShardCollisionError';
  }
}

export async function loadShardedCollectionItem<T>(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
  defaultValue: T,
  options?: { includeLegacy?: boolean },
): Promise<T> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
  const shardedPath = getShardedCollectionItemPath(collection, personaId, recordId);
  const legacyPath = getLegacyCollectionItemPath(collection, recordId);
  const [sharded, legacy] = await Promise.all([
    shardDir ? readTextOrNull(shardedPath) : Promise.resolve(null),
    options?.includeLegacy === false ? Promise.resolve(null) : readTextOrNull(legacyPath),
  ]);
  if (sharded !== null && legacy !== null && sharded !== legacy) {
    throw new PersonaShardCollisionError(collection, personaId, recordId);
  }
  const content = sharded ?? legacy;
  return content === null
    ? defaultValue
    : parsePersonaShardRecord<T>(content, collection, personaId, recordId);
}

export async function getShardedCollectionItemStats(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
): Promise<{ mtimeMs: number; sizeBytes: number } | null> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
  const shardedPath = getShardedCollectionItemPath(collection, personaId, recordId);
  const legacyPath = getLegacyCollectionItemPath(collection, recordId);
  const [sharded, legacy] = await Promise.all([
    shardDir ? readTextWithStatsOrNull(shardedPath) : Promise.resolve(null),
    readTextWithStatsOrNull(legacyPath),
  ]);
  if (sharded && legacy && sharded.content !== legacy.content) {
    throw new PersonaShardCollisionError(collection, personaId, recordId);
  }
  const selected = sharded ?? legacy;
  if (!selected) return null;
  parsePersonaShardRecord(selected.content, collection, personaId, recordId);
  return {
    mtimeMs: selected.mtimeMs,
    sizeBytes: selected.sizeBytes,
  };
}

export async function saveShardedCollectionItem<T extends { id: string; personaId: string }>(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
  value: T,
): Promise<void> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  if (value.id !== recordId || value.personaId !== personaId) {
    throw new Error('Persona-sharded save identity does not match its destination.');
  }
  const shardedPath = getShardedCollectionItemPath(collection, personaId, recordId);
  const legacyPath = getLegacyCollectionItemPath(collection, recordId);
  await runInWriteChain(`persona-shard/${collection}/${personaId}/${recordId}`, async () => {
    await assertLinkFreeDirectory(collection, personaId, true);
    const legacy = await readTextOrNull(legacyPath);
    if (legacy !== null) {
      parsePersonaShardRecord(legacy, collection, personaId, recordId);
    }
    await writeFileAtomic(shardedPath, JSON.stringify(value, null, 2));
    try {
      await fs.unlink(legacyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

export async function deleteShardedCollectionItem(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
): Promise<void> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  const shardedPath = getShardedCollectionItemPath(collection, personaId, recordId);
  const legacyPath = getLegacyCollectionItemPath(collection, recordId);
  await runInWriteChain(`persona-shard/${collection}/${personaId}/${recordId}`, async () => {
    const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
    const [sharded, legacy] = await Promise.all([
      shardDir ? readTextOrNull(shardedPath) : Promise.resolve(null),
      readTextOrNull(legacyPath),
    ]);
    if (sharded !== null) parsePersonaShardRecord(sharded, collection, personaId, recordId);
    if (legacy !== null) parsePersonaShardRecord(legacy, collection, personaId, recordId);
    await Promise.all([shardedPath, legacyPath].map(async (filePath) => {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
  });
}

async function readPersonaShardDirectory<T>(
  collection: PersonaShardedCollection,
  personaId: string,
): Promise<T[]> {
  const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
  if (!shardDir) return [];
  const entries = (await fs.readdir(shardDir)).sort();
  const values: T[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json') || entry.includes('.tmp.') || entry.includes('.corrupted.')) continue;
    const recordId = entry.slice(0, -'.json'.length);
    assertSafeCollectionId(recordId);
    const filePath = path.join(shardDir, entry);
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Persona shard item is not a regular link-free file: ${filePath}`);
    }
    const content = await fs.readFile(filePath, 'utf8');
    values.push(parsePersonaShardRecord<T>(content, collection, personaId, recordId));
  }
  return values;
}

export function listShardedCollectionItems<T>(
  collection: PersonaShardedCollection,
  personaId: string,
): Promise<T[]> {
  return readPersonaShardDirectory<T>(collection, personaId);
}

export async function listAllShardedCollectionItems<T>(
  collection: PersonaShardedCollection,
): Promise<T[]> {
  assertPersonaShardedCollection(collection);
  const collectionDir = getCollectionDir(collection);
  const stats = await lstatOrNull(collectionDir);
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Persona collection path is not a link-free directory: ${collectionDir}`);
  }
  const entries = (await fs.readdir(collectionDir, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const byId = new Map<string, { content: string; value: T }>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Persona collection contains a symbolic link: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      assertSafeCollectionId(entry.name);
      const values = await readPersonaShardDirectory<T>(collection, entry.name);
      for (const value of values) {
        const record = value as { id: string };
        const content = JSON.stringify(value);
        const existing = byId.get(record.id);
        if (existing && existing.content !== content) {
          throw new PersonaShardCollisionError(collection, entry.name, record.id);
        }
        byId.set(record.id, { content, value });
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp.')
      || entry.name.includes('.corrupted.') || entry.name.endsWith('.bak')) continue;
    const recordId = entry.name.slice(0, -'.json'.length);
    assertSafeCollectionId(recordId);
    const content = await fs.readFile(path.join(collectionDir, entry.name), 'utf8');
    const parsed = JSON.parse(content) as { personaId?: unknown };
    if (typeof parsed.personaId !== 'string') {
      throw new Error(`Flat Persona record ${JSON.stringify(recordId)} has no owner.`);
    }
    assertSafeCollectionId(parsed.personaId);
    const value = parsePersonaShardRecord<T>(
      content,
      collection,
      parsed.personaId,
      recordId,
    );
    const canonical = JSON.stringify(value);
    const existing = byId.get(recordId);
    if (existing && existing.content !== canonical) {
      throw new PersonaShardCollisionError(collection, parsed.personaId, recordId);
    }
    byId.set(recordId, { content: canonical, value });
  }
  return [...byId.values()].map(({ value }) => value);
}

export async function migrateLegacyCollectionItem(
  collection: PersonaShardedCollection,
  personaId: string,
  recordId: string,
): Promise<'migrated' | 'already-migrated' | 'missing'> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  assertSafeCollectionId(recordId);
  const shardedPath = getShardedCollectionItemPath(collection, personaId, recordId);
  const legacyPath = getLegacyCollectionItemPath(collection, recordId);
  return runInWriteChain(
    `persona-shard/${collection}/${personaId}/${recordId}`,
    async () => {
      const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
      const [sharded, legacy] = await Promise.all([
        shardDir ? readTextOrNull(shardedPath) : Promise.resolve(null),
        readTextOrNull(legacyPath),
      ]);
      if (sharded !== null) parsePersonaShardRecord(sharded, collection, personaId, recordId);
      if (legacy !== null) parsePersonaShardRecord(legacy, collection, personaId, recordId);
      if (sharded !== null && legacy !== null && sharded !== legacy) {
        throw new PersonaShardCollisionError(collection, personaId, recordId);
      }
      if (legacy === null) return sharded === null ? 'missing' : 'already-migrated';
      if (sharded === null) {
        await assertLinkFreeDirectory(collection, personaId, true);
        await writeFileAtomic(shardedPath, legacy);
        if (await readTextOrNull(shardedPath) !== legacy) {
          throw new Error(`Could not verify migrated Persona record ${JSON.stringify(recordId)}.`);
        }
      }
      await fs.unlink(legacyPath);
      return 'migrated';
    },
  );
}

export async function deletePersonaCollectionShard(
  collection: PersonaShardedCollection,
  personaId: string,
): Promise<void> {
  assertPersonaShardedCollection(collection);
  assertSafeCollectionId(personaId);
  await runInWriteChain(`persona-shard/${collection}/${personaId}`, async () => {
    const shardDir = await assertLinkFreeDirectory(collection, personaId, false);
    if (!shardDir) return;
    const entries = await fs.readdir(shardDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          `Persona shard contains a non-regular or linked entry: ${path.join(shardDir, entry.name)}`,
        );
      }
    }
    await fs.rm(shardDir, { recursive: true });
  });
}

// Run a task serialized behind any in-flight write for the same chain key, so
// concurrent saves/deletes of the SAME item can't interleave their
// temp-file/rename/unlink steps. Different keys still run concurrently.
//
// The caller's key is namespaced by the selected workspace (#406) so that ids
// that are only unique WITHIN a workspace (conversation ids, MCP server names,
// KV scopes) cannot serialize across workspaces — which would both be a
// needless bottleneck and, for read-modify-write callers, a correctness bug.
//
// NOT re-entrant: a task must never call runInWriteChain again with its own
// chain key. The nested call queues behind the task that is making it, and
// neither can ever complete. Code already running inside a chain must call the
// unchained form of whatever it needs.
export function runInWriteChain<T>(chainKey: string, task: () => Promise<T>): Promise<T> {
  const scopedKey = workspaceCacheKey('chain', chainKey);
  const previous = writeChains.get(scopedKey) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior task's error is surfaced to its own caller */ })
    .then(task);
  writeChains.set(scopedKey, run);
  // Drop the entry once it's the tail so the map doesn't grow forever.
  void run.catch(() => { /* handled by the caller awaiting `run` */ }).finally(() => {
    if (writeChains.get(scopedKey) === run) {
      writeChains.delete(scopedKey);
    }
  });
  return run;
}

export async function saveCollectionItem<T>(collection: string, id: string, value: T): Promise<void> {
  assertSafeCollectionId(id);
  const filePath = getCollectionItemPath(collection, id);
  try {
    await runInWriteChain(`${collection}/${id}`, () =>
      writeFileAtomic(filePath, JSON.stringify(value, null, 2)));
    log.verbose(`Successfully saved collection item: ${filePath}`);
  } catch (error) {
    log.error(`Error saving collection item "${collection}/${id}" to ${filePath}:`, error);
    throw error;
  }
}

export async function loadCollectionItem<T>(collection: string, id: string, defaultValue: T): Promise<T> {
  assertSafeCollectionId(id);
  const filePath = getCollectionItemPath(collection, id);
  try {
    const content = await fs.readFile(filePath, 'utf-8');

    // An empty/whitespace-only file is almost always a botched write, not real
    // corruption; treat as absent so the caller can re-create it cleanly.
    if (content.trim().length === 0) {
      log.warn(`Collection item "${collection}/${id}" at ${filePath} is empty; treating as missing.`);
      return defaultValue;
    }

    try {
      return JSON.parse(content) as T;
    } catch (error) {
      const parseError = error as Error;
      log.error(`CRITICAL: Failed to parse JSON from ${filePath}:`, parseError);
      // Back up ONLY this item (the blast-radius win over one big array file).
      const backupPath = `${filePath}.corrupted.${Date.now()}.bak`;
      try {
        await fs.writeFile(backupPath, content);
        log.info(`Created backup of corrupted file at: ${backupPath}`);
      } catch (backupError) {
        log.error(`Failed to create backup of corrupted file:`, backupError);
      }
      throw new Error(`Failed to parse JSON from ${filePath}. A backup has been created at ${backupPath}. Original error: ${parseError.message}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.verbose(`Collection item "${collection}/${id}" not found at ${filePath}, returning default.`);
      return defaultValue;
    }
    log.error(`CRITICAL: Error loading collection item "${collection}/${id}" from ${filePath}:`, error);
    throw error;
  }
}

export async function deleteCollectionItem(collection: string, id: string): Promise<void> {
  assertSafeCollectionId(id);
  const filePath = getCollectionItemPath(collection, id);
  // Delete through the same write chain so it can't race an in-flight save of
  // the same item.
  await runInWriteChain(`${collection}/${id}`, async () => {
    try {
      await fs.unlink(filePath);
      log.verbose(`Successfully deleted collection item: ${filePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      log.verbose(`Collection item "${collection}/${id}" not found at ${filePath}, nothing to delete.`);
    }
  });
}

export async function listCollectionItems<T>(collection: string): Promise<T[]> {
  const dirPath = getCollectionDir(collection);
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    // A collection with no directory yet is simply empty.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const items: T[] = [];
  for (const entry of entries) {
    // Only real item files: skip temp writes, corruption backups and anything
    // that isn't a .json (the .tmp.* files end in a counter, not .json).
    if (!entry.endsWith('.json')) continue;
    if (entry.includes('.tmp.') || entry.includes('.corrupted.') || entry.endsWith('.bak')) continue;
    const filePath = path.join(dirPath, entry);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim().length === 0) {
        log.warn(`Collection item file ${filePath} is empty; skipping.`);
        continue;
      }
      items.push(JSON.parse(content) as T);
    } catch (error) {
      // A single unreadable/corrupt file must not break the whole listing.
      log.error(`Failed to read collection item ${filePath}; skipping.`, error);
    }
  }
  return items;
}

/**
 * Fail-closed collection scan for records that participate in runtime
 * uniqueness, ordering, or fencing. Unlike the tolerant UI/listing helper, a
 * malformed, empty, unreadable, or filename-mismatched JSON item aborts the
 * whole authoritative read.
 */
export async function listCollectionItemEntriesStrict<T>(
  collection: string,
): Promise<Array<{ id: string; item: T }>> {
  const dirPath = getCollectionDir(collection);
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const items: Array<{ id: string; item: T }> = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    if (entry.includes('.tmp.') || entry.includes('.corrupted.') || entry.endsWith('.bak')) {
      continue;
    }
    const id = entry.slice(0, -'.json'.length);
    assertSafeCollectionId(id);
    const filePath = path.join(dirPath, entry);
    const content = await fs.readFile(filePath, 'utf8');
    if (content.trim().length === 0) {
      throw new Error(`Authoritative collection item ${JSON.stringify(`${collection}/${id}`)} is empty.`);
    }
    let item: T;
    try {
      item = JSON.parse(content) as T;
    } catch (error) {
      throw new Error(
        `Authoritative collection item ${JSON.stringify(`${collection}/${id}`)} is invalid JSON: `
        + `${(error as Error).message}`,
      );
    }
    items.push({ id, item });
  }
  return items;
}

/**
 * Like listCollectionItems, but also returns the storage id, file size, and
 * last-modified time (mtimeMs, epoch ms). Used to backfill server-managed timestamps for legacy
 * items that predate them (e.g. flows without createdAt/updatedAt — #108),
 * mirroring how the conversations route derives times from file stats.
 */
export async function listCollectionItemsWithStats<T>(
  collection: string,
): Promise<Array<{ id: string; item: T; mtimeMs: number; sizeBytes: number }>> {
  const dirPath = getCollectionDir(collection);
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const results: Array<{ id: string; item: T; mtimeMs: number; sizeBytes: number }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.includes('.tmp.') || entry.includes('.corrupted.') || entry.endsWith('.bak')) continue;
    const filePath = path.join(dirPath, entry);
    try {
      const [content, stats] = await Promise.all([
        fs.readFile(filePath, 'utf-8'),
        fs.stat(filePath),
      ]);
      if (content.trim().length === 0) {
        log.warn(`Collection item file ${filePath} is empty; skipping.`);
        continue;
      }
      results.push({
        id: entry.slice(0, -'.json'.length),
        item: JSON.parse(content) as T,
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size,
      });
    } catch (error) {
      log.error(`Failed to read collection item ${filePath}; skipping.`, error);
    }
  }
  return results;
}

/**
 * One-time, idempotent migration from a single array file (db/<key>.json) to
 * per-item files (db/<collection>/<id>.json). Safe to call on every startup:
 *   - per-item files always WIN and are never overwritten (so a crash mid-run
 *     re-runs safely, and manual edits made after migration are preserved);
 *   - the legacy file is renamed to `<file>.migrated-<ts>.bak` (this IS the
 *     backup) only AFTER every item has been written;
 *   - items with an invalid/unsafe id are skipped with a loud error rather than
 *     silently re-keyed.
 * Returns the number of items found in the legacy file (0 when there was none).
 */
export async function migrateArrayFileToCollection<T>(
  key: StorageKey,
  collection: string,
  getId: (item: T) => string,
): Promise<number> {
  const legacyPath = getFilePath(key);
  let content: string;
  try {
    content = await fs.readFile(legacyPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; // nothing to migrate
    throw error;
  }

  if (content.trim().length === 0) {
    // Empty legacy file: just archive it out of the way.
    await fs.rename(legacyPath, `${legacyPath}.migrated-${Date.now()}.bak`);
    return 0;
  }

  let items: unknown;
  try {
    items = JSON.parse(content);
  } catch (error) {
    log.error(`Migration: legacy ${key}.json is not valid JSON; leaving it in place.`, error);
    return 0;
  }
  if (!Array.isArray(items)) {
    log.error(`Migration: legacy ${key}.json is not an array; leaving it in place.`);
    return 0;
  }

  await fs.mkdir(getCollectionDir(collection), { recursive: true });
  for (const item of items as T[]) {
    let id: string;
    try {
      id = getId(item);
      assertSafeCollectionId(id);
    } catch (error) {
      log.error(`Migration: skipping ${collection} item with invalid/unsafe id`, error);
      continue;
    }
    const itemPath = getCollectionItemPath(collection, id);
    // Per-item files win: never clobber one that already exists.
    try {
      await fs.access(itemPath);
      log.debug(`Migration: ${collection}/${id} already exists; keeping the existing file.`);
      continue;
    } catch {
      // Doesn't exist yet — write it below.
    }
    await writeFileAtomic(itemPath, JSON.stringify(item, null, 2));
  }

  // Archive the legacy file only after every item has been (re)written.
  await fs.rename(legacyPath, `${legacyPath}.migrated-${Date.now()}.bak`);
  log.info(`Migration: moved ${items.length} ${collection} item(s) from ${key}.json to per-item storage.`);
  return items.length;
}
