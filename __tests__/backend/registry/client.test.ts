/**
 * Base-URL resolution precedence for the package-registry client (issue #197):
 *   FLUJO_REGISTRY_BASE_URL env  >  stored REGISTRY_SETTINGS.baseUrl  >  default.
 *
 * The storage boundary is mocked so this exercises resolution in isolation.
 */
const loadItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...a: unknown[]) => loadItemMock(...a),
}));

import { resolveRegistryBaseUrl } from '@/backend/utils/packageRegistryClient';
import { DEFAULT_REGISTRY_URL } from '@/shared/types/registry';

const ENV_KEY = 'FLUJO_REGISTRY_BASE_URL';

describe('resolveRegistryBaseUrl (#197)', () => {
  const original = process.env[ENV_KEY];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env[ENV_KEY];
    loadItemMock.mockResolvedValue({});
  });

  afterAll(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('prefers the env var and strips a trailing slash', async () => {
    process.env[ENV_KEY] = 'https://env.example.com/';
    await expect(resolveRegistryBaseUrl()).resolves.toBe('https://env.example.com');
    // Env wins outright — storage is not consulted.
    expect(loadItemMock).not.toHaveBeenCalled();
  });

  it('falls back to the stored settings baseUrl', async () => {
    loadItemMock.mockResolvedValue({ baseUrl: 'https://stored.example.com/' });
    await expect(resolveRegistryBaseUrl()).resolves.toBe('https://stored.example.com');
  });

  it('falls back to the hardcoded default when nothing is configured', async () => {
    loadItemMock.mockResolvedValue({});
    await expect(resolveRegistryBaseUrl()).resolves.toBe(DEFAULT_REGISTRY_URL.replace(/\/+$/, ''));
  });
});
