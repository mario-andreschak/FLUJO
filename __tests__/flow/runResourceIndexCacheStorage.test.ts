import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  _clearRunResourceSettingsCache,
  _setRunResourcesDirForTests,
  copyRunResourceToConversation,
  deleteRunResources,
  findRunResourceByName,
  listAllRunResources,
  listRunResources,
  readRunResource,
  readRunResourceBounded,
  readRunResourceRange,
  writeRunResource,
} from '@/backend/services/runResources';
import { clearRunResourceIndexCache, getRunResourceIndexPressure, publishRunResourceIndex } from '@/backend/services/runResources/indexCache';
import type { RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async (_key: unknown, defaults: unknown) => ({
    ...(defaults as Record<string, unknown>), maxResourceBytes: 4096, maxConversationBytes: 1024 * 1024,
  })),
}));

let root: string, previous: string;
const conversation = 'cache-history';
const indexFile = () => path.join(root, conversation, 'index.json');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function write(name: string) {
  const result = await writeRunResource({ conversationId: conversation, kind: 'text', name,
    data: { text: 'payload ' + name }, producedBy: { source: 'capture', nodeId: 'producer' } });
  if ('skipped' in result) throw new Error('Fixture resource unexpectedly refused');
  return result;
}
function evictIndexes() {
  for (let i = 0; i < 200; i++) publishRunResourceIndex('eviction-fixture-' + i, '[]');
}
function holdNextPayload() {
  const gate = deferred<void>(), entered = deferred<void>();
  const nativeWrite = fs.writeFile.bind(fs);
  let held = false;
  jest.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    const filename = args[0];
    if (!held && typeof filename === 'string' && path.dirname(filename) === path.dirname(indexFile()) && filename.endsWith('.dat')) {
      held = true; entered.resolve(); await gate.promise;
    }
    return nativeWrite(...args);
  });
  return { gate, entered };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-resource-index-cache-'));
  previous = _setRunResourcesDirForTests(root);
  _clearRunResourceSettingsCache();
});
afterEach(async () => {
  jest.restoreAllMocks();
  expect(getRunResourceIndexPressure()).toMatchObject({ activeReads: 0, queuedReads: 0 });
  _setRunResourcesDirForTests(previous);
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-resource-index-cache-')) {
    throw new Error('Unsafe resource-index fixture cleanup');
  }
  await fs.rm(root, { recursive: true, force: true });
});

it('retains a new disk publication when an evicted cold reader finishes its older snapshot later', async () => {
  const original = await write('original');
  const payload = holdNextPayload();
  const writer = write('new');
  await payload.entered.promise; // The writer already loaded its index and owns the write chain.
  evictIndexes();
  const coldGate = deferred<void>(), coldEntered = deferred<void>();
  const nativeRead = fs.readFile.bind(fs);
  let delayed = false;
  jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await nativeRead(...args);
    if (!delayed && args[0] === indexFile()) { delayed = true; coldEntered.resolve(); await coldGate.promise; }
    return bytes;
  });
  const reader = listRunResources(conversation);
  let published: RunResourceEntry | undefined;
  try {
    await coldEntered.promise;
    payload.gate.resolve();
    published = await writer;
  } finally { payload.gate.resolve(); coldGate.resolve(); }
  const observed = await reader;
  expect(observed.map(entry => entry.id)).toEqual([original.id, published!.id]);
  expect((await listRunResources(conversation)).map(entry => entry.id)).toEqual([original.id, published!.id]);
  expect(JSON.parse(await fs.readFile(indexFile(), 'utf8')).map((entry: RunResourceEntry) => entry.id)).toEqual([original.id, published!.id]);
});

it('reloads evicted history with its complete lineage, integrity receipt and original bytes', async () => {
  const original = await write('history');
  const access = { at: 123, source: 'mcp-read' as const, nodeId: 'reader' };
  await readRunResource(original.uri, access);
  await readRunResourceBounded(original.uri, { maxChars: 3, expectedSha256: original.sha256,
    access: { at: 124, source: 'node', nodeId: 'verifier' } });
  const before = await listRunResources(conversation);
  evictIndexes();
  expect(await listRunResources(conversation)).toEqual(before);
  expect(before[0].readBy).toHaveLength(2);
  expect(before[0].verifications).toEqual([expect.objectContaining({ ok: true, expectedSha256: original.sha256 })]);
  expect((await readRunResource(original.uri))?.contents.contents[0]).toMatchObject({ text: 'payload history' });
});

