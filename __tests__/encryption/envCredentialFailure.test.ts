import { StorageKey } from '@/shared/types/storage';
import { makeLocalRequest } from '../utils/localRequest';

const store = new Map<string, unknown>();
const mockEncrypt = jest.fn<Promise<string | null>, [string]>();
const mockInitialized = jest.fn<Promise<boolean>, []>();
const mockInitialize = jest.fn<Promise<boolean>, []>();
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, value: unknown) => { store.set(key, value); }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => store.get(key) ?? fallback),
}));
jest.mock('@/utils/encryption/secure', () => ({
  encryptWithPassword: (...args: [string]) => mockEncrypt(...args),
  isEncryptionInitialized: () => mockInitialized(),
  initializeDefaultEncryption: () => mockInitialize(),
  decryptWithPassword: async () => null,
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: async () => null }));

import { saveItem } from '@/utils/storage/backend';
import { POST } from '@/app/api/env/route';

const previous = {
  API_TOKEN: { value: 'encrypted:previous-ciphertext', metadata: { isSecret: true } },
  LABEL: { value: 'original label', metadata: { isSecret: false } },
};
const fakeSecret = 'FAKE_TEST_ONLY_NEW_SECRET';
type Action = 'set' | 'setAll';

function request(action: Action) {
  const credential = { value: fakeSecret, metadata: { isSecret: true } };
  return makeLocalRequest({
    url: 'http://localhost:4200/api/env',
    body: action === 'set'
      ? { action, key: 'API_TOKEN', ...credential }
      : { action, variables: {
        LABEL: { value: 'changed label', metadata: { isSecret: false } },
        FIRST_TOKEN: { value: 'FAKE_TEST_ONLY_FIRST_SECRET', metadata: { isSecret: true } },
        API_TOKEN: credential,
      } },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  store.set(StorageKey.GLOBAL_ENV_VARS, structuredClone(previous));
  mockEncrypt.mockReset().mockResolvedValue('v2:authenticated-ciphertext');
  mockInitialized.mockReset().mockResolvedValue(true);
  mockInitialize.mockReset().mockResolvedValue(true);
});

describe.each<Action>(['set', 'setAll'])('%s environment variables', (action) => {
  it.each(['null', 'exception'])('preserves the entire old record on encryption %s', async (failure) => {
    // In a batch, fail only after a non-secret and an earlier secret were processed.
    if (action === 'setAll') mockEncrypt.mockResolvedValueOnce('v2:first-ciphertext');
    if (failure === 'null') mockEncrypt.mockResolvedValueOnce(null);
    else mockEncrypt.mockRejectedValueOnce(new Error(`simulated failure involving ${fakeSecret}`));

    const response = await POST(request(action));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toContain('no variables were saved');
    expect(JSON.stringify(body)).not.toContain(fakeSecret);
    expect(saveItem).not.toHaveBeenCalled();
    expect(store.get(StorageKey.GLOBAL_ENV_VARS)).toEqual(previous);
    expect(JSON.stringify(store.get(StorageKey.GLOBAL_ENV_VARS))).not.toContain('encrypted_failed:');
  });

  it('aborts before encrypting or saving when initialization fails', async () => {
    mockInitialized.mockResolvedValue(false);
    mockInitialize.mockResolvedValue(false);

    const response = await POST(request(action));
    expect(response.status).toBe(500);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(saveItem).not.toHaveBeenCalled();
    expect(store.get(StorageKey.GLOBAL_ENV_VARS)).toEqual(previous);
  });

  it('persists encrypted values only after all requested secrets succeed', async () => {
    const response = await POST(request(action));
    expect(response.status).toBe(200);
    expect(saveItem).toHaveBeenCalledTimes(1);
    expect(store.get(StorageKey.GLOBAL_ENV_VARS)).toMatchObject({
      API_TOKEN: { value: 'encrypted:v2:authenticated-ciphertext', metadata: { isSecret: true } },
    });
    const stored = JSON.stringify(store.get(StorageKey.GLOBAL_ENV_VARS));
    expect(stored).not.toContain(fakeSecret);
    expect(stored).not.toContain('FAKE_TEST_ONLY_FIRST_SECRET');
    expect(stored).not.toContain('encrypted_failed:');
  });
});
