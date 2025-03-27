import { resolveGlobalVars, resolveAndDecryptApiKey } from '../resolveGlobalVars';
import { loadItem } from '@/utils/storage/backend';
import { decryptWithPassword } from '@/utils/encryption/secure';
import { StorageKey } from '@/shared/types/storage';

// Mock dependencies
jest.mock('@/utils/storage/backend');
jest.mock('@/utils/encryption/secure');
jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    verbose: jest.fn(),
  })),
}));

describe('resolveGlobalVars', () => {
  // Reset all mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
    
    // Default mock implementation that won't cause recursion
    (loadItem as jest.Mock).mockResolvedValue({});
    (decryptWithPassword as jest.Mock).mockResolvedValue('decrypted-value');
  });

  test('should handle empty values', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({});

    // Execute
    const result = await resolveGlobalVars('');

    // Verify
    expect(result).toBe('');
    expect(loadItem).toHaveBeenCalledWith(StorageKey.GLOBAL_ENV_VARS, {});
  });

  test('should handle values without variables', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({});

    // Execute
    const result = await resolveGlobalVars('plain text');

    // Verify
    expect(result).toBe('plain text');
  });

  test('should resolve global variables in old format', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      API_KEY: 'test-api-key',
      SECRET: 'secret-value',
    });

    // Execute
    const result = await resolveGlobalVars('API Key: ${global:API_KEY}, Secret: ${global:SECRET}');

    // Verify
    expect(result).toBe('API Key: test-api-key, Secret: secret-value');
  });

  test('should resolve global variables in new format', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      API_KEY: { value: 'test-api-key', metadata: { isSecret: false } },
      SECRET: { value: 'secret-value', metadata: { isSecret: true } },
    });

    // Execute
    const result = await resolveGlobalVars('API Key: ${global:API_KEY}, Secret: ${global:SECRET}');

    // Verify
    expect(result).toBe('API Key: test-api-key, Secret: secret-value');
  });

  test('should handle encrypted global variables', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      ENCRYPTED_KEY: 'encrypted:someEncryptedValue',
    });
    (decryptWithPassword as jest.Mock).mockResolvedValue('decrypted-value');

    // Execute
    const result = await resolveGlobalVars('Encrypted: ${global:ENCRYPTED_KEY}');

    // Verify
    expect(result).toBe('Encrypted: decrypted-value');
    expect(decryptWithPassword).toHaveBeenCalledWith('someEncryptedValue');
  });

  test('should handle failed encrypted variables', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      FAILED_KEY: 'encrypted_failed:failedValue',
    });

    // Execute
    const result = await resolveGlobalVars('Failed: ${global:FAILED_KEY}');

    // Verify
    expect(result).toBe('Failed: ${global:FAILED_KEY}');
  });

  test('should handle decryption failures', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      ENCRYPTED_KEY: 'encrypted:someEncryptedValue',
    });
    (decryptWithPassword as jest.Mock).mockResolvedValue(null);

    // Execute
    const result = await resolveGlobalVars('Encrypted: ${global:ENCRYPTED_KEY}');

    // Verify
    expect(result).toBe('Encrypted: ${global:ENCRYPTED_KEY}');
  });

  test('should handle nested global variables', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      OUTER: 'value with ${global:INNER}',
      INNER: 'inner-value',
    });

    // Execute
    const result = await resolveGlobalVars('Nested: ${global:OUTER}');

    // Verify
    expect(result).toBe('Nested: value with inner-value');
  });

  test('should resolve variables in object properties', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      API_KEY: 'test-api-key',
    });

    // Execute
    const result = await resolveGlobalVars({
      name: 'My API',
      key: '${global:API_KEY}',
      config: {
        url: 'https://api.example.com?key=${global:API_KEY}',
      },
    });

    // Verify
    expect(result).toEqual({
      name: 'My API',
      key: 'test-api-key',
      config: {
        url: 'https://api.example.com?key=test-api-key',
      },
    });
  });

  test('should resolve variables in arrays', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      API_KEY: 'test-api-key',
      SECRET: 'secret-value',
    });

    // Execute
    const result = await resolveGlobalVars([
      'Static value',
      '${global:API_KEY}',
      { value: '${global:SECRET}' },
    ]);

    // Verify
    expect(result).toEqual([
      'Static value',
      'test-api-key',
      { value: 'secret-value' },
    ]);
  });

  test('should resolve env variables from current context', async () => {
    // Setup
    (loadItem as jest.Mock).mockResolvedValue({
      GLOBAL_VAR: 'global-value',
    });

    // Execute
    const result = await resolveGlobalVars({
      text: 'Local: ${LOCAL_VAR}, Global: ${global:GLOBAL_VAR}',
      env: {
        LOCAL_VAR: 'local-value',
      },
    });

    // Verify
    expect(result).toEqual({
      text: 'Local: local-value, Global: global-value',
      env: {
        LOCAL_VAR: 'local-value',
      },
    });
  });
});

describe('resolveAndDecryptApiKey', () => {
  // Reset all mocks before each test
  beforeEach(() => {
    jest.clearAllMocks();
    (decryptWithPassword as jest.Mock).mockResolvedValue('decrypted-value');
    (loadItem as jest.Mock).mockResolvedValue({});
  });

  test('should handle empty values', async () => {
    // Execute
    const result = await resolveAndDecryptApiKey('');

    // Verify
    expect(result).toBeNull();
  });

  test('should decrypt encrypted values', async () => {
    // Setup
    (decryptWithPassword as jest.Mock).mockResolvedValue('decrypted-value');

    // Execute
    const result = await resolveAndDecryptApiKey('encrypted:someEncryptedValue');

    // Verify
    expect(result).toBe('decrypted-value');
    expect(decryptWithPassword).toHaveBeenCalledWith('someEncryptedValue');
  });

  test('should handle decryption failures', async () => {
    // Setup
    (decryptWithPassword as jest.Mock).mockResolvedValue(null);

    // Execute
    const result = await resolveAndDecryptApiKey('encrypted:someEncryptedValue');

    // Verify
    expect(result).toBeNull();
  });

  test('should handle failed encrypted values', async () => {
    // Execute
    const result = await resolveAndDecryptApiKey('encrypted_failed:failedValue');

    // Verify
    expect(result).toBe('failedValue');
  });

  test('should resolve global variables after decryption', async () => {
    // Setup - Avoid recursion by using simple string replacement
    (decryptWithPassword as jest.Mock).mockResolvedValue('key with ${global:VAR}');
    (loadItem as jest.Mock).mockResolvedValue({
      VAR: 'resolved-value',
    });

    // Execute
    const result = await resolveAndDecryptApiKey('encrypted:someEncryptedValue');

    // Verify
    expect(result).toBe('key with resolved-value');
  });

  test('should handle maximum depth recursion', async () => {
    // Setup - Return a simple string instead of causing infinite recursion
    (decryptWithPassword as jest.Mock).mockResolvedValue('encrypted:next-value');
    
    // Execute - This should reach the maximum depth limit
    const result = await resolveAndDecryptApiKey('encrypted:start', 9);

    // Verify - After hitting the depth limit, it should return the last value
    expect(result).toBe('encrypted:next-value');
  });
}); 