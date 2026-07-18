/**
 * Regression tests for the backup/restore routes (issue: backup zips silently
 * omitted all configuration because the backup route read raw files from a
 * legacy <cwd>/storage/ directory instead of going through the storage
 * backend, which persists to <cwd>/db/).
 *
 * The storage backend is mocked at the module boundary so tests never touch
 * the real db/ directory; the routes' own logic — selection mapping, zip
 * layout, error tolerance — runs for real.
 */
import type { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { StorageKey } from '@/shared/types/storage';

const loadItemMock = jest.fn();
const saveItemMock = jest.fn();
const saveCollectionItemMock = jest.fn();
// Flows now live one-file-per-flow (db/flows/<id>.json); model that collection
// in memory. Backup aggregates it back into the single array the zip expects,
// and restore imports each flow through flowService (upsert).
const flowFiles = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
  saveItem: (...args: unknown[]) => saveItemMock(...args),
  saveCollectionItem: (...args: unknown[]) => saveCollectionItemMock(...args),
  loadCollectionItem: jest.fn(async (_c: string, id: string, fallback: unknown) =>
    flowFiles.has(id) ? flowFiles.get(id) : fallback),
  listCollectionItems: jest.fn(async () => Array.from(flowFiles.values())),
  // loadFlows backfills timestamps from file mtime (#108); model the stats API.
  listCollectionItemsWithStats: jest.fn(async () =>
    Array.from(flowFiles.values()).map((item) => ({ item, mtimeMs: 0 }))),
  deleteCollectionItem: jest.fn(async (_c: string, id: string) => { flowFiles.delete(id); }),
  assertSafeCollectionId: jest.fn(),
  migrateArrayFileToCollection: jest.fn(async () => 0),
}));

// restore imports flows via flowService.saveFlow, which invalidates the engine
// cache through a lazy import; stub it so the test never loads the real engine.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { clearFlowCache: jest.fn() },
}));

import { POST as backupPost } from '@/app/api/backup/route';
import { POST as restorePost } from '@/app/api/restore/route';

const modelsData = [{ id: 'model-1', name: 'Test Model' }];
// Flows now carry server-managed timestamps (#108); include them so loadFlows'
// mtime backfill is a no-op and the backup zip round-trips exactly.
const flowsData = [{ id: 'flow-1', name: 'Test Flow', nodes: [], edges: [], createdAt: 1000, updatedAt: 2000 }];

const callBackup = (selections: unknown) => {
  const request = new Request('http://localhost:4200/api/backup', {
    method: 'POST',
    // #131: the route now requires a localhost Host (origin guard).
    headers: { 'content-type': 'application/json', host: 'localhost:4200' },
    body: JSON.stringify({ selections }),
  }) as unknown as NextRequest;
  return backupPost(request);
};

const callRestore = (zipBuffer: ArrayBuffer, selections: string[]) => {
  const formData = new FormData();
  formData.append(
    'file',
    new File([zipBuffer], 'flujo-backup.zip', { type: 'application/zip' })
  );
  formData.append('selections', JSON.stringify(selections));
  const request = new Request('http://localhost:4200/api/restore', {
    method: 'POST',
    // #131: the route now requires a localhost Host (origin guard).
    headers: { host: 'localhost:4200' },
    body: formData,
  }) as unknown as NextRequest;
  return restorePost(request);
};

beforeEach(() => {
  saveItemMock.mockReset().mockResolvedValue(undefined);
  saveCollectionItemMock.mockReset().mockImplementation(async (_c: string, id: string, val: unknown) => {
    flowFiles.set(id, val);
  });
  loadItemMock.mockReset().mockImplementation(async (key: StorageKey) => {
    if (key === StorageKey.MODELS) return modelsData;
    return null; // flows are no longer read via loadItem
  });
  // Seed the per-flow collection with the fixture flow(s).
  flowFiles.clear();
  for (const f of flowsData) flowFiles.set((f as { id: string }).id, f);
  (global as unknown as { __flujo_flowsCache: unknown }).__flujo_flowsCache = null;
  (global as unknown as { __flujo_flowsMigration: unknown }).__flujo_flowsMigration = undefined;
});

