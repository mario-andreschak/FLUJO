import { StorageKey } from '@/shared/types/storage';
import { MASKED_API_KEY } from '@/shared/types/constants';
import type { Model } from '@/shared/types/model';

const store = new Map<string, unknown>();
const mockEncrypt = jest.fn<Promise<string | null>, [string]>();
const mockInitialized = jest.fn<Promise<boolean>, []>();
const mockInitialize = jest.fn<Promise<boolean>, []>();
const mockLogin = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => store.get(key) ?? fallback),
}));
jest.mock('@/utils/encryption/secure', () => ({
  encryptWithPassword: (...args: [string]) => mockEncrypt(...args),
  isEncryptionInitialized: () => mockInitialized(),
  initializeDefaultEncryption: () => mockInitialize(),
  isUserEncryptionEnabled: async () => false,
  decryptWithPassword: async () => null,
}));
jest.mock('@/backend/utils/packageRegistryClient', () => ({ login: (...args: unknown[]) => mockLogin(...args) }));

import { saveItem } from '@/utils/storage/backend';
import { encryptApiKey } from '@/backend/services/model/encryption';
import { modelService } from '@/backend/services/model';
import { authenticate } from '@/backend/services/registry';

const original: Model = {
  id: 'existing-model', name: 'gpt-test', displayName: 'Existing model', provider: 'openai',
  ApiKey: 'encrypted:previous-ciphertext', baseUrl: 'https://api.openai.com/v1',
} as Model;

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  mockEncrypt.mockReset().mockResolvedValue('v2:authenticated-ciphertext');
  mockInitialized.mockResolvedValue(true);
  mockInitialize.mockResolvedValue(true);
});

it.each(['exception', 'null', 'initialization'])('fails closed on %s instead of returning plaintext', async (failure) => {
  if (failure === 'exception') mockEncrypt.mockRejectedValueOnce(new Error('simulated crypto failure'));
  if (failure === 'null') mockEncrypt.mockResolvedValueOnce(null);
  if (failure === 'initialization') { mockInitialized.mockResolvedValue(false); mockInitialize.mockResolvedValue(false); }
  await expect(encryptApiKey('FAKE_TEST_ONLY_SECRET')).rejects.toThrow('Credential encryption failed');
  expect(saveItem).not.toHaveBeenCalled();
});

it('retains the old model and key when a replacement cannot be encrypted', async () => {
  store.set(StorageKey.MODELS, [{ ...original }]);
  mockEncrypt.mockRejectedValueOnce(new Error('simulated crypto failure'));
  const result = await modelService.updateModel({ ...original, ApiKey: 'new-secret', displayName: 'Changed' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('previous credential has been retained');
  expect(saveItem).not.toHaveBeenCalled();
  expect(store.get(StorageKey.MODELS)).toEqual([original]);
});

it('re-encrypts a historical failure-marked key only on an explicit record save', async () => {
  store.set(StorageKey.MODELS, [{ ...original, ApiKey: 'encrypted_failed:legacy-secret' }]);
  const result = await modelService.updateModel({ ...original, ApiKey: MASKED_API_KEY });
  expect(result.success).toBe(true);
  expect(mockEncrypt).toHaveBeenCalledWith('legacy-secret');
  expect(JSON.stringify(store.get(StorageKey.MODELS))).not.toContain('legacy-secret');
  expect(JSON.stringify(store.get(StorageKey.MODELS))).not.toContain('encrypted_failed:');
});

it('retains the previous registry account when the second token cannot be encrypted', async () => {
  const previous = { email: 'old@example.test', accessToken: 'encrypted:old-access', refreshToken: 'encrypted:old-refresh' };
  store.set(StorageKey.REGISTRY_ACCOUNT, previous);
  mockLogin.mockResolvedValue({ status: 200, body: { access_token: 'new-access', refresh_token: 'new-refresh' } });
  mockEncrypt.mockResolvedValueOnce('v2:encrypted-access').mockRejectedValueOnce(new Error('simulated failure'));
  await expect(authenticate('new@example.test', 'password', 'login')).rejects.toThrow('Credential encryption failed');
  expect(saveItem).not.toHaveBeenCalled();
  expect(store.get(StorageKey.REGISTRY_ACCOUNT)).toEqual(previous);
});
