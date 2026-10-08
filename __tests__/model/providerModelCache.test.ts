import {
  filterModels,
  modelCache,
  type ModelCacheIdentity,
} from '@/backend/services/model/cache';
import type { NormalizedModel } from '@/shared/types/model';

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
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
    modelCache.clearAll();
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

  it('keeps search filtering local and deterministic', () => {
    expect(filterModels(MODELS, 'lite').map(model => model.id)).toEqual([
      'gemini-3.5-flash-lite',
    ]);
    expect(filterModels(MODELS, '')).toEqual(MODELS);
  });
});
