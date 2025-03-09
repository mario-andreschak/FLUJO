import { createLogger } from '@/utils/logger';

// Create a logger instance for this file
const log = createLogger('utils/encryption/index');

// Re-export the secure encryption functions
export {
  encryptWithPassword as encrypt,
  decryptWithPassword as decrypt,
  initializeEncryption,
  initializeDefaultEncryption,
  changeEncryptionPassword,
  verifyPassword,
  isEncryptionInitialized,
  isUserEncryptionEnabled,
  getEncryptionType
} from './secure';

// Compatibility functions for API key encryption
export async function encryptApiKey(value: string, key?: string): Promise<string> {
  log.debug('encryptApiKey: Entering method');
  try {
    const { encryptWithPassword, initializeDefaultEncryption, isEncryptionInitialized } = await import('./secure');
    
    // Ensure encryption is initialized
    const initialized = await isEncryptionInitialized();
    if (!initialized) {
      await initializeDefaultEncryption();
    }
    
    const result = await encryptWithPassword(value, key);
    if (result === null) {
      throw new Error('Encryption failed');
    }
    
    return result;
  } catch (error) {
    log.error('encryptApiKey: Failed to encrypt API key:', error);
    // Instead of returning plain text, prefix with 'encrypted:' to indicate it should be encrypted
    // This will help identify values that failed encryption but should be encrypted
    return `encrypted_failed:${value}`;
  }
}

export async function decryptApiKey(encryptedValue: string, key?: string): Promise<string> {
  log.debug('decryptApiKey: Entering method');
  try {
    // Check if this is a global variable reference
    if (encryptedValue && encryptedValue.startsWith('${global:')) {
      return encryptedValue; // Return as is, it will be resolved at runtime
    }
    
    // Check if this is a failed encryption marker
    if (encryptedValue && encryptedValue.startsWith('encrypted_failed:')) {
      // Return asterisks for security
      return '********';
    }
    
    const { decryptWithPassword } = await import('./secure');
    const result = await decryptWithPassword(encryptedValue, key);
    
    if (result === null) {
      // Return the encrypted value for UI display
      return '********';
    }
    
    return result;
  } catch (error) {
    log.error('decryptApiKey: Failed to decrypt API key:', error);
    // Return asterisks for security instead of the original encrypted value
    return '********';
  }
}
