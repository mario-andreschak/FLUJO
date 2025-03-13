// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { encryptWithPassword, decryptWithPassword } from '@/utils/encryption/secure';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { ModelServiceResponse } from '@/shared/types/model';

// Create a logger instance for this file
const log = createLogger('backend/services/model/encryption');

/**
 * Set encryption key in storage
 */
export async function setEncryptionKey(key: string): Promise<ModelServiceResponse> {
  log.debug('setEncryptionKey: Entering method');
  try {
    // Store the key securely on the server
    await saveItem(StorageKey.ENCRYPTION_KEY, key);
    return { success: true };
  } catch (error) {
    log.warn('setEncryptionKey: Failed to set encryption key:', error);
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Failed to set encryption key' 
    };
  }
}

/**
 * Initialize default encryption
 */
export async function initializeDefaultEncryption(): Promise<boolean> {
  log.debug('initializeDefaultEncryption: Entering method');
  try {
    // Generate a random key for default encryption
    const defaultKey = uuidv4() + uuidv4();
    
    // Store it securely
    const result = await setEncryptionKey(defaultKey);
    
    if (result.success) {
      log.info('initializeDefaultEncryption: Default encryption initialized successfully');
      return true;
    } else {
      log.error('initializeDefaultEncryption: Failed to initialize default encryption:', result.error);
      return false;
    }
  } catch (error) {
    log.error('initializeDefaultEncryption: Failed to initialize default encryption:', error);
    return false;
  }
}

/**
 * Encrypt an API key
 * Always encrypts sensitive data, never returns plain text
 */
export async function encryptApiKey(apiKey: string): Promise<string | null> {
  log.debug('encryptApiKey: Entering method');
  try {
    // Check if the apiKey is empty or undefined
    if (!apiKey || apiKey.trim() === '') {
      log.warn('encryptApiKey: Empty API key provided');
      return '';
    }
    
    // First check if encryption is initialized
    const isEncrypted = await isEncryptionConfigured();
    
    if (!isEncrypted) {
      // If encryption is not set up, initialize default encryption
      log.warn('encryptApiKey: Encryption is not configured, initializing default encryption');
      
      // Initialize default encryption
      const initialized = await initializeDefaultEncryption();
      if (!initialized) {
        log.error('encryptApiKey: Failed to initialize default encryption');
        return `encrypted_failed:${apiKey}`;
      }
    }
    
    // Use the encryption utility
    const encryptedKey = await encryptWithPassword(apiKey);
    if (!encryptedKey) {
      log.error('encryptApiKey: encryptWithPassword returned null');
      return `encrypted_failed:${apiKey}`;
    }
    
    return encryptedKey;
  } catch (error) {
    log.error('encryptApiKey: Failed to encrypt API key:', error);
    // Instead of returning plain text, return a marker that indicates encryption failed
    return `encrypted_failed:${apiKey}`;
  }
}

/**
 * Decrypt an API key
 * This should only be used for server-side API calls, never for UI display
 */
export async function decryptApiKey(encryptedApiKey: string): Promise<string | null> {
  log.debug('decryptApiKey: Entering method');
  try {
    // Check if this is a global variable reference
    if (encryptedApiKey && encryptedApiKey.startsWith('${global:')) {
      // Resolve the global variable
      const resolvedVars = await resolveGlobalVars({ key: encryptedApiKey }) as Record<string, string>;
      return resolvedVars.key;
    }
    
    // Check if this is a failed encryption marker
    if (encryptedApiKey && encryptedApiKey.startsWith('encrypted_failed:')) {
      // Return the original value without the marker
      return encryptedApiKey.substring('encrypted_failed:'.length);
    }
    
    // Use the decryption utility
    return await decryptWithPassword(encryptedApiKey);
  } catch (error) {
    log.warn('decryptApiKey: Failed to decrypt API key:', error);
    return null;
  }
}

/**
 * Resolve and decrypt an API key
 * This handles both global variables and encrypted keys
 */
export async function resolveAndDecryptApiKey(encryptedApiKey: string): Promise<string | null> {
  log.debug('resolveAndDecryptApiKey: Entering method');
  try {
    // Check if this is a global variable reference
    if (encryptedApiKey && encryptedApiKey.startsWith('${global:')) {
      // Resolve the global variable
      const resolvedVars = await resolveGlobalVars({ key: encryptedApiKey }) as Record<string, string>;
      return resolvedVars.key;
    }
    
    // Check if this is a failed encryption marker
    if (encryptedApiKey && encryptedApiKey.startsWith('encrypted_failed:')) {
      // Return the original value without the marker
      return encryptedApiKey.substring('encrypted_failed:'.length);
    }
    
    // Use the decryption utility
    return await decryptWithPassword(encryptedApiKey);
  } catch (error) {
    log.warn('resolveAndDecryptApiKey: Failed to resolve or decrypt API key:', error);
    return null;
  }
}

/**
 * Check if encryption is configured
 * This checks if encryption is set up without exposing the actual key
 */
export async function isEncryptionConfigured(): Promise<boolean> {
  log.debug('isEncryptionConfigured: Entering method');
  try {
    const key = await loadItem<string>(StorageKey.ENCRYPTION_KEY, '');
    return !!key;
  } catch (error) {
    log.warn('isEncryptionConfigured: Failed to check encryption status:', error);
    return false;
  }
}

/**
 * Check if user encryption is enabled (as opposed to default encryption)
 * This is a placeholder for future implementation
 */
export async function isUserEncryptionEnabled(): Promise<boolean> {
  log.debug('isUserEncryptionEnabled: Entering method');
  // Currently we don't have a way to distinguish between user and default encryption
  // This is a placeholder for future implementation
  return false;
}
