import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {
  writeRunResource, copyRunResourceToConversation, listRunResources, getRunResourceLocalPath,
  getRunResourceCopyPressure, _setRunResourcesDirForTests, _clearRunResourceSettingsCache,
  type CopyRunResourceResult,
} from '@/backend/services/runResources';
import { writeFileAtomic } from '@/utils/storage/backend';
import { withWorkspaceMutation, beginWorkspaceSnapshotBoundary } from '@/backend/services/workspace/workspaceMutationGate';
import { DEFAULT_RUN_RESOURCE_SETTINGS, type RunResourceEntry } from '@/shared/types/runResources';

jest.mock('@/utils/storage/backend', () => ({
  ...jest.requireActual('@/utils/storage/backend'),
  loadItem: jest.fn(async () => ({ ...DEFAULT_RUN_RESOURCE_SETTINGS })),
  writeFileAtomic: jest.fn((...args: Parameters<typeof writeFileAtomic>) =>
    jest.requireActual('@/utils/storage/backend').writeFileAtomic(...args)),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug() {}, error() {}, warn() {} }) }));

let root: string;
let previousRoot: string;
let entry: RunResourceEntry;
let filename: string;
const producer = { source: 'capture' as const, nodeId: 'parent-node' };
const destination = 'parent-copy';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const payload = (resource: RunResourceEntry) => path.join(root, resource.conversationId, resource.id + '.dat');
function resource(result: CopyRunResourceResult | null): RunResourceEntry {
  if (!result || 'skipped' in result) throw new Error('Expected a copied resource');
  return result;
}
const copy = (conversationId = destination, name?: string) => copyRunResourceToConversation({
  uri: entry.uri, conversationId, name, producedBy: producer,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-run-resource-copy-'));
  previousRoot = _setRunResourcesDirForTests(root);
  _clearRunResourceSettingsCache();
  entry = resource(await writeRunResource({
    conversationId: 'child-copy', kind: 'blob', mimeType: 'video/mp4',
    data: { base64: Buffer.from('head').toString('base64') }, producedBy: { source: 'model-output' },
  }));
  filename = payload(entry);
});
afterEach(async () => {
  jest.restoreAllMocks();
  jest.mocked(writeFileAtomic).mockImplementation((...args) =>
    jest.requireActual('@/utils/storage/backend').writeFileAtomic(...args));
  _setRunResourcesDirForTests(previousRoot);
  _clearRunResourceSettingsCache();
  expect(getRunResourceCopyPressure()).toMatchObject({ active: 0, queued: 0 });
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('flujo-run-resource-copy-')) {
    throw new Error('Unsafe fixture cleanup directory');
  }
  await fs.rm(root, { recursive: true, force: true });
});

