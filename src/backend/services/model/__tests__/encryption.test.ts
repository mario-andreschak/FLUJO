import { 
  encryptApiKey, 
  decryptApiKey, 
  resolveAndDecryptApiKey,
  initializeDefaultEncryption,
  isEncryptionConfigured,
  isUserEncryptionEnabled,
  setEncryptionKey
} from '../encryption';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import * as secureUtils from '@/utils/encryption/secure';
import * as resolveGlobalVarsUtils from '@/backend/utils/resolveGlobalVars';

// Mock dependencies
jest.mock('@/utils/storage/backend');
jest.mock('@/utils/encryption/secure', () => ({
  encryptWithPassword: jest.fn(),
  decryptWithPassword: jest.fn(),
  isEncryptionInitialized: jest.fn(),
  isUserEncryptionEnabled: jest.fn(),
  initializeDefaultEncryption: jest.fn(),
}));
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(),
  resolveAndDecryptApiKey: jest.fn(),
}));
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('Model Encryption', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isEncryptionConfigured', () => {
    test('should return true when encryption is initialized', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(true);
      
      // Execute
      const result = await isEncryptionConfigured();
      
      // Verify
      expect(result).toBe(true);
      expect(secureUtils.isEncryptionInitialized).toHaveBeenCalled();
    });
    
    test('should return false when encryption is not initialized', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(false);
      
      // Execute
      const result = await isEncryptionConfigured();
      
      // Verify
      expect(result).toBe(false);
    });
  });

  describe('isUserEncryptionEnabled', () => {
    test('should return true when user encryption is enabled', async () => {
      // Setup
      (secureUtils.isUserEncryptionEnabled as jest.Mock).mockResolvedValue(true);
      
      // Execute
      const result = await isUserEncryptionEnabled();
      
      // Verify
      expect(result).toBe(true);
      expect(secureUtils.isUserEncryptionEnabled).toHaveBeenCalled();
    });
    
    test('should return false when user encryption is not enabled', async () => {
      // Setup
      (secureUtils.isUserEncryptionEnabled as jest.Mock).mockResolvedValue(false);
      
      // Execute
      const result = await isUserEncryptionEnabled();
      
      // Verify
      expect(result).toBe(false);
    });
  });

  describe('initializeDefaultEncryption', () => {
    test('should initialize default encryption', async () => {
      // Setup
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(true);
      
      // Execute
      const result = await initializeDefaultEncryption();
      
      // Verify
      expect(result).toBe(true);
      expect(secureUtils.initializeDefaultEncryption).toHaveBeenCalled();
    });
    
    test('should handle initialization failures', async () => {
      // Setup
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(false);
      
      // Execute
      const result = await initializeDefaultEncryption();
      
      // Verify
      expect(result).toBe(false);
    });

    test('should handle errors during initialization', async () => {
      // Setup
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockRejectedValue(new Error('Initialization error'));
      
      // Execute
      const result = await initializeDefaultEncryption();
      
      // Verify
      expect(result).toBe(false);
    });
  });

  describe('setEncryptionKey', () => {
    test('should initialize default encryption and return success', async () => {
      // Setup
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(true);
      
      // Execute
      const result = await setEncryptionKey('test-key');
      
      // Verify
      expect(result).toEqual({ success: true });
      expect(secureUtils.initializeDefaultEncryption).toHaveBeenCalled();
    });
    
    test('should handle initialization failures', async () => {
      // Setup
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(false);
      
      // Execute
      const result = await setEncryptionKey('test-key');
      
      // Verify
      expect(result).toEqual({ success: false });
    });

    test('should handle errors', async () => {
      // Setup
      const error = new Error('Test error');
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockRejectedValue(error);
      
      // Execute
      const result = await setEncryptionKey('test-key');
      
      // Verify
      expect(result).toEqual({ 
        success: false, 
        error: 'Test error' 
      });
    });
  });

  describe('encryptApiKey', () => {
    test('should encrypt API key when encryption is already configured', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(true);
      (secureUtils.encryptWithPassword as jest.Mock).mockResolvedValue('encrypted-data');
      
      // Execute
      const result = await encryptApiKey('test-api-key');
      
      // Verify
      expect(result).toBe('encrypted:encrypted-data');
      expect(secureUtils.encryptWithPassword).toHaveBeenCalledWith('test-api-key');
    });
    
    test('should initialize encryption if not already configured', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(false);
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(true);
      (secureUtils.encryptWithPassword as jest.Mock).mockResolvedValue('encrypted-data');
      
      // Execute
      const result = await encryptApiKey('test-api-key');
      
      // Verify
      expect(result).toBe('encrypted:encrypted-data');
      expect(secureUtils.initializeDefaultEncryption).toHaveBeenCalled();
    });
    
    test('should handle empty API keys', async () => {
      // Execute
      const result = await encryptApiKey('');
      
      // Verify
      expect(result).toBe('');
    });
    
    test('should handle initialization failures', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(false);
      (secureUtils.initializeDefaultEncryption as jest.Mock).mockResolvedValue(false);
      
      // Execute
      const result = await encryptApiKey('test-api-key');
      
      // Verify
      expect(result).toBe('encrypted_failed:test-api-key');
    });
    
    test('should handle encryption failures', async () => {
      // Setup
      (secureUtils.isEncryptionInitialized as jest.Mock).mockResolvedValue(true);
      (secureUtils.encryptWithPassword as jest.Mock).mockResolvedValue(null);
      
      // Execute
      const result = await encryptApiKey('test-api-key');
      
      // Verify
      expect(result).toBe('encrypted_failed:test-api-key');
    });
  });

  describe('decryptApiKey', () => {
    test('should decrypt API key', async () => {
      // Setup
      (secureUtils.decryptWithPassword as jest.Mock).mockResolvedValue('decrypted-key');
      
      // Execute
      const result = await decryptApiKey('encrypted-data');
      
      // Verify
      expect(result).toBe('decrypted-key');
      expect(secureUtils.decryptWithPassword).toHaveBeenCalledWith('encrypted-data');
    });
    
    test('should handle global variable references', async () => {
      // Setup
      (resolveGlobalVarsUtils.resolveGlobalVars as jest.Mock).mockResolvedValue({
        key: 'resolved-value'
      });
      
      // Execute
      const result = await decryptApiKey('${global:API_KEY}');
      
      // Verify
      expect(result).toBe('resolved-value');
      expect(resolveGlobalVarsUtils.resolveGlobalVars).toHaveBeenCalledWith({
        key: '${global:API_KEY}'
      });
    });
    
    test('should handle failed encryption markers', async () => {
      // Execute
      const result = await decryptApiKey('encrypted_failed:original-key');
      
      // Verify
      expect(result).toBe('original-key');
    });
    
    test('should handle decryption failures', async () => {
      // Setup
      (secureUtils.decryptWithPassword as jest.Mock).mockResolvedValue(null);
      
      // Execute
      const result = await decryptApiKey('encrypted-data');
      
      // Verify
      expect(result).toBeNull();
    });
    
    test('should handle errors', async () => {
      // Setup
      (secureUtils.decryptWithPassword as jest.Mock).mockRejectedValue(new Error('Decryption error'));
      
      // Execute
      const result = await decryptApiKey('encrypted-data');
      
      // Verify
      expect(result).toBeNull();
    });
  });

  describe('resolveAndDecryptApiKey', () => {
    test('should delegate to the utility function', async () => {
      // Setup
      (resolveGlobalVarsUtils.resolveAndDecryptApiKey as jest.Mock).mockResolvedValue('resolved-value');
      
      // Execute
      const result = await resolveAndDecryptApiKey('encrypted:data');
      
      // Verify
      expect(result).toBe('resolved-value');
      expect(resolveGlobalVarsUtils.resolveAndDecryptApiKey).toHaveBeenCalledWith('encrypted:data');
    });
    
    test('should handle errors', async () => {
      // Setup
      (resolveGlobalVarsUtils.resolveAndDecryptApiKey as jest.Mock).mockRejectedValue(
        new Error('Resolution error')
      );
      
      // Execute
      const result = await resolveAndDecryptApiKey('encrypted:data');
      
      // Verify
      expect(result).toBeNull();
    });
  });
});