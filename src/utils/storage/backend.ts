import { promises as fs } from 'fs';
import path from 'path';
import { StorageKey } from '../../shared/types/storage';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';

const log = createLogger('utils/storage/backend');

// Current storage directory. Resolved from the data dir (see utils/paths) so a
// packaged install (npm/Docker) can keep db/ outside the read-only app install;
// defaults to the app dir, so a git checkout is unchanged (<repo>/db).
const STORAGE_DIR = path.join(getDataDir(), 'db');
// Old storage directory (for checking)
const OLD_STORAGE_DIR = path.join(getDataDir(), '.next', 'storage');
const getFilePath = (key: StorageKey) => path.join(STORAGE_DIR, `${key}.json`);

// Ensure storage directory exists
async function ensureStorageDir() {
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
      const oldFilePath = path.join(OLD_STORAGE_DIR, `${key}.json`);
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

export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true });
  // Temp file lives next to the target (same filesystem) so rename is atomic.
  const tmpPath = `${filePath}.tmp.${process.pid}.${++tmpCounter}`;
  try {
    await fs.writeFile(tmpPath, data);
    await fs.rename(tmpPath, filePath);
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
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior write's error is surfaced to its own caller */ })
    .then(() => writeFileAtomic(filePath, JSON.stringify(value, null, 2)));
  writeChains.set(key, run);

  try {
    await run;
    log.verbose(`Successfully saved item to: ${filePath}`); // Changed to verbose
  } catch (error) {
    log.error(`Error saving item with key "${key}" to ${filePath}:`, error);
    throw error; // Re-throw the error after logging
  } finally {
    // Drop the chain entry once it's the tail, so the map doesn't grow forever.
    if (writeChains.get(key) === run) {
      writeChains.delete(key);
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

const getCollectionDir = (collection: string) => path.join(STORAGE_DIR, collection);
const getCollectionItemPath = (collection: string, id: string) =>
  path.join(getCollectionDir(collection), `${id}.json`);

// Run a task serialized behind any in-flight write for the same chain key, so
// concurrent saves/deletes of the SAME item can't interleave their
// temp-file/rename/unlink steps. Different keys still run concurrently.
export function runInWriteChain<T>(chainKey: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(chainKey) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior task's error is surfaced to its own caller */ })
    .then(task);
  writeChains.set(chainKey, run);
  // Drop the entry once it's the tail so the map doesn't grow forever.
  void run.catch(() => { /* handled by the caller awaiting `run` */ }).finally(() => {
    if (writeChains.get(chainKey) === run) {
      writeChains.delete(chainKey);
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
