import { createHash } from 'node:crypto';
import {
  filterModels,
  modelCache,
  type ModelCacheIdentity,
} from '@/backend/services/model/cache';
import type { NormalizedModel } from '@/shared/types/model';

const mockLogDebug = jest.fn();
let mockWorkspace = 'catalogue-cache-workspace-a';

jest.mock('@/utils/workspace', () => ({
  getCurrentWorkspace: () => mockWorkspace,
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: (...args: unknown[]) => mockLogDebug(...args),
    verbose: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const MODELS: NormalizedModel[] = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite' },
];

const nativeIdentity = (
  credentialFingerprint: string,
  profileId = 'gemini-native',
): ModelCacheIdentity => ({
  baseUrl: '',
  provider: 'gemini',
  adapter: 'gemini',
  profileId,
  credentialFingerprint,
});

describe('provider model cache identities', () => {
  beforeEach(() => {
    mockWorkspace = 'catalogue-cache-workspace-a';
    modelCache.clearAll();
    mockLogDebug.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reuses a matching native profile and credential identity', () => {
    const identity = nativeIdentity('fingerprint-a');
    modelCache.set(identity, MODELS);

    expect(modelCache.get(identity)).toEqual(MODELS);
  });

  it('isolates empty-URL catalogues by credential and profile', () => {
    modelCache.set(nativeIdentity('fingerprint-a'), MODELS);

    expect(modelCache.get(nativeIdentity('fingerprint-b'))).toBeNull();
    expect(modelCache.get(nativeIdentity('fingerprint-a', 'another-native-profile'))).toBeNull();
  });

  it('expires entries after their TTL', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-03T12:00:00Z'));

    const identity = nativeIdentity('fingerprint-a');
    modelCache.set(identity, MODELS, 1_000);
    jest.setSystemTime(new Date('2026-09-03T12:00:01.001Z'));

    expect(modelCache.get(identity)).toBeNull();
  });

  it('reuses a resolved credential and separates changed or unauthenticated credentials', () => {
    const credential = 'SYNTHETIC-SHORT-CREDENTIAL';
    const fingerprint = modelCache.credentialFingerprint(credential);
    modelCache.set(nativeIdentity(fingerprint), MODELS);

    expect(modelCache.get(nativeIdentity(modelCache.credentialFingerprint(credential)))).toEqual(MODELS);
    expect(modelCache.get(nativeIdentity(modelCache.credentialFingerprint('SYNTHETIC-DIFFERENT-CREDENTIAL')))).toBeNull();
    expect(modelCache.get(nativeIdentity(modelCache.credentialFingerprint('')))).toBeNull();
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // An exposed cache fingerprint must not equal the public, unkeyed candidate digest.
    expect(fingerprint).not.toBe(createHash('sha256').update(credential).digest('hex'));
  });

  it('gives the same credential a different fingerprint in a fresh cache module lifetime', () => {
    const credential = 'SYNTHETIC-SHORT-CREDENTIAL';
    const currentFingerprint = modelCache.credentialFingerprint(credential);
    let freshFingerprint: string | undefined;
    jest.isolateModules(() => {
      const fresh = jest.requireActual<typeof import('@/backend/services/model/cache')>('@/backend/services/model/cache').modelCache;
      freshFingerprint = fresh.credentialFingerprint(credential);
      expect(fresh.credentialFingerprint(credential)).toBe(freshFingerprint);
      expect(fresh.getStats().totalEntries).toBe(0);
    });
    expect(freshFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(freshFingerprint).not.toBe(currentFingerprint);
  });

  it.each([
    { baseUrl: 'https://other.example/v1' },
    { provider: 'openai' },
    { adapter: 'openai' },
    { profileId: 'another-native-profile' },
  ])('keeps catalogue options in the cache identity: %j', (changedOptions) => {
    const identity = nativeIdentity(modelCache.credentialFingerprint('SYNTHETIC-CREDENTIAL'));
    modelCache.set(identity, MODELS);
    expect(modelCache.get({ ...identity, ...changedOptions })).toBeNull();
    expect(modelCache.get(identity)).toEqual(MODELS);
  });

  it('keeps workspace cache entries separate with the same resolved credential', () => {
    const identity = nativeIdentity(modelCache.credentialFingerprint('SYNTHETIC-CREDENTIAL'));
    modelCache.set(identity, MODELS);
    mockWorkspace = 'catalogue-cache-workspace-b';
    expect(modelCache.get(identity)).toBeNull();
    mockWorkspace = 'catalogue-cache-workspace-a';
    expect(modelCache.get(identity)).toEqual(MODELS);
  });

  it('omits credentials and keyed fingerprints from cache diagnostics across hit, miss and clear', () => {
    const credential = 'SYNTHETIC-CREDENTIAL-DIAGNOSTIC-CANARY';
    const fingerprint = modelCache.credentialFingerprint(credential);
    const identity = nativeIdentity(fingerprint);
    modelCache.get(identity);
    modelCache.set(identity, MODELS);
    modelCache.get(identity);
    modelCache.clear(identity);
    modelCache.clearAll();

    expect(modelCache.credentialFingerprint(credential)).toBe(fingerprint);
    expect(mockLogDebug).toHaveBeenCalled();
    const diagnostics = JSON.stringify(mockLogDebug.mock.calls);
    expect(diagnostics).not.toContain(credential);
    expect(diagnostics).not.toContain(fingerprint);
    expect(diagnostics).not.toContain('credentialFingerprint');
  });

  it('keeps search filtering local and deterministic', () => {
    expect(filterModels(MODELS, 'lite').map(model => model.id)).toEqual([
      'gemini-3.5-flash-lite',
    ]);
    expect(filterModels(MODELS, '')).toEqual(MODELS);
  });
});