describe('backup route', () => {
  it('reads selections through the storage backend and zips them under storage/<key>.json', async () => {
    const response = await callBackup(['models', 'flows']);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');

    // The route must go through the storage backend (db/), never raw storage/
    // files. Non-flow keys go through loadItem; flows go through the per-flow
    // collection (flowService.loadFlows -> listCollectionItems).
    expect(loadItemMock).toHaveBeenCalledWith(StorageKey.MODELS, null);

    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file('backup-info.json')).toBeTruthy();

    const models = zip.file(`storage/${StorageKey.MODELS}.json`);
    const flows = zip.file(`storage/${StorageKey.FLOWS}.json`);
    expect(models).toBeTruthy();
    expect(flows).toBeTruthy();
    expect(JSON.parse(await models!.async('string'))).toEqual(modelsData);
    expect(JSON.parse(await flows!.async('string'))).toEqual(flowsData);
  });

  it('omits keys that have no stored data but still succeeds', async () => {
    loadItemMock.mockImplementation(async (key: StorageKey) =>
      key === StorageKey.MODELS ? modelsData : null
    );
    flowFiles.clear(); // no flows stored

    const response = await callBackup(['models', 'flows']);
    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file(`storage/${StorageKey.MODELS}.json`)).toBeTruthy();
    expect(zip.file(`storage/${StorageKey.FLOWS}.json`)).toBeNull();
  });

  it('continues with other keys when one key fails to load (e.g. corrupt JSON)', async () => {
    loadItemMock.mockImplementation(async (key: StorageKey) => {
      if (key === StorageKey.MODELS) throw new Error('Failed to parse JSON');
      if (key === StorageKey.FLOWS) return flowsData;
      return null;
    });

    const response = await callBackup(['models', 'flows']);
    expect(response.status).toBe(200);

    const zip = await JSZip.loadAsync(await response.arrayBuffer());
    expect(zip.file(`storage/${StorageKey.MODELS}.json`)).toBeNull();
    expect(zip.file(`storage/${StorageKey.FLOWS}.json`)).toBeTruthy();
  });

  it('rejects an empty selection list', async () => {
    expect((await callBackup([])).status).toBe(400);
    expect((await callBackup(undefined)).status).toBe(400);
  });
});

describe('backup → restore round-trip', () => {
  it('restores the produced zip through saveItem with the original data', async () => {
    const backupResponse = await callBackup(['models', 'flows']);
    expect(backupResponse.status).toBe(200);
    const zipBuffer = await backupResponse.arrayBuffer();

    const restoreResponse = await callRestore(zipBuffer, ['models', 'flows']);
    expect(restoreResponse.status).toBe(200);
    expect(await restoreResponse.json()).toEqual({ success: true });

    expect(saveItemMock).toHaveBeenCalledWith(StorageKey.MODELS, modelsData);
    // Flows are restored one-file-per-flow via flowService.saveFlow, which
    // stamps createdAt (preserved) / updatedAt (refreshed to now) authoritatively
    // (#108), so assert on content and the preserved createdAt rather than exact
    // equality with the fixture's updatedAt.
    expect(saveCollectionItemMock).toHaveBeenCalledWith(
      StorageKey.FLOWS,
      'flow-1',
      expect.objectContaining({ id: 'flow-1', name: 'Test Flow', nodes: [], edges: [], createdAt: 1000 }),
    );
  });

  it('skips keys missing from the zip without failing the restore', async () => {
    loadItemMock.mockImplementation(async (key: StorageKey) =>
      key === StorageKey.MODELS ? modelsData : null
    );
    const backupResponse = await callBackup(['models']);
    const zipBuffer = await backupResponse.arrayBuffer();

    const restoreResponse = await callRestore(zipBuffer, ['models', 'flows']);
    expect(restoreResponse.status).toBe(200);

    expect(saveItemMock).toHaveBeenCalledTimes(1);
    expect(saveItemMock).toHaveBeenCalledWith(StorageKey.MODELS, modelsData);
  });
});
