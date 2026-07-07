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

async function writeFileAtomic(filePath: string, data: string): Promise<void> {
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
