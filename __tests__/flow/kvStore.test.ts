/**
 * Tier 4 — persistent (cross-run) key-value store.
 *
 * Pins the store contract: set/get/overwrite/delete round-trips, the three cap
 * refusals returning `{ skipped }` instead of throwing (a write must never break
 * a run), scope isolation, the SAFE_ID path-traversal gate, the name→value
 * snapshot, and cold-start load from disk. Mirrors runResourceStore.test.ts.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  kvSet,
  kvGet,
  kvDelete,
  listKv,
  loadKvSnapshot,
  _setKvStoreDirForTests,
  _clearKvStoreSettingsCache,
} from '@/backend/services/kvStore';

// Pin settings to defaults but with TIGHT caps so the cap paths are testable
// without large payloads.
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    loadItem: jest.fn(async (_key: unknown, defaultValue: unknown) => ({
      ...(defaultValue as Record<string, unknown>),
      maxValueBytes: 16,
      maxKeysPerScope: 3,
      maxScopeBytes: 32,
    })),
  };
});

let tmpDir: string;
let previousDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-kv-'));
  previousDir = _setKvStoreDirForTests(tmpDir);
});

afterAll(async () => {
  _setKvStoreDirForTests(previousDir);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _clearKvStoreSettingsCache();
});

describe('set / get / overwrite', () => {
  it('sets, reads back, and overwrites (last-write-wins)', async () => {
    expect(await kvGet('t1', 'k')).toBeUndefined();
    const e = await kvSet('t1', 'k', 'v1');
    expect('skipped' in e).toBe(false);
    expect(await kvGet('t1', 'k')).toBe('v1');
    await kvSet('t1', 'k', 'v2');
    expect(await kvGet('t1', 'k')).toBe('v2');
    expect((await listKv('t1')).length).toBe(1); // overwrite, not a new entry
  });

  it('isolates scopes', async () => {
    await kvSet('scopeA', 'k', 'A');
    await kvSet('scopeB', 'k', 'B');
    expect(await kvGet('scopeA', 'k')).toBe('A');
    expect(await kvGet('scopeB', 'k')).toBe('B');
  });
});

describe('caps refuse with a skip marker (never throw)', () => {
  it('per-value size cap', async () => {
    const res = await kvSet('cap1', 'k', 'x'.repeat(64)); // > 16 bytes
    expect(res).toEqual({ skipped: 'size-cap' });
    expect(await kvGet('cap1', 'k')).toBeUndefined();
  });

  it('per-scope key-count cap (but overwrite of an existing key still works)', async () => {
    await kvSet('cap2', 'a', '1');
    await kvSet('cap2', 'b', '2');
    await kvSet('cap2', 'c', '3');
    expect(await kvSet('cap2', 'd', '4')).toEqual({ skipped: 'keys-cap' });
    expect('skipped' in (await kvSet('cap2', 'a', '9'))).toBe(false);
    expect(await kvGet('cap2', 'a')).toBe('9');
  });

  it('per-scope byte budget cap', async () => {
    await kvSet('cap3', 'a', 'x'.repeat(16)); // 16
    await kvSet('cap3', 'b', 'y'.repeat(16)); // 32 total == budget
    expect(await kvSet('cap3', 'c', 'z')).toEqual({ skipped: 'scope-cap' });
  });
});

describe('delete + safety + persistence', () => {
  it('deletes a key idempotently', async () => {
    await kvSet('del', 'k', 'v');
    await kvDelete('del', 'k');
    expect(await kvGet('del', 'k')).toBeUndefined();
    await expect(kvDelete('del', 'k')).resolves.toBeUndefined();
  });

  it('rejects unsafe scope / key names (path-traversal guard)', async () => {
    await expect(kvSet('../evil', 'k', 'v')).rejects.toThrow();
    await expect(kvSet('ok', '../evil', 'v')).rejects.toThrow();
    await expect(kvGet('ok', 'a/b')).rejects.toThrow();
  });

  it('loadKvSnapshot returns a name→value map', async () => {
    await kvSet('snap', 'a', '1');
    await kvSet('snap', 'b', '2');
    expect(await loadKvSnapshot('snap')).toEqual({ a: '1', b: '2' });
  });

  it('cold-starts from disk when the in-memory cache is cleared', async () => {
    await kvSet('cold', 'k', 'persisted');
    _setKvStoreDirForTests(tmpDir); // re-point at the same dir → clears the cache
    expect(await kvGet('cold', 'k')).toBe('persisted');
  });
});
