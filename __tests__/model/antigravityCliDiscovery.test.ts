import { fetchAntigravityCliModels, inspectAntigravityRuntime, normalizeAntigravityCatalog } from '@/backend/services/model/adapters/antigravityCliDiscovery';
import { modelCache } from '@/backend/services/model/cache';
import { prepareAntigravityCliRuntime } from '@/backend/services/model/adapters/antigravityCliRuntime';
import { readAntigravityCliCommand } from '@/backend/services/model/adapters/antigravityCliProcess';
import { readStableFile } from '@/utils/readStableFile';
jest.mock('@/backend/services/model/adapters/antigravityCliRuntime', () => ({ ANTIGRAVITY_CLI_VERSION: '1.3.3', prepareAntigravityCliRuntime: jest.fn() }));
jest.mock('@/backend/services/model/adapters/antigravityCliProcess', () => ({ readAntigravityCliCommand: jest.fn(), isAntigravityCliInstalled: jest.fn(() => true), isSupportedAntigravityVersion: jest.fn((v: string) => v === '1.3.3' || v === '1.4.2') }));
jest.mock('@/utils/readStableFile', () => ({ readStableFile: jest.fn() }));
jest.mock('@/backend/services/model/cache', () => ({ modelCache: { get: jest.fn(), set: jest.fn(), credentialFingerprint: jest.fn((s: string) => `private:${s.length}`) } }));
const cleanup = jest.fn(async () => {});
const catalog = { models: [{ id: 'custom/model', name: 'Custom model' }], entitlementVerified: false };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(prepareAntigravityCliRuntime).mockResolvedValue({ home: '/private', workingDirectory: '/private/workspace', env: {}, cleanup });
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => command === 'version' ? '1.3.3\n' : JSON.stringify(catalog));
  jest.mocked(readStableFile).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
});
test('discovery uses separate commands and keys cache by version/auth mode and credential', async () => {
  expect(await fetchAntigravityCliModels('api-key')).toMatchObject([{ id: 'custom/model' }]);
  expect(modelCache.set).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'antigravity-cli:1.3.3:api-key', credentialFingerprint: 'private:7' }), expect.any(Array));
  expect(readAntigravityCliCommand).toHaveBeenNthCalledWith(1, expect.any(Object), 'version');
  expect(readAntigravityCliCommand).toHaveBeenNthCalledWith(2, expect.any(Object), 'models');
  expect(cleanup).toHaveBeenCalledTimes(1);
});
test('keyring-only catalogs are not cached across account changes', async () => {
  await fetchAntigravityCliModels('');
  expect(modelCache.get).not.toHaveBeenCalled(); expect(modelCache.set).not.toHaveBeenCalled();
});

test('an updated official CLI supplies new model IDs and a distinct cache identity', async () => {
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => command === 'version'
    ? '1.4.2\n' : JSON.stringify({ models: [{ id: 'gemini-future-model', name: 'Future Gemini' }], entitlementVerified: false }));
  expect(await fetchAntigravityCliModels('key')).toMatchObject([{ id: 'gemini-future-model' }]);
  expect(modelCache.set).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'antigravity-cli:1.4.2:api-key' }), expect.any(Array));
  expect(await inspectAntigravityRuntime()).toMatchObject({ actualVersion: '1.4.2', verified: true });
});
test('account cache rotation participates without putting credential bytes in cache identity', async () => {
  jest.mocked(readStableFile).mockResolvedValue(Buffer.from('synthetic-account-cache'));
  await fetchAntigravityCliModels('');
  expect(modelCache.set).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'antigravity-cli:1.3.3:account' }), expect.any(Array));
  expect(JSON.stringify(jest.mocked(modelCache.set).mock.calls)).not.toContain('synthetic-account-cache');
});
test('changed runtime denies even a cached catalog; missing diagnostics never pass', async () => {
  jest.mocked(readAntigravityCliCommand).mockResolvedValue('1.2.13');
  await expect(fetchAntigravityCliModels('key')).rejects.toThrow(/version is unsupported/);
  expect(modelCache.get).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalled();
  jest.mocked(readAntigravityCliCommand).mockRejectedValue(new Error('private path and credential'));
  expect(await inspectAntigravityRuntime()).toEqual({ configuredVersion: '1.3.3', installed: true, verified: false, actualVersion: null });
});
test('catalog rejects drift and forged entitlement while preserving free-text custom choices', () => {
  expect(normalizeAntigravityCatalog(catalog)[0].id).toBe('custom/model');
  for (const value of [null, [], { ...catalog, entitlementVerified: true }, { models: [] }, { ...catalog, models: [{ id: 'bad\nslug', name: 'Bad' }] }]) {
    expect(() => normalizeAntigravityCatalog(value)).toThrow(/unsupported model catalog/);
  }
});
