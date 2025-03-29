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
    log.debug(`Storage directory exists: ${STORAGE_DIR}`);
  } catch {
    log.info(`Creating storage directory: ${STORAGE_DIR}`);
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  }
  
  // Check if old storage directory exists and log a warning
  try {
    await fs.access(OLD_STORAGE_DIR);
    log.error(`Old storage directory found: ${OLD_STORAGE_DIR}. This may cause data inconsistency issues.`);
  } catch {
    // Old directory doesn't exist, which is good
  }
}

/**
 * Verify storage system initialization and integrity
 * This should be called during application startup
 */
export async function verifyStorage(): Promise<void> {
  log.info('Verifying storage system initialization');
  
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
      
      log.info(`Storage check: ${key} - ${exists ? 'File exists' : 'File does not exist yet'}`);
      
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
  
  log.info('Storage verification completed');
}

export async function saveItem<T>(key: StorageKey, value: T): Promise<void> {
  // No longer call ensureStorageDir here, handle directory creation below
  const filePath = getFilePath(key);
  try {
    // Ensure the directory for the specific file exists
    const dirPath = path.dirname(filePath);
    await fs.mkdir(dirPath, { recursive: true }); 
    log.debug(`Ensured directory exists: ${dirPath}`);
    
    // Now write the file
    await fs.writeFile(filePath, JSON.stringify(value, null, 2));
    log.debug(`Successfully saved item to: ${filePath}`);
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
    return JSON.parse(content);
  } catch (error) {
    return defaultValue;
  }
}

export async function clearItem(key: StorageKey): Promise<void> {
  try {
    const filePath = getFilePath(key);
    await fs.unlink(filePath);
  } catch (error) {
    // Ignore if file doesn't exist
  }
}