function instrument(hooks: {
  afterStat?: () => Promise<void>; beforeRead?: () => Promise<void>;
  shortReads?: boolean; shortWrites?: boolean; failWrite?: boolean;
} = {}) {
  const counts = { sourceOpened: 0, sourceClosed: 0, destinationOpened: 0, destinationClosed: 0,
    readBytes: 0, writtenBytes: 0, maxReadBuffer: 0, maxWriteBuffer: 0, wholeFilePayloadBytes: 0, peakOpenSources: 0 };
  const readFile = fs.readFile.bind(fs);
  jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await readFile(...args);
    if (args[0] === filename) counts.wholeFilePayloadBytes += typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
    return bytes;
  });
  const open = fs.open.bind(fs);
  jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    const isSource = args[0] === filename;
    const isDestination = typeof args[0] === 'string' && args[0].endsWith('.dat') && !isSource;
    if (!isSource && !isDestination) return handle;
    if (isSource) {
      counts.sourceOpened++;
      counts.peakOpenSources = Math.max(counts.peakOpenSources, counts.sourceOpened - counts.sourceClosed);
      const stat = handle.stat.bind(handle);
      jest.spyOn(handle, 'stat').mockImplementation(async () => {
        const result = await stat();
        await hooks.afterStat?.();
        return result;
      });
      const read = handle.read.bind(handle);
      jest.spyOn(handle, 'read').mockImplementation(async (...args: unknown[]) => {
        const [buffer, offset, length, position] = args as [Buffer, number, number, number];
        await hooks.beforeRead?.();
        counts.maxReadBuffer = Math.max(counts.maxReadBuffer, buffer.length);
        const result = await read(buffer, offset, hooks.shortReads ? Math.min(1, length) : length, position);
        counts.readBytes += result.bytesRead;
        return result;
      });
    } else {
      counts.destinationOpened++;
      const write = handle.write.bind(handle);
      // Jest otherwise selects FileHandle.write's final (string) overload.
      // This instrumentation observes the real Buffer overload used by copies.
      const bufferWriter = handle as unknown as {
        write(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesWritten: number; buffer: Buffer }>;
      };
      jest.spyOn(bufferWriter, 'write').mockImplementation(async (buffer, offset, length, position) => {
        if (hooks.failWrite) throw new Error('Injected destination I/O failure');
        counts.maxWriteBuffer = Math.max(counts.maxWriteBuffer, buffer.length);
        const result = await write(buffer, offset, hooks.shortWrites ? Math.min(1, length) : length, position);
        counts.writtenBytes += result.bytesWritten;
        return result;
      });
    }
    const close = handle.close.bind(handle);
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      if (isSource) counts.sourceClosed++; else counts.destinationClosed++;
      await close();
    });
    return handle;
  });
  return counts;
}

it('copies a real 32 MiB payload without full-file or base64 allocations under default quotas', async () => {
  const size = 32 * 1024 * 1024;
  await fs.truncate(filename, size);
  const hash = createHash('sha256').update('head');
  const zeros = Buffer.alloc(64 * 1024);
  for (let left = size - 4; left > 0; left -= zeros.length) hash.update(zeros.subarray(0, Math.min(left, zeros.length)));
  const expected = hash.digest('hex');
  const counts = instrument();
  const copied = resource(await copy());
  expect(copied).toMatchObject({ size, sha256: expected, mimeType: entry.mimeType, kind: entry.kind,
    encoding: entry.encoding, origin: { server: 'flujo', uri: entry.uri }, producedBy: producer });
  expect(copied.uri).not.toBe(entry.uri);
  expect(counts.wholeFilePayloadBytes).toBe(0);
  expect(counts.readBytes).toBe(size);
  expect(counts.writtenBytes).toBe(size);
  expect(counts.maxReadBuffer).toBeLessThanOrEqual(64 * 1024);
  expect(counts.maxWriteBuffer).toBeLessThanOrEqual(64 * 1024);
  expect(counts.sourceClosed).toBe(1);
  expect(counts.destinationClosed).toBe(1);
  expect((await fs.stat(filename)).size).toBe(size);
  expect((await fs.stat(payload(copied))).size).toBe(size);
  _setRunResourcesDirForTests(root);
  expect((await listRunResources(destination))[0]).toMatchObject({ id: copied.id, size, sha256: expected });
});

it('refuses an actual source above the 50 MiB cap before reading or creating a destination', async () => {
  await fs.truncate(filename, DEFAULT_RUN_RESOURCE_SETTINGS.maxResourceBytes + 1);
  const counts = instrument();
  expect(await copy()).toEqual({ skipped: 'size-cap' });
  expect(counts).toMatchObject({ readBytes: 0, destinationOpened: 0, sourceClosed: 1 });
  expect(await listRunResources(destination)).toEqual([]);
});

