jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    verbose: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(),
  saveItem: jest.fn(),
}));

jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: jest.fn(),
  decryptApiKey: jest.fn(),
  resolveAndDecryptApiKey: jest.fn(),
  isEncryptionConfigured: jest.fn(),
  isUserEncryptionEnabled: jest.fn(),
  setEncryptionKey: jest.fn(),
  initializeDefaultEncryption: jest.fn(),
}));

jest.mock('@/backend/services/model/provider', () => ({
  fetchModelsFromProvider: jest.fn(),
  getProviderFromBaseUrl: jest.fn(() => 'ollama'),
}));

jest.mock('@/backend/services/model/cache', () => ({
  modelCache: {
    get: jest.fn(),
    set: jest.fn(),
  },
  filterModels: jest.fn((models: unknown[]) => models),
}));

import { modelService } from '@/backend/services/model';

const storageMock = jest.requireMock('@/utils/storage/backend') as {
  loadItem: jest.Mock;
};
const encryptionMock = jest.requireMock('@/backend/services/model/encryption') as {
  resolveAndDecryptApiKey: jest.Mock;
};
const providerMock = jest.requireMock('@/backend/services/model/provider') as {
  fetchModelsFromProvider: jest.Mock;
};
const cacheMock = jest.requireMock('@/backend/services/model/cache') as {
  modelCache: {
    get: jest.Mock;
    set: jest.Mock;
  };
};

const discovered = [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' }];

describe('profile-aware provider model service', () => {
  beforeEach(() => {
    storageMock.loadItem.mockReset().mockResolvedValue([]);
    encryptionMock.resolveAndDecryptApiKey.mockReset();
    providerMock.fetchModelsFromProvider.mockReset().mockResolvedValue(discovered);
    cacheMock.modelCache.get.mockReset().mockReturnValue(null);
    cacheMock.modelCache.set.mockReset();
  });

  it('uses a direct unsaved key with the validated native Gemini profile', async () => {
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-direct-key');

    await expect(modelService.fetchProviderModels(
      '',
      'draft-id',
      undefined,
      'direct-key',
      'gemini-native',
    )).resolves.toEqual(discovered);

    expect(encryptionMock.resolveAndDecryptApiKey).toHaveBeenCalledWith('direct-key');
    expect(providerMock.fetchModelsFromProvider).toHaveBeenCalledWith(
      'gemini',
      '',
      'resolved-direct-key',
      'gemini',
    );

    const [identity] = cacheMock.modelCache.set.mock.calls[0];
    expect(identity).toMatchObject({
      baseUrl: '',
      provider: 'gemini',
      adapter: 'gemini',
      profileId: 'gemini-native',
    });
    expect(identity.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(identity)).not.toContain('resolved-direct-key');
  });

  it('falls back to the stored encrypted key for an existing native model', async () => {
    storageMock.loadItem.mockResolvedValue([{
      id: 'saved-id',
      name: 'gemini-3.8-flash',
      ApiKey: 'encrypted:stored-key',
      baseUrl: '',
      provider: 'gemini',
      adapter: 'gemini',
    }]);
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-stored-key');

    await modelService.fetchProviderModels(
      '',
      'saved-id',
      undefined,
      undefined,
      'gemini-native',
    );

    expect(encryptionMock.resolveAndDecryptApiKey)
      .toHaveBeenCalledWith('encrypted:stored-key');
    expect(providerMock.fetchModelsFromProvider).toHaveBeenCalledWith(
      'gemini',
      '',
      'resolved-stored-key',
      'gemini',
    );
  });

  it('does not cache an empty provider response', async () => {
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-key');
    providerMock.fetchModelsFromProvider.mockResolvedValue([]);

    await expect(modelService.fetchProviderModels(
      '',
      undefined,
      undefined,
      'direct-key',
      'gemini-native',
    )).resolves.toEqual([]);

    expect(cacheMock.modelCache.set).not.toHaveBeenCalled();
  });
});
