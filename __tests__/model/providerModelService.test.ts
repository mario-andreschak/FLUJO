jest.mock('@/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    verbose: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
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
    const logger = jest.requireMock('@/utils/logger') as { createLogger: jest.Mock };
    logger.createLogger.mock.results.forEach(({ value }) => Object.values(value).forEach(fn => (fn as jest.Mock).mockClear()));
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

  it.each(['https://other.example/v1', 'https://api.openai.com/other', 'https://api.openai.com/v1//', 'http://api.openai.com/v1',
    'https://api.openai.com:8443/v1', 'https://api.openai.com/v1?account=other',
    'https://user:synthetic-secret@api.openai.com/v1', 'https://api.openai.com/v1#other'])
  ('does not resolve or forward a stored key to unsaved endpoint %s', async requested => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai' }]);
    expect(await modelService.fetchProviderModels(requested, 'saved-id', undefined, '********')).toEqual([]);
    expect(encryptionMock.resolveAndDecryptApiKey).not.toHaveBeenCalled();
    expect(providerMock.fetchModelsFromProvider).not.toHaveBeenCalled();
    expect(cacheMock.modelCache.get).not.toHaveBeenCalled();
  });

  it('refuses a changed native profile before resolving a stored HTTP credential', async () => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai' }]);
    expect(await modelService.fetchProviderModels('', 'saved-id', undefined, undefined, 'gemini-native')).toEqual([]);
    expect(encryptionMock.resolveAndDecryptApiKey).not.toHaveBeenCalled();
    expect(providerMock.fetchModelsFromProvider).not.toHaveBeenCalled();
  });

  it.each(['https://API.OPENAI.COM:443/v1/', 'https://api.openai.com/v1'])
  ('reuses the saved key at canonical matching endpoint %s', async requested => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai' }]);
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-stored-key');
    expect(await modelService.fetchProviderModels(requested, 'saved-id')).toEqual(discovered);
    expect(encryptionMock.resolveAndDecryptApiKey).toHaveBeenCalledWith('encrypted:stored-key');
    expect(providerMock.fetchModelsFromProvider).toHaveBeenCalledWith('openai', requested, 'resolved-stored-key', 'openai');
  });

  it('keeps configured local/custom-port catalogue destinations available', async () => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'http://127.0.0.1:8787/v1', provider: 'ollama', adapter: 'openai' }]);
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-stored-key');
    expect(await modelService.fetchProviderModels('http://127.0.0.1:8787/v1/', 'saved-id')).toEqual(discovered);
    expect(providerMock.fetchModelsFromProvider).toHaveBeenCalledWith('ollama', 'http://127.0.0.1:8787/v1/', 'resolved-stored-key', 'openai');
  });

  it('HTTP-compatible adapter changes at the same provider and endpoint do not move the credential destination', async () => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai' }]);
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-stored-key');
    expect(await modelService.fetchProviderModels('https://api.openai.com/v1', 'saved-id', undefined, undefined, 'openai-responses')).toEqual(discovered);
    expect(providerMock.fetchModelsFromProvider).toHaveBeenCalledWith('openai', 'https://api.openai.com/v1', 'resolved-stored-key', 'openai-responses');
  });

  it('a newly supplied key remains available for an explicitly changed destination', async () => {
    storageMock.loadItem.mockResolvedValue([{ id: 'saved-id', name: 'fixture', ApiKey: 'encrypted:stored-key',
      baseUrl: 'https://api.openai.com/v1', provider: 'openai', adapter: 'openai' }]);
    encryptionMock.resolveAndDecryptApiKey.mockResolvedValue('resolved-new-key');
    expect(await modelService.fetchProviderModels('https://new.example/v1', 'saved-id', undefined, 'new-key')).toEqual(discovered);
    expect(encryptionMock.resolveAndDecryptApiKey).toHaveBeenCalledWith('new-key');
    expect(encryptionMock.resolveAndDecryptApiKey).not.toHaveBeenCalledWith('encrypted:stored-key');
  });

  it('catalogue failure diagnostics and errors omit URL/search/upstream credential text', async () => {
    encryptionMock.resolveAndDecryptApiKey.mockRejectedValue(new Error('synthetic-key synthetic-upstream-echo'));
    await expect(modelService.fetchProviderModels('https://example.com/v1?key=synthetic-url-secret', undefined,
      'synthetic-search-secret', 'synthetic-key')).rejects.toThrow(/^Provider catalogue request failed$/);
    const logger = jest.requireMock('@/utils/logger') as { createLogger: jest.Mock };
    const diagnostics = JSON.stringify(logger.createLogger.mock.results.flatMap(({ value }) =>
      Object.values(value).flatMap(fn => (fn as jest.Mock).mock.calls)));
    for (const secret of ['synthetic-key', 'synthetic-upstream-echo', 'synthetic-url-secret', 'synthetic-search-secret']) expect(diagnostics).not.toContain(secret);
  });
});