async function occupyDestination(bytes: number) {
  const entries: RunResourceEntry[] = [];
  for (let left = bytes; left > 0; left -= DEFAULT_RUN_RESOURCE_SETTINGS.maxResourceBytes) {
    const item = resource(await writeRunResource({ conversationId: destination, kind: 'text',
      data: { text: 'used' }, producedBy: producer }));
    entries.push({ ...item, size: Math.min(left, DEFAULT_RUN_RESOURCE_SETTINGS.maxResourceBytes) });
  }
  // Quotas use the persisted destination index; source byte size must instead
  // come from its descriptor. This fixture records an already occupied quota.
  await fs.writeFile(path.join(root, destination, 'index.json'), JSON.stringify(entries));
  _setRunResourcesDirForTests(root);
}
it('charges actual snapshot bytes against the default conversation quota before copying', async () => {
  await fs.truncate(filename, 128);
  await occupyDestination(DEFAULT_RUN_RESOURCE_SETTINGS.maxConversationBytes - 16);
  const counts = instrument();
  expect(await copy()).toEqual({ skipped: 'conversation-cap' });
  expect(counts).toMatchObject({ readBytes: 0, destinationOpened: 0, sourceClosed: 1 });
});

it('serializes concurrent destination quota checks, keeping the accepted complete resource', async () => {
  await fs.truncate(filename, 32);
  await occupyDestination(DEFAULT_RUN_RESOURCE_SETTINGS.maxConversationBytes - 32);
  const counts = instrument();
  const results = await Promise.all([copy(), copy()]);
  expect(results.filter(item => item && 'skipped' in item)).toEqual([{ skipped: 'conversation-cap' }]);
  const copied = resource(results.find(item => item && !('skipped' in item))!);
  expect((await fs.stat(payload(copied))).size).toBe(32);
  expect(counts.readBytes).toBe(32);
  expect(counts.destinationOpened).toBe(1);
});

it.each([
  { shortReads: true, shortWrites: false },
  { shortReads: false, shortWrites: true },
  { shortReads: true, shortWrites: true },
])('handles partial I/O without changing UTF-8 or binary bytes (%j)', async hooks => {
  const bytes = Buffer.concat([Buffer.from('☂😀テスト'), Buffer.from([0xff, 0, 0x80])]);
  await fs.writeFile(filename, bytes);
  const counts = instrument(hooks);
  const copied = resource(await copy());
  expect(await fs.readFile(payload(copied))).toEqual(bytes);
  expect(copied.sha256).toBe(sha256(bytes));
  expect(counts.readBytes).toBe(bytes.length);
  expect(counts.writtenBytes).toBe(bytes.length);
  expect(counts.sourceClosed).toBe(1);
  expect(counts.destinationClosed).toBe(1);
});

it('preserves complete text, archive lineage and encoding with a new parent-owned identity', async () => {
  const text = '⚡ 😀é終 exact source text';
  const archive = { archiveId: 'archive-copy', role: 'source' as const, route: 'raw' as const, sourceSha256: sha256(text) };
  entry = resource(await writeRunResource({ conversationId: 'child-copy', kind: 'text', mimeType: 'text/plain',
    data: { text }, archive, producedBy: { source: 'visual-archive' } }));
  filename = payload(entry);
  const counts = instrument();
  const copied = resource(await copy());
  expect(copied).toMatchObject({ kind: 'text', encoding: 'utf8', archive, sha256: entry.sha256,
    readBy: [], verifications: [], origin: { server: 'flujo', uri: entry.uri } });
  expect(await fs.readFile(payload(copied), 'utf8')).toBe(text);
  expect(counts.wholeFilePayloadBytes).toBe(0);
  expect((await listRunResources(entry.conversationId)).find(item => item.id === entry.id)?.readBy).toEqual([]);
});

it('copies the checked source descriptor after a pathname replacement', async () => {
  let replaced = false;
  const counts = instrument({ afterStat: async () => {
    if (replaced) return;
    replaced = true;
    await fs.rename(filename, path.join(root, 'opened-original.dat'));
    await fs.writeFile(filename, 'Unchecked replacement');
  } });
  const copied = resource(await copy());
  expect(await fs.readFile(payload(copied))).toEqual(Buffer.from('head'));
  expect(copied.sha256).toBe(sha256('head'));
  expect(counts.sourceClosed).toBe(1);
});

