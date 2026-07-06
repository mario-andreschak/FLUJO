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

jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
  saveItem: (...args: unknown[]) => saveItemMock(...args),
}));

import { POST as backupPost } from '@/app/api/backup/route';
import { POST as restorePost } from '@/app/api/restore/route';

const modelsData = [{ id: 'model-1', name: 'Test Model' }];
const flowsData = [{ id: 'flow-1', name: 'Test Flow', nodes: [], edges: [] }];

const callBackup = (selections: unknown) => {
  const request = new Request('http://localhost:4200/api/backup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    body: formData,
  }) as unknown as NextRequest;
  return restorePost(request);
};

beforeEach(() => {
  saveItemMock.mockReset().mockResolvedValue(undefined);
  loadItemMock.mockReset().mockImplementation(async (key: StorageKey) => {
    if (key === StorageKey.MODELS) return modelsData;
    if (key === StorageKey.FLOWS) return flowsData;
    return null;
  });
});

describe('backup route', () => {
  it('reads selections through the storage backend and zips them under storage/<key>.json', async () => {
    const response = await callBackup(['models', 'flows']);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');

    // The route must go through loadItem (db/), never raw storage/ files.
    expect(loadItemMock).toHaveBeenCalledWith(StorageKey.MODELS, null);
    expect(loadItemMock).toHaveBeenCalledWith(StorageKey.FLOWS, null);

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
    expect(saveItemMock).toHaveBeenCalledWith(StorageKey.FLOWS, flowsData);
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
