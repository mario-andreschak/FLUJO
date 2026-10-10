import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  getLegacyCollectionItemPath, getShardedCollectionItemPath, loadShardedCollectionItem,
  PersonaShardCollisionError, saveShardedCollectionItem, getShardedCollectionItemStats,
} from '@/utils/storage/backend';

let mockStorageRoot: string;
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  getWorkspaceDataDir: () => mockStorageRoot,
  workspaceCacheKey: (...parts: string[]) => [mockStorageRoot, ...parts].join('/'),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ verbose() {}, debug() {}, warn() {}, error() {} }) }));
const collection = 'persona-work-items';
const personaId = 'persona';
const recordId = 'record';
const original = { id: recordId, personaId, goal: { pendingDispatchId: 'dispatch' } };
const cancelled = { id: recordId, personaId, goal: { cancellationRequestedAt: 1234 } };
let file: string;
beforeEach(async () => {
  mockStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-persona-storage-read-'));
  await saveShardedCollectionItem(collection, personaId, recordId, original);
  file = getShardedCollectionItemPath(collection, personaId, recordId);
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (path.dirname(path.resolve(mockStorageRoot)) !== path.resolve(os.tmpdir()) || !path.basename(mockStorageRoot).startsWith('flujo-persona-storage-read-')) {
    throw new Error('Unsafe Persona storage fixture cleanup');
  }
  await fs.rm(mockStorageRoot, { recursive: true, force: true });
});
function replaceBeforeOpen(value: unknown) {
  const open = fs.open.bind(fs);
  let changed = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === file && !changed) {
      changed = true;
      const temp = path.join(mockStorageRoot, 'fresh-record.json');
      await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temp, file);
    }
    return open(...args);
  });
}
it('returns the newly persisted cancellation record through the real shard loader', async () => {
  replaceBeforeOpen(cancelled);
  expect(await loadShardedCollectionItem(collection, personaId, recordId, null)).toEqual(cancelled);
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(cancelled);
});
it('reports metadata from the fresh accepted record rather than the obsolete snapshot', async () => {
  replaceBeforeOpen(cancelled);
  expect(await getShardedCollectionItemStats(collection, personaId, recordId)).toEqual(expect.objectContaining({
    sizeBytes: Buffer.byteLength(JSON.stringify(cancelled)),
  }));
});
it.each([{ ...cancelled, personaId: 'other-persona' }, { ...cancelled, id: 'other-record' }])(
  'retains the Persona and record identity guard after a qualified filesystem replacement (%j)', async value => {
    replaceBeforeOpen(value);
    await expect(loadShardedCollectionItem(collection, personaId, recordId, null)).rejects.toThrow('does not match requested Persona');
  },
);
it('retains the flat/sharded collision guard after accepting a fresh replacement', async () => {
  await fs.writeFile(getLegacyCollectionItemPath(collection, recordId), JSON.stringify(original), { mode: 0o600 });
  replaceBeforeOpen(cancelled);
  await expect(loadShardedCollectionItem(collection, personaId, recordId, null)).rejects.toBeInstanceOf(PersonaShardCollisionError);
});