it.each(['grow', 'truncate'] as const)('does not publish a source changed while copying (%s)', async change => {
  await fs.truncate(filename, 128 * 1024);
  let changed = false;
  const counts = instrument({ beforeRead: async () => {
    if (changed) return;
    changed = true;
    if (change === 'grow') await fs.appendFile(filename, 'changed');
    else await fs.truncate(filename, 1);
  } });
  await expect(copy()).rejects.toThrow('changed');
  expect(await listRunResources(destination)).toEqual([]);
  expect((await fs.readdir(path.join(root, destination))).filter(name => name.endsWith('.dat'))).toEqual([]);
  expect(counts.sourceClosed).toBe(1);
  expect(counts.destinationClosed).toBe(1);
});

it('keeps the old named resource when destination I/O fails and removes the partial new payload', async () => {
  const old = resource(await writeRunResource({ conversationId: destination, name: 'asset', kind: 'blob',
    data: { base64: Buffer.from('old').toString('base64') }, mimeType: 'video/mp4', producedBy: producer }));
  const local = await getRunResourceLocalPath(old.uri);
  const counts = instrument({ failWrite: true });
  await expect(copy(destination, 'asset')).rejects.toThrow('Injected destination');
  expect((await listRunResources(destination)).map(item => item.id)).toEqual([old.id]);
  expect(await fs.readFile(local!)).toEqual(Buffer.from('old'));
  expect((await fs.readdir(path.join(root, destination))).filter(name => name.endsWith('.dat'))).toEqual([old.id + '.dat']);
  expect(counts.sourceClosed).toBe(1);
  expect(counts.destinationClosed).toBe(1);
});

it('replaces a named payload only after copying and removes its old materialized hard link', async () => {
  const old = resource(await writeRunResource({ conversationId: destination, name: 'asset', kind: 'blob',
    data: { base64: Buffer.from('old').toString('base64') }, mimeType: 'video/mp4', producedBy: producer }));
  const local = await getRunResourceLocalPath(old.uri);
  const copied = resource(await copy(destination, 'asset'));
  expect((await listRunResources(destination)).map(item => item.id)).toEqual([copied.id]);
  await expect(fs.access(local!)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(payload(old))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(payload(copied))).toEqual(Buffer.from('head'));
});

it.each([false, true])('reloads the authoritative index after a failed publication (rename completed: %s)', async renamed => {
  const old = resource(await writeRunResource({ conversationId: destination, name: 'asset', kind: 'text',
    data: { text: 'old' }, producedBy: producer }));
  const actual = jest.requireActual('@/utils/storage/backend').writeFileAtomic as typeof writeFileAtomic;
  jest.mocked(writeFileAtomic).mockImplementationOnce(async (filename, data) => {
    if (renamed) await actual(filename, data);
    throw new Error('Injected index publication failure');
  });
  await expect(copy(destination, 'asset')).rejects.toThrow('Injected index publication');
  const entries = await listRunResources(destination);
  expect(entries).toHaveLength(1);
  expect(entries[0].id === old.id).toBe(!renamed);
  expect(await fs.readFile(payload(entries[0]))).toEqual(Buffer.from(renamed ? 'head' : 'old'));
  // An ambiguous index failure keeps both payloads for safe recovery; it must
  // never delete bytes that a successful rename may have durably referenced.
  expect(await fs.readFile(payload(old))).toEqual(Buffer.from('old'));
});

it('preserves empty payload files and returns same-conversation resources without loading bytes', async () => {
  await fs.truncate(filename, 0);
  const counts = instrument();
  expect(await copy(entry.conversationId)).toEqual(entry);
  const copied = resource(await copy());
  expect(copied).toMatchObject({ size: 0, sha256: sha256('') });
  expect((await fs.stat(payload(copied))).size).toBe(0);
  expect(counts.readBytes).toBe(0);
  expect(counts.sourceClosed).toBe(2);
});

