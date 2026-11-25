import { fetchAntigravityCliModels, inspectAntigravityRuntime, normalizeAntigravityCatalog, _clearAntigravityCatalogsForTests } from '@/backend/services/model/adapters/antigravityCliDiscovery';
import { modelCache } from '@/backend/services/model/cache';
import { prepareAntigravityCliRuntime } from '@/backend/services/model/adapters/antigravityCliRuntime';
import { readAntigravityCliCommand } from '@/backend/services/model/adapters/antigravityCliProcess';
import { readStableFile } from '@/utils/readStableFile';
jest.mock('@/backend/services/model/adapters/antigravityCliRuntime', () => ({ ANTIGRAVITY_CLI_VERSION: '1.3.3', prepareAntigravityCliRuntime: jest.fn() }));
jest.mock('@/backend/services/model/adapters/antigravityCliProcess', () => ({
  readAntigravityCliCommand: jest.fn(), isAntigravityCliInstalled: jest.fn(() => true),
  isSupportedAntigravityVersion: jest.fn((v: string) => v === '1.3.3' || v === '1.4.2'),
  // The real check text comes from bin/antigravity-runtime.cjs, as in production.
  antigravityVersionError: (version: string) => jest.requireActual<{ versionError(version: string): Error }>('../../bin/antigravity-runtime.cjs').versionError(version),
  isTransientAntigravityFailure: (error: unknown) => (error as { transient?: unknown })?.transient === true,
}));
jest.mock('@/utils/readStableFile', () => ({ readStableFile: jest.fn() }));
jest.mock('@/backend/services/model/cache', () => ({ modelCache: { get: jest.fn(), set: jest.fn(), credentialFingerprint: jest.fn((s: string) => `private:${s.length}`) } }));
const cleanup = jest.fn(async () => {});
const catalog = { models: [{ id: 'custom/model', name: 'Custom model' }], entitlementVerified: false };
beforeEach(() => {
  jest.clearAllMocks();
  _clearAntigravityCatalogsForTests();
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
  await expect(fetchAntigravityCliModels('key')).rejects.toThrow('Antigravity CLI 1.2.13 is too old for FLUJO. Run "agy update"');
  expect(modelCache.get).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalled();
  jest.mocked(readAntigravityCliCommand).mockRejectedValue(new Error('private path and credential'));
  const status = await inspectAntigravityRuntime();
  expect(status).toEqual({ configuredVersion: '1.3.3', installed: true, verified: false, actualVersion: null,
    problem: { code: 'unavailable', message: expect.stringMatching(/could not start a compatible Antigravity CLI/) } });
  expect(JSON.stringify(status)).not.toContain('private path');
});

test.each([
  ['AGY_MISSING', 'Could not install the official Antigravity CLI. Check internet access.', 'missing', undefined],
  ['AGY_OUTDATED', 'Antigravity CLI 1.2.13 is too old for FLUJO. Run "agy update".', 'outdated', '1.2.13'],
  ['AGY_UNSUPPORTED_MAJOR', 'Antigravity CLI 2.0.0 is newer than this FLUJO version supports. Update FLUJO.', 'unsupported', '2.0.0'],
  ['AGY_INCOMPATIBLE', 'This Antigravity CLI does not support the required FLUJO integration.', 'incompatible', undefined],
])('the runtime check tells the person what to do for %s', async (code, message, problem, version) => {
  jest.mocked(readAntigravityCliCommand).mockRejectedValue(Object.assign(new Error(message), { code, ...(version ? { version } : {}) }));
  expect(await inspectAntigravityRuntime()).toMatchObject({ verified: false, actualVersion: version ?? null, problem: { code: problem, message } });
});

test('a transient catalog failure retries once, then shows the last known list for the same identity', async () => {
  const transient = () => Object.assign(new Error('Antigravity model discovery timed out.'), { transient: true });
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => command === 'version' ? '1.3.3\n' : JSON.stringify(catalog));
  await fetchAntigravityCliModels('api-key');
  let attempts = 0;
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => {
    if (command === 'version') return '1.3.3\n';
    if (++attempts === 1) throw transient();
    return JSON.stringify({ models: [{ id: 'retried', name: 'Retried' }], entitlementVerified: false });
  });
  expect(await fetchAntigravityCliModels('api-key')).toMatchObject([{ id: 'retried' }]);
  expect(attempts).toBe(2);
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => { if (command === 'version') return '1.3.3\n'; throw transient(); });
  const fallback = await fetchAntigravityCliModels('api-key');
  expect(fallback).toMatchObject([{ id: 'retried', description: expect.stringMatching(/could not be loaded/) }]);
  await expect(fetchAntigravityCliModels('another-key')).rejects.toThrow(/timed out/);
  await expect(fetchAntigravityCliModels('')).rejects.toThrow(/timed out/);
});

test('a sign-in failure is never hidden behind the last known list', async () => {
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => command === 'version' ? '1.3.3\n' : JSON.stringify(catalog));
  await fetchAntigravityCliModels('api-key');
  const signIn = Object.assign(new Error('Antigravity model discovery failed. Run the official agy CLI and complete Google sign-in.'), { transient: false });
  let attempts = 0;
  jest.mocked(readAntigravityCliCommand).mockImplementation(async (_runtime, command) => { if (command === 'version') return '1.3.3\n'; attempts++; throw signIn; });
  await expect(fetchAntigravityCliModels('api-key')).rejects.toBe(signIn);
  expect(attempts).toBe(1);
});
test('catalog rejects drift and forged entitlement while preserving free-text custom choices', () => {
  expect(normalizeAntigravityCatalog(catalog)[0].id).toBe('custom/model');
  for (const value of [null, [], { ...catalog, entitlementVerified: true }, { models: [] }, { ...catalog, models: [{ id: 'bad\nslug', name: 'Bad' }] }]) {
    expect(() => normalizeAntigravityCatalog(value)).toThrow(/unsupported model catalog/);
  }
});
