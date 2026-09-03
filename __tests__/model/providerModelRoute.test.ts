jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(),
}));

jest.mock('@/app/api/model/backend-provider-adapter', () => ({
  fetchProviderModels: jest.fn(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    verbose: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import { POST } from '@/app/api/model/provider/route';

const mockAssertUnlocked =
  (jest.requireMock('@/utils/encryption/lockGate') as { assertUnlocked: jest.Mock })
    .assertUnlocked;
const mockFetchProviderModels =
  (jest.requireMock('@/app/api/model/backend-provider-adapter') as {
    fetchProviderModels: jest.Mock;
  }).fetchProviderModels;

const invoke = (body: unknown): Promise<Response> =>
  (POST as unknown as (request: { json: () => Promise<unknown> }) => Promise<Response>)({
    json: async () => body,
  });

describe('provider model discovery route', () => {
  beforeEach(() => {
    mockAssertUnlocked.mockReset().mockResolvedValue(null);
    mockFetchProviderModels.mockReset().mockResolvedValue([]);
  });

  it('accepts validated native Gemini discovery without a base URL', async () => {
    const response = await invoke({
      baseUrl: '',
      modelId: 'draft-id',
      apiKey: 'secret',
      profileId: 'gemini-native',
    });

    expect(response.status).toBe(200);
    expect(mockFetchProviderModels).toHaveBeenCalledWith(
      '',
      'draft-id',
      undefined,
      'secret',
      'gemini-native',
    );
  });

  it('rejects an arbitrary discovery profile', async () => {
    const response = await invoke({
      baseUrl: '',
      profileId: 'user-supplied-native-provider',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Unsupported provider discovery profile',
    });
    expect(mockFetchProviderModels).not.toHaveBeenCalled();
  });

  it('continues requiring a base URL for URL-based discovery', async () => {
    const response = await invoke({ profileId: 'openai' });

    expect(response.status).toBe(400);
    expect(mockFetchProviderModels).not.toHaveBeenCalled();
  });

  it('bounds provider search input before calling the backend', async () => {
    const response = await invoke({
      baseUrl: 'https://api.openai.com/v1',
      profileId: 'openai',
      searchTerm: 'x'.repeat(201),
    });

    expect(response.status).toBe(400);
    expect(mockFetchProviderModels).not.toHaveBeenCalled();
  });
});