it('keeps public metadata independently mutable without growing or corrupting a cached snapshot', async () => {
  const original = await write('owned');
  const copied = await copyRunResourceToConversation({ uri: original.uri, conversationId: conversation,
    producedBy: { source: 'capture' } });
  if (!copied || 'skipped' in copied) throw new Error('Same-conversation fixture copy failed');
  const read = await readRunResource(original.uri);
  const range = await readRunResourceRange(original.uri, 0, 2);
  const bounded = await readRunResourceBounded(original.uri, { maxChars: 2, access: { at: 10, source: 'node' } });
  const found = await findRunResourceByName(conversation, 'owned');
  const listed = (await listRunResources(conversation))[0];
  const all = (await listAllRunResources())[0];
  if (!read || !range || !bounded || !found) throw new Error('Fixture metadata missing');
  const before = getRunResourceIndexPressure().serializedBytes;
  for (const entry of [original, copied, read.entry, range.entry, bounded.entry, found, listed, all]) {
    entry.name = 'caller-growth-' + 'x'.repeat(1024);
    entry.producedBy.nodeId = 'caller-only';
    entry.readBy.push({ at: -1, source: 'node' });
  }
  const [committed] = await listRunResources(conversation);
  expect(committed.name).toBe('owned');
  expect(committed.producedBy.nodeId).toBe('producer');
  expect(committed.readBy).toEqual([{ at: 10, source: 'node' }]);
  expect(getRunResourceIndexPressure().serializedBytes).toBe(before);
  clearRunResourceIndexCache();
  expect((await listRunResources(conversation))[0]).toEqual(committed);
});

it.each(['{broken-json', '{}'])('refuses to overwrite corrupt disk history (%s)', async content => {
  await write('original');
  await fs.writeFile(indexFile(), content);
  clearRunResourceIndexCache();
  const files = await fs.readdir(path.dirname(indexFile()));
  await expect(write('must-not-replace-history')).rejects.toThrow();
  expect(await fs.readFile(indexFile(), 'utf8')).toBe(content);
  expect(await fs.readdir(path.dirname(indexFile()))).toEqual(files);
});

it('does not turn an index read permission error into an empty history for the next writer', async () => {
  const original = await write('protected');
  const before = await fs.readFile(indexFile(), 'utf8');
  clearRunResourceIndexCache();
  const nativeRead = fs.readFile.bind(fs);
  const failure = Object.assign(new Error('fixture permission denied'), { code: 'EACCES' });
  const denied = jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === indexFile()) throw failure;
    return nativeRead(...args);
  });
  await expect(write('must-not-replace-history')).rejects.toBe(failure);
  denied.mockRestore();
  expect(await fs.readFile(indexFile(), 'utf8')).toBe(before);
  expect((await listRunResources(conversation)).map(entry => entry.id)).toEqual([original.id]);
});

it('invalidates a writer publication that lands after deletion was queued', async () => {
  await write('original');
  const payload = holdNextPayload();
  const writer = write('queued-before-delete');
  await payload.entered.promise;
  const deletion = deleteRunResources(conversation);
  try { payload.gate.resolve(); await writer; await deletion; }
  finally { payload.gate.resolve(); await Promise.allSettled([writer, deletion]); }
  expect(await listRunResources(conversation)).toEqual([]);
  await expect(fs.stat(path.dirname(indexFile()))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not retain a cold disk snapshot taken before deletion', async () => {
  await write('original');
  clearRunResourceIndexCache();
  const gate = deferred<void>(), entered = deferred<void>();
  const nativeRead = fs.readFile.bind(fs);
  let delayed = false;
  jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await nativeRead(...args);
    if (!delayed && args[0] === indexFile()) { delayed = true; entered.resolve(); await gate.promise; }
    return bytes;
  });
  const reader = listRunResources(conversation);
  try { await entered.promise; await deleteRunResources(conversation); }
  finally { gate.resolve(); }
  expect(await reader).toEqual([]);
  expect(await listRunResources(conversation)).toEqual([]);
});
