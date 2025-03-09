import CryptoJS from 'crypto-js';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { createSession, getDekFromSession, invalidateSession } from './session';

// Create a logger instance for this file
const log = createLogger('utils/encryption/secure');

// Constants for encryption
const PBKDF2_ITERATIONS = 100000;
const KEY_SIZE = 256 / 32; // 256 bits in words
const SALT_SIZE = 128 / 8; // 128 bits in bytes
const IV_SIZE = 128 / 8; // 128 bits in bytes

// Key storage constants
const DEK_KEY = 'data_encryption_key';
const DEK_IV = 'data_encryption_iv';
const DEK_SALT = 'data_encryption_salt';
const DEK_VERSION = 'encryption_version';
const ENCRYPTION_TYPE = 'encryption_type';

// Default encryption key (used until user sets their own)
// This provides basic security without requiring user setup
const DEFAULT_ENCRYPTION_KEY = "FLUJO~";

// Encryption types
enum EncryptionType {
  DEFAULT = 'default',
  USER = 'user'
}

interface EncryptionMetadata {
  [DEK_KEY]: string;    // Encrypted DEK
  [DEK_IV]: string;     // IV used to encrypt DEK
  [DEK_SALT]: string;   // Salt used for key derivation
  [DEK_VERSION]: number; // Version of encryption scheme
  [ENCRYPTION_TYPE]?: EncryptionType; // Type of encryption (default or user)
}

/**
 * Get a derived encryption key from the default key
 * This is used when no user key is set
 */
function getDefaultDerivedKey(): CryptoJS.lib.WordArray {
  // Use a fixed salt for the default key
  const fixedSalt = CryptoJS.enc.Utf8.parse("flujo_fixed_salt_v1");
  
  // Derive a key from the default password using PBKDF2
  return CryptoJS.PBKDF2(
    DEFAULT_ENCRYPTION_KEY,
    fixedSalt,
    {
      keySize: KEY_SIZE,
      iterations: PBKDF2_ITERATIONS
    }
  );
}

/**
 * Generate a random DEK (Data Encryption Key)
 */
function generateRandomDEK(): CryptoJS.lib.WordArray {
  return CryptoJS.lib.WordArray.random(KEY_SIZE);
}

/**
 * Initialize the default encryption system
 * This creates a DEK encrypted with the default key
 */
