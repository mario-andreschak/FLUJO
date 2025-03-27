/**
 * @jest-environment node
 */
import { 
  encrypt, 
  decrypt,
  encryptApiKey,
  decryptApiKey
} from '../index';

// Mock secure.ts module imports
jest.mock('../secure', () => ({
  encryptWithPassword: jest.fn(async (value) => `encrypted:${value}`),
  decryptWithPassword: jest.fn(async (encrypted) => {
    if (encrypted === 'encrypted:test-value') {
      return 'test-value';
    }
    if (encrypted === 'invalid-encrypted') {
      return null;
    }
    return encrypted.replace('encrypted:', '');
  }),
  initializeDefaultEncryption: jest.fn(async () => true),
  isEncryptionInitialized: jest.fn(async () => true)
}));

// Mock import in encryptApiKey and decryptApiKey functions
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('Encryption Utilities', () => {
  test('should export encryption functions', () => {
    expect(encrypt).toBeDefined();
    expect(decrypt).toBeDefined();
    expect(encryptApiKey).toBeDefined();
    expect(decryptApiKey).toBeDefined();
  });
});

describe('Encryption index functions', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('encryptApiKey', () => {
    it('should encrypt a string value', async () => {
      const value = 'test-value';
      const result = await encryptApiKey(value);
      expect(result).toBe('encrypted:test-value');
    });

    it('should encrypt with a specific key when provided', async () => {
      const value = 'test-value';
      const key = 'custom-key';
      const result = await encryptApiKey(value, key);
      expect(result).toBe('encrypted:test-value');
    });

    it('should handle encryption failures by returning prefixed string', async () => {
      // Mock a failure
      const mockSecure = require('../secure');
      mockSecure.encryptWithPassword.mockImplementationOnce(() => null);
      
      const value = 'test-value';
      const result = await encryptApiKey(value);
      expect(result).toBe('encrypted_failed:test-value');
    });

    it('should initialize encryption if not already initialized', async () => {
      // Mock encryption not initialized
      const mockSecure = require('../secure');
      mockSecure.isEncryptionInitialized.mockResolvedValueOnce(false);
      
      const value = 'test-value';
      await encryptApiKey(value);
      
      expect(mockSecure.initializeDefaultEncryption).toHaveBeenCalled();
    });

    it('should handle exceptions during encryption', async () => {
      // Force an exception
      const mockSecure = require('../secure');
      mockSecure.encryptWithPassword.mockImplementationOnce(() => {
        throw new Error('Encryption error');
      });
      
      const value = 'test-value';
      const result = await encryptApiKey(value);
      expect(result).toBe('encrypted_failed:test-value');
    });
  });

  describe('decryptApiKey', () => {
    it('should decrypt an encrypted string', async () => {
      const encrypted = 'encrypted:test-value';
      const result = await decryptApiKey(encrypted);
      expect(result).toBe('test-value');
    });

    it('should decrypt with a specific key when provided', async () => {
      const encrypted = 'encrypted:test-value';
      const key = 'custom-key';
      const result = await decryptApiKey(encrypted, key);
      expect(result).toBe('test-value');
    });

    it('should return the original value for global variable references', async () => {
      const globalVar = '${global:API_KEY}';
      const result = await decryptApiKey(globalVar);
      expect(result).toBe(globalVar);
    });

    it('should handle decryption failures by returning asterisks', async () => {
      const encrypted = 'invalid-encrypted';
      const result = await decryptApiKey(encrypted);
      expect(result).toBe('********');
    });

    it('should handle encrypted_failed values by returning asterisks', async () => {
      const failed = 'encrypted_failed:value';
      const result = await decryptApiKey(failed);
      expect(result).toBe('********');
    });

    it('should handle exceptions by returning asterisks', async () => {
      // Force an exception
      const mockSecure = require('../secure');
      mockSecure.decryptWithPassword.mockImplementationOnce(() => {
        throw new Error('Decryption error');
      });
      
      const encrypted = 'encrypted:test-value';
      const result = await decryptApiKey(encrypted);
      expect(result).toBe('********');
    });

    it('should handle undefined or empty values', async () => {
      // Test with undefined value
      const result1 = await decryptApiKey(undefined as any);
      expect(result1).toBe('********');
      
      // Test with empty string
      const result2 = await decryptApiKey('');
      expect(result2).toBe('********');
    });

    it('should handle null result from decryptWithPassword', async () => {
      const mockSecure = require('../secure');
      mockSecure.decryptWithPassword.mockResolvedValueOnce(null);
      
      const encrypted = 'some-encrypted-value';
      const result = await decryptApiKey(encrypted);
      expect(result).toBe('********');
    });
  });
});
