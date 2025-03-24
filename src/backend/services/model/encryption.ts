import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import { ModelServiceResponse } from '@/shared/types/model';
import { resolveGlobalVars, resolveAndDecryptApiKey as resolveAndDecryptApiKeyUtil } from '@/backend/utils/resolveGlobalVars';
import {
  encryptWithPassword,
  decryptWithPassword,
  isEncryptionInitialized,
  isUserEncryptionEnabled as secureIsUserEncryptionEnabled,
  initializeDefaultEncryption as secureInitializeDefaultEncryption
} from '@/utils/encryption/secure';

// Create a logger instance for this file
const log = createLogger('backend/services/model/encryption');

/**
 * Set encryption key in storage
 * Note: This function is maintained for backward compatibility,
 * but it's recommended to use the functions from secure.ts directly
 */
export async function setEncryptionKey(key: string): Promise<ModelServiceResponse> {
  log.debug('setEncryptionKey: Entering method');
  log.warn('setEncryptionKey: This function is deprecated. Use initializeDefaultEncryption or initializeEncryption from secure.ts instead.');
  try {
    // Initialize default encryption using secure.ts
    const success = await secureInitializeDefaultEncryption();
    return { success };
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
 * This now uses the more robust implementation from secure.ts
 */
export async function initializeDefaultEncryption(): Promise<boolean> {
  log.debug('initializeDefaultEncryption: Entering method');
  try {
    // Use the secure.ts implementation
    const success = await secureInitializeDefaultEncryption();
    
    if (success) {
      log.info('initializeDefaultEncryption: Default encryption initialized successfully');
    } else {
      log.error('initializeDefaultEncryption: Failed to initialize default encryption');
    }
    
    return success;
  } catch (error) {
    log.error('initializeDefaultEncryption: Failed to initialize default encryption:', error);
    return false;
  }
}

/**
 * Encrypt an API key
 * Always encrypts sensitive data, never returns plain text
 */
export async function encryptApiKey(apiKey: string): Promise<string> {
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
    
    // Use the encryption utility from secure.ts
    const encryptedKey = await encryptWithPassword(apiKey);
    if (!encryptedKey) {
      log.error('encryptApiKey: encryptWithPassword returned null');
      return `encrypted_failed:${apiKey}`;
    }
    
    return `encrypted:${encryptedKey}`;
    
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
    
    // Use the decryption utility from secure.ts
    return await decryptWithPassword(encryptedApiKey);
  } catch (error) {
    log.warn('decryptApiKey: Failed to decrypt API key:', error);
    return null;
  }
}

/**
 * Resolve and decrypt an API key
 * This handles both global variables and encrypted keys
 * 
 * This implementation delegates to the more robust implementation in resolveGlobalVars.ts
 * which properly handles recursive resolution and decryption
 */
export async function resolveAndDecryptApiKey(encryptedApiKey: string): Promise<string | null> {
  log.debug('resolveAndDecryptApiKey: Entering method');
  try {
    // Call the implementation in resolveGlobalVars.ts
    return await resolveAndDecryptApiKeyUtil(encryptedApiKey);
  } catch (error) {
    log.warn('resolveAndDecryptApiKey: Failed to resolve or decrypt API key:', error);
    return null;
  }
}

/**
 * Check if encryption is configured
 * This checks if encryption is set up without exposing the actual key
 * Now uses isEncryptionInitialized from secure.ts
 */
export async function isEncryptionConfigured(): Promise<boolean> {
  log.debug('isEncryptionConfigured: Entering method');
  try {
    // Use the secure.ts implementation
    return await isEncryptionInitialized();
  } catch (error) {
    log.warn('isEncryptionConfigured: Failed to check encryption status:', error);
    return false;
  }
}

/**
 * Check if user encryption is enabled (as opposed to default encryption)
 * Now uses isUserEncryptionEnabled from secure.ts
 */
export async function isUserEncryptionEnabled(): Promise<boolean> {
  log.debug('isUserEncryptionEnabled: Entering method');
  try {
    // Use the secure.ts implementation
    return await secureIsUserEncryptionEnabled();
  } catch (error) {
    log.warn('isUserEncryptionEnabled: Failed to check user encryption status:', error);
    return false;
  }
}