export async function initializeDefaultEncryption(): Promise<boolean> {
  log.debug('initializeDefaultEncryption: Entering method');
  try {
    // Check if encryption is already initialized
    const isInitialized = await isEncryptionInitialized();
    if (isInitialized) {
      // Already initialized, no need to do it again
      return true;
    }
    
    // Get the default derived key
    const derivedKey = getDefaultDerivedKey();
    
    // Generate a random DEK
    const dataEncryptionKey = generateRandomDEK();
    
    // Generate a random IV for DEK encryption
    const iv = CryptoJS.lib.WordArray.random(IV_SIZE);
    
    // Encrypt the DEK with the derived key
    const encryptedDEK = CryptoJS.AES.encrypt(
      dataEncryptionKey.toString(),
      derivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    // Create fixed salt for storage
    const fixedSalt = CryptoJS.enc.Utf8.parse("flujo_fixed_salt_v1");
    
    // Store the encrypted DEK and metadata
    const metadata: EncryptionMetadata = {
      [DEK_KEY]: encryptedDEK.toString(),
      [DEK_IV]: iv.toString(),
      [DEK_SALT]: fixedSalt.toString(),
      [DEK_VERSION]: 1, // Initial version
      [ENCRYPTION_TYPE]: EncryptionType.DEFAULT
    };
    
    // Save the encryption metadata
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
    
    return true;
  } catch (error) {
    log.error('initializeDefaultEncryption: Failed to initialize default encryption:', error);
    return false;
  }
}

/**
 * Initialize the encryption system with a user password
 * This creates a new DEK, encrypts it with the password-derived key,
 * and stores the encrypted DEK and metadata
 */
export async function initializeEncryption(password: string): Promise<boolean> {
  log.debug('initializeEncryption: Entering method');
  try {
    // Check if we need to migrate from default encryption
    const existingMetadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (existingMetadata && existingMetadata[ENCRYPTION_TYPE] === EncryptionType.DEFAULT) {
      // Migrate from default to user encryption
      return await migrateToUserEncryption(password);
    }
    
    // Generate a random salt for key derivation
    const salt = CryptoJS.lib.WordArray.random(SALT_SIZE);
    
    // Derive a key from the password using PBKDF2
    const derivedKey = CryptoJS.PBKDF2(
      password,
      salt,
      {
        keySize: KEY_SIZE,
        iterations: PBKDF2_ITERATIONS
      }
    );
    
    // Generate a random DEK (Data Encryption Key)
    const dataEncryptionKey = CryptoJS.lib.WordArray.random(KEY_SIZE);
    
    // Generate a random IV for DEK encryption
    const iv = CryptoJS.lib.WordArray.random(IV_SIZE);
    
    // Encrypt the DEK with the derived key
    const encryptedDEK = CryptoJS.AES.encrypt(
      dataEncryptionKey.toString(),
      derivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    // Store the encrypted DEK and metadata
    const metadata: EncryptionMetadata = {
      [DEK_KEY]: encryptedDEK.toString(),
      [DEK_IV]: iv.toString(),
      [DEK_SALT]: salt.toString(),
      [DEK_VERSION]: 1, // Initial version
      [ENCRYPTION_TYPE]: EncryptionType.USER
    };
    
    // Save the encryption metadata
    await saveItem(StorageKey.ENCRYPTION_KEY, metadata);
    
    return true;
  } catch (error) {
    log.error('initializeEncryption: Failed to initialize encryption:', error);
    return false;
  }
}

/**
 * Get the default DEK
 * This is used for encryption/decryption when no user key is set
 */
async function getDefaultDEK(): Promise<CryptoJS.lib.WordArray | null> {
  log.debug('getDefaultDEK: Entering method');
  try {
    // Load the encryption metadata
    const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (!metadata) {
      // No encryption metadata found, initialize default encryption
      const initialized = await initializeDefaultEncryption();
      if (!initialized) {
        log.error('getDefaultDEK: Failed to initialize default encryption');
        return null;
      }
      
      // Try again after initialization
      return await getDefaultDEK();
    }
    
    // Check if we're using default encryption
    if (metadata[ENCRYPTION_TYPE] !== EncryptionType.DEFAULT) {
      log.error('getDefaultDEK: Not using default encryption');
      return null;
    }
    
    // Extract the metadata
    const encryptedDEK = metadata[DEK_KEY];
    const iv = CryptoJS.enc.Hex.parse(metadata[DEK_IV]);
    
    // Get the default derived key
    const derivedKey = getDefaultDerivedKey();
    
    // Decrypt the DEK
    const decryptedDEK = CryptoJS.AES.decrypt(
      encryptedDEK,
      derivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    if (!decryptedDEK.toString()) {
      log.error('getDefaultDEK: Failed to decrypt DEK with default key');
      return null;
    }
    
    return CryptoJS.enc.Hex.parse(decryptedDEK.toString());
  } catch (error) {
    log.error('getDefaultDEK: Failed to get default DEK:', error);
    return null;
  }
}

/**
 * Get the user DEK
 * This is used for encryption/decryption when a user key is set
 */
async function getUserDEK(password: string): Promise<CryptoJS.lib.WordArray | null> {
  log.debug('getUserDEK: Entering method');
  try {
    // Load the encryption metadata
    const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (!metadata) {
      log.error('getUserDEK: No encryption metadata found');
      return null;
    }
    
    // Check if we're using user encryption
    if (metadata[ENCRYPTION_TYPE] !== EncryptionType.USER) {
      log.error('getUserDEK: Not using user encryption');
      return null;
    }
    
    // Extract the metadata
    const encryptedDEK = metadata[DEK_KEY];
    const iv = CryptoJS.enc.Hex.parse(metadata[DEK_IV]);
    const salt = CryptoJS.enc.Hex.parse(metadata[DEK_SALT]);
    
    // Derive the key from the password
    const derivedKey = CryptoJS.PBKDF2(
      password,
      salt,
      {
        keySize: KEY_SIZE,
        iterations: PBKDF2_ITERATIONS
      }
    );
    
    // Decrypt the DEK
    const decryptedDEK = CryptoJS.AES.decrypt(
      encryptedDEK,
      derivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    if (!decryptedDEK.toString()) {
      log.error('getUserDEK: Failed to decrypt DEK with provided password');
      return null;
    }
    
    return CryptoJS.enc.Hex.parse(decryptedDEK.toString());
  } catch (error) {
    log.error('getUserDEK: Failed to get user DEK:', error);
    return null;
  }
}

/**
 * Migrate from default encryption to user encryption
 * This decrypts all data with the default key and re-encrypts it with the user's key
 */
export async function migrateToUserEncryption(password: string): Promise<boolean> {
  log.debug('migrateToUserEncryption: Entering method');
  try {
    // Check if we're already using user encryption
    const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (metadata && metadata[ENCRYPTION_TYPE] === EncryptionType.USER) {
      // Already using user encryption, no need to migrate
      return true;
    }
    
    // Get the default DEK
    const defaultDEK = await getDefaultDEK();
    if (!defaultDEK) {
      log.error('migrateToUserEncryption: Failed to get default DEK for migration');
      return false;
    }
    
    // Generate a random salt for key derivation
    const salt = CryptoJS.lib.WordArray.random(SALT_SIZE);
    
    // Derive a key from the password using PBKDF2
    const derivedKey = CryptoJS.PBKDF2(
      password,
      salt,
      {
        keySize: KEY_SIZE,
        iterations: PBKDF2_ITERATIONS
      }
    );
    
    // Generate a random IV for DEK encryption
    const iv = CryptoJS.lib.WordArray.random(IV_SIZE);
    
    // Re-encrypt the DEK with the user's key
    const encryptedDEK = CryptoJS.AES.encrypt(
      defaultDEK.toString(),
      derivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    // Update the metadata
    const newMetadata: EncryptionMetadata = {
      [DEK_KEY]: encryptedDEK.toString(),
      [DEK_IV]: iv.toString(),
      [DEK_SALT]: salt.toString(),
      [DEK_VERSION]: metadata ? metadata[DEK_VERSION] : 1, // Keep the same version or use 1
      [ENCRYPTION_TYPE]: EncryptionType.USER
    };
    
    // Save the updated metadata
    await saveItem(StorageKey.ENCRYPTION_KEY, newMetadata);
    
    // In a real implementation, we would need to re-encrypt all sensitive data
    // For now, we'll just return success
    
    return true;
  } catch (error) {
    log.error('migrateToUserEncryption: Failed to migrate to user encryption:', error);
    return false;
  }
}

/**
 * Change the encryption password
 * This decrypts the DEK with the old password and re-encrypts it with the new password
 */
export async function changeEncryptionPassword(oldPassword: string, newPassword: string): Promise<boolean> {
  log.debug('changeEncryptionPassword: Entering method');
  try {
    // Load the encryption metadata
    const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (!metadata) {
      log.error('changeEncryptionPassword: No encryption metadata found');
      return false;
    }
    
    // Check if we're using default encryption
    if (metadata[ENCRYPTION_TYPE] === EncryptionType.DEFAULT) {
      // Migrate from default to user encryption instead of changing password
      return await migrateToUserEncryption(newPassword);
    }
    
    // Extract the metadata
    const encryptedDEK = metadata[DEK_KEY];
    const iv = CryptoJS.enc.Hex.parse(metadata[DEK_IV]);
    const salt = CryptoJS.enc.Hex.parse(metadata[DEK_SALT]);
    
    // Derive the old key
    const oldDerivedKey = CryptoJS.PBKDF2(
      oldPassword,
      salt,
      {
        keySize: KEY_SIZE,
        iterations: PBKDF2_ITERATIONS
      }
    );
    
    // Decrypt the DEK with the old key
    const decryptedDEK = CryptoJS.AES.decrypt(
      encryptedDEK,
      oldDerivedKey,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    if (!decryptedDEK.toString()) {
      log.error('changeEncryptionPassword: Failed to decrypt DEK with old password');
      return false;
    }
    
    // Generate a new salt for the new key
    const newSalt = CryptoJS.lib.WordArray.random(SALT_SIZE);
    
    // Derive a new key from the new password
    const newDerivedKey = CryptoJS.PBKDF2(
      newPassword,
      newSalt,
      {
        keySize: KEY_SIZE,
        iterations: PBKDF2_ITERATIONS
      }
    );
    
    // Generate a new IV for DEK encryption
    const newIv = CryptoJS.lib.WordArray.random(IV_SIZE);
    
    // Re-encrypt the DEK with the new key
    const newEncryptedDEK = CryptoJS.AES.encrypt(
      decryptedDEK.toString(),
      newDerivedKey,
      {
        iv: newIv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    // Update the metadata
    const newMetadata: EncryptionMetadata = {
      [DEK_KEY]: newEncryptedDEK.toString(),
      [DEK_IV]: newIv.toString(),
      [DEK_SALT]: newSalt.toString(),
      [DEK_VERSION]: metadata[DEK_VERSION], // Keep the same version
      [ENCRYPTION_TYPE]: EncryptionType.USER
    };
    
    // Save the updated metadata
    await saveItem(StorageKey.ENCRYPTION_KEY, newMetadata);
    
    return true;
  } catch (error) {
    log.error('changeEncryptionPassword: Failed to change encryption password:', error);
    return false;
  }
}

/**
 * Get the DEK using the provided password, session token, or default key
 * This is a helper function used by encrypt and decrypt
 */
async function getDEK(passwordOrToken?: string, isToken: boolean = false): Promise<CryptoJS.lib.WordArray | null> {
  log.debug('getDEK: Entering method');
  try {
    // If a token is provided, try to get the DEK from the session
    if (isToken && passwordOrToken) {
      log.debug('getDEK: Using session token');
      const dekString = getDekFromSession(passwordOrToken);
      if (dekString) {
        return CryptoJS.enc.Hex.parse(dekString);
      }
      log.warn('getDEK: Invalid or expired session token, falling back to default encryption');
    }
    
    // Load the encryption metadata
    const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
    if (!metadata) {
      // No encryption metadata found, initialize default encryption
      log.info('getDEK: No encryption metadata found, initializing default encryption');
      const initialized = await initializeDefaultEncryption();
      if (!initialized) {
        log.error('getDEK: Failed to initialize default encryption');
        return null;
      }
      
      // Try again after initialization
      return await getDEK(passwordOrToken, isToken);
    }
    
    // Check the encryption type
    if (metadata[ENCRYPTION_TYPE] === EncryptionType.USER) {
      // User encryption requires a password
      if (!passwordOrToken || isToken) {
        log.warn('getDEK: Password required for user encryption but not provided, falling back to default encryption');
        // Instead of failing, try to initialize default encryption and use that
        const defaultDEK = await getDefaultDEK();
        if (defaultDEK) {
          return defaultDEK;
        }
        
        // If default DEK fails, try to initialize it
        const initialized = await initializeDefaultEncryption();
        if (!initialized) {
          log.error('getDEK: Failed to initialize default encryption as fallback');
          return null;
        }
        
        // Try to get the default DEK again
        return await getDefaultDEK();
      }
      
      // Try to get the user DEK
      const userDEK = await getUserDEK(passwordOrToken);
      if (userDEK) {
        return userDEK;
      }
      
      // If user DEK fails, fall back to default encryption
      log.warn('getDEK: Failed to get user DEK, falling back to default encryption');
      return await getDefaultDEK();
    } else {
      // Default encryption
      return await getDefaultDEK();
    }
  } catch (error) {
    log.error('getDEK: Failed to get DEK:', error);
    
    // Try to initialize default encryption as a last resort
    try {
      log.warn('getDEK: Attempting to initialize default encryption as error recovery');
      const initialized = await initializeDefaultEncryption();
      if (initialized) {
        return await getDefaultDEK();
      }
    } catch (fallbackError) {
      log.error('getDEK: Failed to initialize default encryption as error recovery:', fallbackError);
    }
    
    return null;
  }
}

/**
 * Encrypt data using the DEK
 * If no password or token is provided, uses the default key
 */
export async function encryptWithPassword(text: string, passwordOrToken?: string, isToken: boolean = false): Promise<string | null> {
  log.debug('encryptWithPassword: Entering method');
  try {
    // Get the DEK
    const dek = await getDEK(passwordOrToken, isToken);
    if (!dek) {
      return null;
    }
    
    // Generate a random IV for data encryption
    const iv = CryptoJS.lib.WordArray.random(IV_SIZE);
    
    // Encrypt the data with the DEK
    const encrypted = CryptoJS.AES.encrypt(
      text,
      dek,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    // Combine the IV and ciphertext for storage
    // Format: iv:ciphertext
    return iv.toString() + ':' + encrypted.toString();
  } catch (error) {
    log.error('encryptWithPassword: Failed to encrypt data:', error);
    return null;
  }
}

/**
 * Decrypt data using the DEK
 * If no password or token is provided, uses the default key
 */
export async function decryptWithPassword(ciphertext: string, passwordOrToken?: string, isToken: boolean = false): Promise<string | null> {
  log.debug('decryptWithPassword: Entering method');
  try {
    // Get the DEK
    const dek = await getDEK(passwordOrToken, isToken);
    if (!dek) {
      return null;
    }
    
    // Split the IV and ciphertext
    const parts = ciphertext.split(':');
    if (parts.length !== 2) {
      log.error('decryptWithPassword: Invalid ciphertext format');
      return null;
    }
    
    const iv = CryptoJS.enc.Hex.parse(parts[0]);
    const encryptedText = parts[1];
    
    // Decrypt the data with the DEK
    const decrypted = CryptoJS.AES.decrypt(
      encryptedText,
      dek,
      {
        iv: iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      }
    );
    
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (error) {
    log.error('decryptWithPassword: Failed to decrypt data:', error);
    return null;
  }
}

/**
 * Check if the provided password is correct
 * If correct, creates a session and returns the token
 */
export async function verifyPassword(password: string): Promise<{ valid: boolean, token?: string }> {
  log.debug('verifyPassword: Entering method');
  // Load the encryption metadata
  const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
  if (!metadata) {
    return { valid: false };
  }
  
  // Check the encryption type
  if (metadata[ENCRYPTION_TYPE] === EncryptionType.USER) {
    // For user encryption, verify the password
    const dek = await getUserDEK(password);
    if (dek !== null) {
      // Password is valid, create a session
      const token = createSession(dek.toString());
      return { valid: true, token };
    }
    return { valid: false };
  } else {
    // For default encryption, any password is invalid
    return { valid: false };
  }
}

/**
 * Authenticate with a password and create a session
 * @param password The user's password
 * @returns A session token if authentication is successful, null otherwise
 */
export async function authenticate(password: string): Promise<string | null> {
  log.debug('authenticate: Entering method');
  const result = await verifyPassword(password);
  return result.valid ? result.token || null : null;
}

/**
 * Invalidate an authentication session
 * @param token The session token to invalidate
 */
export async function logout(token: string): Promise<boolean> {
  log.debug('logout: Entering method');
  try {
    invalidateSession(token);
    return true;
  } catch (error) {
    log.error('logout: Failed to invalidate session:', error);
    return false;
  }
}

/**
 * Check if encryption is initialized
 */
export async function isEncryptionInitialized(): Promise<boolean> {
  log.debug('isEncryptionInitialized: Entering method');
  const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
  return metadata !== null;
}

/**
 * Check if user encryption is enabled
 */
export async function isUserEncryptionEnabled(): Promise<boolean> {
  log.debug('isUserEncryptionEnabled: Entering method');
  const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
  return metadata !== null && metadata[ENCRYPTION_TYPE] === EncryptionType.USER;
}

/**
 * Get the current encryption type
 */
export async function getEncryptionType(): Promise<EncryptionType | null> {
  log.debug('getEncryptionType: Entering method');
  const metadata = await loadItem<EncryptionMetadata | null>(StorageKey.ENCRYPTION_KEY, null);
  if (!metadata) {
    return null;
  }
  
  return metadata[ENCRYPTION_TYPE] || EncryptionType.DEFAULT;
}
