jest.mock('node:v8', () => { const actual = jest.requireActual('node:v8'); return { ...actual, getHeapStatistics: jest.fn(actual.getHeapStatistics) }; });
let mockDirectory: string;
jest.mock('@/utils/workspace', () => ({ ...jest.requireActual('@/utils/workspace'), getWorkspaceDataDir: () => mockDirectory }));
jest.mock('@/utils/encryption/credentialMigrationState', () => ({ assertCredentialStoreReady: jest.fn(async () => {}) }));
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as v8 from 'node:v8';
import { withConversationSnapshot, loadItem, loadCollectionItem } from '@/utils/storage/backend';
import { assertCredentialStoreReady } from '@/utils/encryption/credentialMigrationState';
import { StorageKey } from '@/shared/types/storage';
import { getConversationLogReadAdmission } from '@/backend/execution/flow/conversationLogReadAdmission';
const file = () => path.join(mockDirectory, 'db', 'conversations', 'snapshot.json');
beforeEach(async () => {
  mockDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-snapshot-admission-'));
  await fs.mkdir(path.dirname(file()), { recursive: true });
  jest.mocked(v8.getHeapStatistics).mockImplementation(jest.requireActual('node:v8').getHeapStatistics);
  jest.mocked(assertCredentialStoreReady).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => { jest.restoreAllMocks(); expect(getConversationLogReadAdmission()).toEqual({ active: 0, bytes: 0 }); await fs.rm(mockDirectory, { recursive: true, force: true }); });
it('keeps complete large snapshot messages and admission through consumer adoption', async () => {
  const state = { messages: Array.from({ length: 1500 }, (_, id) => ({ id, content: 'x'.repeat(100) })) };
  const raw = JSON.stringify(state); await fs.writeFile(file(), raw);
  expect(await withConversationSnapshot('snapshot', async value => {
    expect(getConversationLogReadAdmission().active).toBe(1); return value;
  })).toEqual(state);
  expect(await fs.readFile(file(), 'utf8')).toBe(raw);
});
it('rejects pressure before descriptor reads or cache consumer', async () => {
  await fs.writeFile(file(), '{}'); const consume = jest.fn(); const open = jest.spyOn(fs, 'open');
  const heap = v8.getHeapStatistics();
  jest.mocked(v8.getHeapStatistics).mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size + 64 * 1024 * 1024 });
  await expect(withConversationSnapshot('snapshot', consume)).rejects.toMatchObject({ status: 503 });
  expect(open).not.toHaveBeenCalled(); expect(consume).not.toHaveBeenCalled();
});
it.each(['growth', 'replacement'] as const)('rejects %s between metadata and open before allocating/reading the larger file', async change => {
  await fs.writeFile(file(), '{}'); const open = fs.open.bind(fs); const reads = jest.fn();
  jest.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    if (change === 'replacement') { await fs.rename(file(), `${file()}.old`); }
    await fs.writeFile(file(), JSON.stringify({ large: 'x'.repeat(200000) }));
    const handle = await open(...args); jest.spyOn(handle, 'read').mockImplementation(reads); return handle;
  });
  await expect(withConversationSnapshot('snapshot', async state => state)).rejects.toMatchObject({ code: 'UNSAFE_FILE' });
  expect(reads).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(file(), 'utf8')).large).toHaveLength(200000);
});
it('backs up actual corrupt JSON but never treats a consumer SyntaxError as corruption', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await fs.writeFile(file(), '{broken');
  await expect(withConversationSnapshot('snapshot', async value => value)).rejects.toThrow('Failed to parse JSON');
  expect((await fs.readdir(path.dirname(file()))).filter(name => name.includes('.corrupted.'))).toHaveLength(1);
  await fs.writeFile(file(), '{}');
  await expect(withConversationSnapshot('snapshot', async () => { throw new SyntaxError('consumer'); })).rejects.toThrow('consumer');
  expect((await fs.readdir(path.dirname(file()))).filter(name => name.includes('.corrupted.'))).toHaveLength(1);
});
it('checks safe IDs and credential readiness ahead of admission and leaves disk unchanged on refusal', async () => {
  const open = jest.spyOn(fs, 'open');
  await expect(withConversationSnapshot('../escape', async value => value)).rejects.toThrow();
  expect(open).not.toHaveBeenCalled(); expect(assertCredentialStoreReady).not.toHaveBeenCalled();
  await fs.writeFile(file(), '{}');
  jest.mocked(assertCredentialStoreReady).mockRejectedValueOnce(new Error('migration pending'));
  await expect(withConversationSnapshot('snapshot', async value => value)).rejects.toThrow('migration pending');
  expect(open).not.toHaveBeenCalled(); expect(await fs.readFile(file(), 'utf8')).toBe('{}');
});
it('preserves missing/empty snapshots and releases on cancellation-like consumer failure', async () => {
  expect(await withConversationSnapshot('snapshot', async value => value)).toBeUndefined();
  await fs.writeFile(file(), '  ');
  expect(await withConversationSnapshot('snapshot', async value => value)).toBeUndefined();
  await fs.writeFile(file(), '{}'); const cancelled = new DOMException('cancelled', 'AbortError');
  await expect(withConversationSnapshot('snapshot', async () => { throw cancelled; })).rejects.toBe(cancelled);
});

it.each(['item', 'collection'] as const)('guards raw %s conversation reads before materializing', async kind => {
  await fs.writeFile(file(), '{}'); const open = jest.spyOn(fs, 'open');
  const heap = v8.getHeapStatistics();
  jest.mocked(v8.getHeapStatistics).mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size + 64 * 1024 * 1024 });
  const read = kind === 'item' ? loadItem('conversations/snapshot' as StorageKey, undefined) : loadCollectionItem('conversations', 'snapshot', undefined);
  await expect(read).rejects.toMatchObject({ status: 503 }); expect(open).not.toHaveBeenCalled();
});
it.each([null, false, 0, ''])('preserves valid primitive JSON %p through both raw wrappers', async value => {
  await fs.writeFile(file(), JSON.stringify(value));
  expect(await loadItem('conversations/snapshot' as StorageKey, 'fallback')).toEqual(value);
  expect(await loadCollectionItem('conversations', 'snapshot', 'fallback')).toEqual(value);
});
it('keeps raw conversation missing/empty defaults and adjacent collection policies unchanged', async () => {
  expect(await loadItem('conversations/snapshot' as StorageKey, 'fallback')).toBe('fallback');
  expect(await loadCollectionItem('conversations', 'snapshot', 'fallback')).toBe('fallback');
  await fs.writeFile(file(), '  ');
  expect(await loadItem('conversations/snapshot' as StorageKey, 'fallback')).toBe('fallback');
  const adjacent = path.join(mockDirectory, 'db', 'adjacent.json');
  await fs.writeFile(adjacent, JSON.stringify({ unaffected: true }));
  const heap = v8.getHeapStatistics();
  jest.mocked(v8.getHeapStatistics).mockReturnValue({ ...heap, heap_size_limit: heap.used_heap_size });
  expect(await loadItem('adjacent' as StorageKey, undefined)).toEqual({ unaffected: true });
  await fs.mkdir(path.join(mockDirectory, 'db', 'flows'));
  await fs.writeFile(path.join(mockDirectory, 'db', 'flows', 'snapshot.json'), '{}');
  expect(await loadCollectionItem('flows', 'snapshot', undefined)).toEqual({});
});
