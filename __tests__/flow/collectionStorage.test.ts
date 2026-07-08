/**
 * Tests for the per-item collection storage helpers and the one-time
 * array-file -> per-item-file migration added for issue #62 (flows moving from
 * a single db/flows.json array to db/flows/<id>.json).
 *
 * These drive the REAL storage backend against a throwaway temp data dir (via
 * FLUJO_DATA_DIR), so filesystem behaviour — atomic writes, unsafe-id
 * rejection, tmp/corrupt-file skipping, idempotent/crash-safe migration — is
 * exercised for real.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { StorageKey } from '@/shared/types/storage';

type Backend = typeof import('@/utils/storage/backend');

let tmpDir: string;
let dbDir: string;
let backend: Backend;

const readJson = async (p: string) => JSON.parse(await fs.readFile(p, 'utf-8'));
const exists = async (p: string) => {
  try { await fs.access(p); return true; } catch { return false; }
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-storage-'));
  dbDir = path.join(tmpDir, 'db');
  process.env.FLUJO_DATA_DIR = tmpDir;
  // STORAGE_DIR is resolved at module load, so re-import after setting the env.
  jest.resetModules();
  backend = await import('@/utils/storage/backend');
});

afterEach(async () => {
  delete process.env.FLUJO_DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('collection storage helpers', () => {
  it('saves and re-reads an item at db/<collection>/<id>.json', async () => {
    await backend.saveCollectionItem('flows', 'abc', { id: 'abc', name: 'A' });
    const onDisk = await readJson(path.join(dbDir, 'flows', 'abc.json'));
    expect(onDisk).toEqual({ id: 'abc', name: 'A' });
    expect(await backend.loadCollectionItem('flows', 'abc', null)).toEqual({ id: 'abc', name: 'A' });
  });

  it('returns the default for a missing item', async () => {
    expect(await backend.loadCollectionItem('flows', 'nope', null)).toBeNull();
  });

  it('rejects unsafe ids (path traversal) on every path-building op', async () => {
    for (const bad of ['../evil', 'a/b', '..', '', 'x'.repeat(65), 'has space', 'dot.dot']) {
      expect(() => backend.assertSafeCollectionId(bad)).toThrow();
      await expect(backend.saveCollectionItem('flows', bad, {})).rejects.toThrow();
      await expect(backend.loadCollectionItem('flows', bad, null)).rejects.toThrow();
      await expect(backend.deleteCollectionItem('flows', bad)).rejects.toThrow();
    }
    // A file was never created outside the collection dir.
    expect(await exists(path.join(tmpDir, 'db', 'evil.json'))).toBe(false);
  });

  it('accepts normal UUID-like ids', () => {
    expect(() => backend.assertSafeCollectionId('123e4567-e89b-12d3-a456-426614174000')).not.toThrow();
  });

  it('deletes an item and is a no-op when it is already gone', async () => {
    await backend.saveCollectionItem('flows', 'x', { id: 'x' });
    await backend.deleteCollectionItem('flows', 'x');
    expect(await exists(path.join(dbDir, 'flows', 'x.json'))).toBe(false);
    await expect(backend.deleteCollectionItem('flows', 'x')).resolves.toBeUndefined();
  });

  it('lists items, skipping tmp/corrupted/backup files, and empty dir -> []', async () => {
    expect(await backend.listCollectionItems('flows')).toEqual([]);

    await backend.saveCollectionItem('flows', 'one', { id: 'one' });
    await backend.saveCollectionItem('flows', 'two', { id: 'two' });
    // Noise that must be ignored by the listing.
    await fs.writeFile(path.join(dbDir, 'flows', 'three.json.tmp.123.4'), '{"id":"tmp"}');
    await fs.writeFile(path.join(dbDir, 'flows', 'four.json.corrupted.999.bak'), 'garbage');
    await fs.writeFile(path.join(dbDir, 'flows', 'notes.txt'), 'hello');

    const ids = (await backend.listCollectionItems<{ id: string }>('flows')).map(i => i.id).sort();
    expect(ids).toEqual(['one', 'two']);
  });

  it('skips a single corrupt file instead of failing the whole listing', async () => {
    await backend.saveCollectionItem('flows', 'good', { id: 'good' });
    await fs.writeFile(path.join(dbDir, 'flows', 'bad.json'), '{ not json');
    const ids = (await backend.listCollectionItems<{ id: string }>('flows')).map(i => i.id);
    expect(ids).toEqual(['good']);
  });

  it('backs up a corrupt item on read and then throws', async () => {
    await fs.mkdir(path.join(dbDir, 'flows'), { recursive: true });
    await fs.writeFile(path.join(dbDir, 'flows', 'bent.json'), '{ broken');
    await expect(backend.loadCollectionItem('flows', 'bent', null)).rejects.toThrow(/Failed to parse JSON/);
    const entries = await fs.readdir(path.join(dbDir, 'flows'));
    expect(entries.some(e => e.startsWith('bent.json.corrupted.'))).toBe(true);
  });
});

describe('migrateArrayFileToCollection', () => {
  const writeLegacy = async (value: unknown) => {
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(path.join(dbDir, 'flows.json'), JSON.stringify(value));
  };
  const legacyArchived = async () => {
    const entries = await exists(dbDir) ? await fs.readdir(dbDir) : [];
    return entries.some(e => e.startsWith('flows.json.migrated-'));
  };

  it('is a no-op when there is no legacy file', async () => {
    const n = await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    expect(n).toBe(0);
    expect(await exists(path.join(dbDir, 'flows'))).toBe(false);
  });

  it('moves every item to a per-item file and archives the legacy file', async () => {
    await writeLegacy([{ id: 'f1', name: 'One' }, { id: 'f2', name: 'Two' }]);
    const n = await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    expect(n).toBe(2);
    expect(await readJson(path.join(dbDir, 'flows', 'f1.json'))).toEqual({ id: 'f1', name: 'One' });
    expect(await readJson(path.join(dbDir, 'flows', 'f2.json'))).toEqual({ id: 'f2', name: 'Two' });
    expect(await exists(path.join(dbDir, 'flows.json'))).toBe(false);
    expect(await legacyArchived()).toBe(true);
  });

  it('never overwrites an existing per-item file (crash-resume safe) and is idempotent', async () => {
    await backend.saveCollectionItem('flows', 'f1', { id: 'f1', name: 'NEWER' });
    await writeLegacy([{ id: 'f1', name: 'OLDER' }, { id: 'f2', name: 'Two' }]);

    await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    // The pre-existing per-item file wins.
    expect(await readJson(path.join(dbDir, 'flows', 'f1.json'))).toEqual({ id: 'f1', name: 'NEWER' });
    expect(await readJson(path.join(dbDir, 'flows', 'f2.json'))).toEqual({ id: 'f2', name: 'Two' });

    // Running again with no legacy file is a clean no-op.
    const n = await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    expect(n).toBe(0);
  });

  it('archives an empty legacy file without creating items', async () => {
    await fs.mkdir(dbDir, { recursive: true });
    await fs.writeFile(path.join(dbDir, 'flows.json'), '   ');
    const n = await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    expect(n).toBe(0);
    expect(await exists(path.join(dbDir, 'flows.json'))).toBe(false);
    expect(await legacyArchived()).toBe(true);
  });

  it('skips items with an unsafe id but migrates the rest', async () => {
    await writeLegacy([{ id: 'ok', name: 'Fine' }, { id: '../evil', name: 'Bad' }]);
    await backend.migrateArrayFileToCollection(StorageKey.FLOWS, 'flows', (f: { id: string }) => f.id);
    expect(await exists(path.join(dbDir, 'flows', 'ok.json'))).toBe(true);
    expect(await exists(path.join(tmpDir, 'db', 'evil.json'))).toBe(false);
  });
});
