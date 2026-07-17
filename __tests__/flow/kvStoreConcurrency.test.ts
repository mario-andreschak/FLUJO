/**
 * Tier 4 kv-store — concurrency regression (issue #124).
 *
 * Reproduces the lost-update race: `kvSet` used to do loadIndex → mutate →
 * saveIndex with the write chain entered only INSIDE saveIndex, so N concurrent
 * distinct-key writes to the SAME scope all read the same empty base index and
 * clobbered each other — only the last write survived. The fix runs the whole
 * read-modify-write inside one `runInWriteChain(chainKey(scope))` critical
 * section (`mutateIndex`), so every distinct key lands. Different scopes must
 * still write in parallel (distinct chain keys → no cross-scope serialization).
 *
 * These tests FAIL on `main` (only ~1 key survives) and PASS after the fix.
 * Kept in a SEPARATE file from kvStore.test.ts because that suite pins TINY
 * caps; here we need caps generous enough for N distinct keys so the test
 * measures the race, not a cap refusal.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  kvSet,
  kvGet,
  listKv,
  _setKvStoreDirForTests,
  _clearKvStoreSettingsCache,
} from '@/backend/services/kvStore';

// Defaults but with caps comfortably above the test payloads so N distinct keys
// all fit (the race, not a cap, is what we are measuring).
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => ({
      ...(defaultValue as Record<string, unknown>),
      enabled: true,
      maxValueBytes: 4096,
      maxKeysPerScope: 1000,
      maxScopeBytes: 1_000_000,
    })),
  };
});

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-kv-race-'));
  previousDir = _setKvStoreDirForTests(tmpDir);
});

afterAll(async () => {
  _setKvStoreDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _clearKvStoreSettingsCache();
});

describe('concurrent kvSet (lost-update regression)', () => {
  it('keeps every key when N distinct keys are written to the same scope concurrently', async () => {
    const N = 50;
    const scope = 'raceScope';
    await Promise.all(
      Array.from({ length: N }, (_, i) => kvSet(scope, `k${i}`, `v${i}`))
    );

    const entries = await listKv(scope);
    expect(entries.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(await kvGet(scope, `k${i}`)).toBe(`v${i}`);
    }
  });

  it('writes to different scopes concurrently all land (no cross-scope over-serialization)', async () => {
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) => kvSet(`scope${i}`, 'k', `v${i}`))
    );
    for (let i = 0; i < N; i++) {
      expect(await kvGet(`scope${i}`, 'k')).toBe(`v${i}`);
    }
  });
});
