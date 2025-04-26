import { promises as fs } from 'fs';
import path from 'path';
import { StorageKey } from '../../shared/types/storage';
import { createLogger } from '@/utils/logger';

const log = createLogger('utils/storage/backend');

// Current storage directory
const STORAGE_DIR = path.join(process.cwd(), 'db');
// Old storage directory (for checking)
const OLD_STORAGE_DIR = path.join(process.cwd(), '.next', 'storage');
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

export async function saveItem<T>(key: StorageKey, value: T): Promise<void> {
  // No longer call ensureStorageDir here, handle directory creation below
  const filePath = getFilePath(key);
  try {
    // Ensure the directory for the specific file exists
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true });
    log.verbose(`Ensured directory exists: ${dirPath}`); // Changed to verbose
    
    // Now write the file
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
    log.verbose(`Successfully saved item to: ${filePath}`); // Changed to verbose
  } catch (error) {
    log.error(`Error saving item with key "${key}" to ${filePath}:`, error);
    throw error; // Re-throw the error after logging
  }
}

export async function loadItem<T>(key: StorageKey, defaultValue: T): Promise<T> {
  try {
    await ensureStorageDir();
    const filePath = getFilePath(key);
    const content = await fs.readFile(filePath, 'utf-8');
    const parsedContent = JSON.parse(content);
    log.verbose(`Successfully loaded item from: ${filePath}`); // Added verbose log
    return parsedContent;
  } catch (error) {
    // Log only if the error is NOT file not found (ENOENT)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`Error loading item with key "${key}" from ${getFilePath(key)}, returning default:`, error);
    } else {
        log.verbose(`Item with key "${key}" not found at ${getFilePath(key)}, returning default.`); // Verbose for non-existent file
    }
    return defaultValue;
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