it('preserves remote link origins without opening a payload and refuses missing/nonregular sources', async () => {
  const link = resource(await writeRunResource({ conversationId: 'child-copy', kind: 'link',
    origin: { server: 'remote', uri: 'remote://object' }, producedBy: { source: 'mcp-link' } }));
  const counts = instrument();
  const copied = resource(await copyRunResourceToConversation({ uri: link.uri, conversationId: destination, producedBy: producer }));
  expect(copied).toMatchObject({ kind: 'link', size: 0, origin: link.origin });
  expect(counts.sourceOpened).toBe(0);
  await fs.unlink(filename);
  expect(await copy()).toBeNull();
  await fs.mkdir(filename);
  expect(await copy()).toBeNull();
  expect(await copyRunResourceToConversation({ uri: 'flujo://run/../../bad', conversationId: destination, producedBy: producer })).toBeNull();
});

it('refuses queue overload before opening payloads and drains twelve admitted requests', async () => {
  // All calls here are already admitted workspace work, so file-lock admission
  // timing cannot make copy-queue assertions depend on unrelated disk latency.
  await withWorkspaceMutation(async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const fourStarted = new Promise<void>(resolve => { started = resolve; });
  let reads = 0;
  const counts = instrument({ beforeRead: async () => { if (++reads === 4) started(); await blocked; } });
  const rejectedBefore = getRunResourceCopyPressure().rejected;
  const pending = Array.from({ length: 12 }, (_, i) => copy('queued-parent-' + i));
  let overflow: ReturnType<typeof copy> | undefined;
  try {
    await fourStarted;
    expect(getRunResourceCopyPressure()).toMatchObject({ active: 4, queued: 8 });
    expect(counts.sourceOpened).toBe(4);
    expect(counts.destinationOpened).toBe(4);
    overflow = copy('rejected-parent');
    expect(getRunResourceCopyPressure()).toMatchObject({ active: 4, queued: 8, rejected: rejectedBefore + 1 });
    expect(await overflow).toEqual({ skipped: 'copy-pressure' });
    expect(counts.sourceOpened).toBe(4);
  } finally {
    release();
    const results = await Promise.all(pending);
    if (overflow) await overflow;
    expect(results.every(result => result && !('skipped' in result))).toBe(true);
  }
  expect(counts.sourceOpened).toBe(12);
  expect(counts.sourceClosed).toBe(12);
  expect(counts.peakOpenSources).toBeLessThanOrEqual(4);
  expect(counts.destinationClosed).toBe(12);
  });
});

it('lets an admitted copy drain a snapshot before newer copies acquire slots', async () => {
  let admitted!: () => void;
  const outerAdmitted = new Promise<void>(resolve => { admitted = resolve; });
  let runOlder!: () => void;
  const runCopy = new Promise<void>(resolve => { runOlder = resolve; });
  const counts = instrument();
  const older = withWorkspaceMutation(async () => { admitted(); await runCopy; return copy('older-parent'); });
  await outerAdmitted;
  const capture = beginWorkspaceSnapshotBoundary(undefined, 2000);
  const newer = Array.from({ length: 4 }, (_, i) => copy('snapshot-newer-' + i));
  let boundary: Awaited<typeof capture> | undefined;
  try {
    expect(getRunResourceCopyPressure()).toMatchObject({ active: 0, queued: 0 });
    runOlder();
    boundary = await capture;
    expect(resource(await older).conversationId).toBe('older-parent');
    expect(counts.sourceOpened).toBe(1);
    expect(counts.sourceClosed).toBe(1);
  } finally {
    runOlder();
    if (!boundary) boundary = await capture.catch(() => undefined);
    boundary?.release();
    await older.catch(() => undefined);
    await Promise.all(newer);
  }
  expect(counts.sourceOpened).toBe(5);
  expect(counts.sourceClosed).toBe(5);
});
