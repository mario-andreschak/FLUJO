import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import {
  _setModelTurnArchiveDirForTests, archiveModelDispatch, preparePagedCanonicalArchive,
  PagedCanonicalArchive,
} from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure, withArchiveWriteMemory } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (id: string, content: string) => ({ id, role: 'user' as const, timestamp: 1, content });
const request = (conversationId: string, canonicalArchive: PagedCanonicalArchive, content = '') => ({
  conversationId, nodeId: 'process', modelId: 'test', modelName: 'Test', adapter: 'openai', operation: 'create', attempt: 1,
  canonicalMessages: [], canonicalArchive,
  genericWire: [{ role: 'user' as const, content }], sdkRequest: { messages: [{ role: 'user' as const, content }] },
});

describe('canonical archive byte pages', () => {
  let directory: string;
  let previous: string | undefined;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-byte-pages-'));
    previous = _setModelTurnArchiveDirForTests(directory);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    _setModelTurnArchiveDirForTests(previous);
    await fs.rm(directory, { recursive: true, force: true });
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
  });
  const snapshot = async (conversationId: string, id: string) => JSON.parse(gunzipSync(
    await fs.readFile(path.join(directory, conversationId, `${id}.v2.json.gz`))).toString('utf8'));

  // Public APIs already exist on the baseline. Both cases fail there at the
  // archive admission boundary, rather than on an absent new implementation API.
  it.each([4_800_000, 5_200_000])('archives %i characters with both real wire occurrences below unchanged limits', async characters => {
    const content = createHash('shake256', { outputLength: characters / 2 }).update(String(characters)).digest('hex');
    const conversation = `large-${characters}`;
    const canonical = await preparePagedCanonicalArchive(conversation, [message('history', content)]);
    const entry = await archiveModelDispatch(request(conversation, canonical, content));
    const stored = await snapshot(conversation, entry.id);
    expect(stored.entry.canonicalMessageCount).toBe(1);
    expect(stored.canonicalMessages[0].content.length).toBe(characters);
    const expected = hash(content);
    expect(hash(stored.canonicalMessages[0].content)).toBe(expected);
    expect(hash(stored.genericWire[0].content)).toBe(expected);
    expect(hash(stored.sdkRequest.messages[0].content)).toBe(expected);
  }, 60_000);

  it('preserves replacements, additions, Unicode and JSON escaping on changed pages', async () => {
    const canonical = await preparePagedCanonicalArchive('updates', [message('a', 'old'), message('b', 'kept')]);
    canonical.upsert(message('a', 'new\n"\\\ud800😀'));
    canonical.upsert(message('c', 'added'));
    const entry = await archiveModelDispatch(request('updates', canonical));
    expect((await snapshot('updates', entry.id)).canonicalMessages).toEqual([
      message('a', 'new\n"\\\ud800😀'), message('b', 'kept'), message('c', 'added'),
    ]);
  });

  it('captures the dispatch update boundary before waiting for writer admission', async () => {
    const canonical = await preparePagedCanonicalArchive('queued', [message('a', 'old')]);
    canonical.upsert(message('a', 'at dispatch'));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const entered = new Promise<void>(resolve => { ready = resolve; });
    let count = 0;
    const occupiers = Array.from({ length: 4 }, () => withArchiveWriteMemory('small', async () => {
      if (++count === 4) ready();
      await held;
    }));
    await entered;
    const dispatch = archiveModelDispatch({ ...request('queued', canonical), writeAdmission: { wait: true } });
    canonical.upsert(message('a', 'later'));
    release();
    await Promise.all(occupiers);
    const entry = await dispatch;
    expect((await snapshot('queued', entry.id)).canonicalMessages[0].content).toBe('at dispatch');
  });

  it('rejects untrusted constructor metadata before reading a page', async () => {
    const forged = new PagedCanonicalArchive('forged', [{ sha256: 'a'.repeat(64), count: 1 }], 1, [], new Set(['a']));
    const open = jest.spyOn(fs, 'open');
    await expect(archiveModelDispatch(request('forged', forged))).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' });
    expect(open).not.toHaveBeenCalled();
  });

  it('reuses an existing page with a different valid gzip encoding', async () => {
    const original = [message('a', 'same history'.repeat(1000))];
    const first = await preparePagedCanonicalArchive('encoding', original);
    const file = path.join(directory, 'encoding', 'canonical', `${first.pages[0].sha256}.json.gz`);
    const bytes = await fs.readFile(file);
    const alternate = gzipSync(gunzipSync(bytes), { level: 0 });
    expect(alternate.length).not.toBe(bytes.length);
    await fs.writeFile(file, alternate);
    const second = await preparePagedCanonicalArchive('encoding', original);
    const entry = await archiveModelDispatch(request('encoding', second));
    expect((await snapshot('encoding', entry.id)).canonicalMessages).toEqual(original);
  });

  it('refuses a large changed-page materialization before opening the page', async () => {
    const content = 'a'.repeat(5_200_000);
    const canonical = await preparePagedCanonicalArchive('changed-limit', [message('a', content)]);
    canonical.upsert(message('a', 'replacement'));
    const open = jest.spyOn(fs, 'open');
    await expect(archiveModelDispatch(request('changed-limit', canonical, content)))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' });
    expect(open).not.toHaveBeenCalled();
  });

  it('settles page reads and compression before returning a snapshot open failure', async () => {
    const canonical = await preparePagedCanonicalArchive('open-failure', [message('a', 'history'.repeat(30_000))]);
    const originalOpen = fs.open.bind(fs);
    const handles = new Set<Awaited<ReturnType<typeof fs.open>>>();
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp')) throw Object.assign(new Error('open failure'), { code: 'EACCES' });
      const handle = await originalOpen(...args);
      handles.add(handle);
      const close = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); handles.delete(handle); });
      return handle;
    });
    await expect(archiveModelDispatch(request('open-failure', canonical))).rejects.toThrow('open failure');
    expect(handles.size).toBe(0);
    expect((await fs.readdir(path.join(directory, 'open-failure'))).filter(name => name !== 'canonical')).toEqual([]);
  });

  it('settles a cancelled compressed iterator and all page handles before returning a sink failure', async () => {
    const canonical = await preparePagedCanonicalArchive('sink-failure', [message('a', 'history'.repeat(30_000))]);
    const originalOpen = fs.open.bind(fs);
    const handles = new Set<Awaited<ReturnType<typeof fs.open>>>();
    jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      handles.add(handle);
      const close = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await close(); handles.delete(handle); });
      if (String(args[0]).endsWith('.tmp')) {
        jest.spyOn(handle, 'writeFile').mockImplementation(async data => {
          for await (const chunk of data as AsyncIterable<Uint8Array>) {
            expect(chunk.byteLength).toBeGreaterThan(0);
            throw new Error('sink failure');
          }
        });
      }
      return handle;
    });
    await expect(archiveModelDispatch(request('sink-failure', canonical))).rejects.toThrow('sink failure');
    expect(handles.size).toBe(0);
    expect((await fs.readdir(path.join(directory, 'sink-failure'))).filter(name => name !== 'canonical')).toEqual([]);
  });

  it.each(['truncated', 'corrupt'])('refuses a %s page without publishing a dispatch snapshot', async variant => {
    const canonical = await preparePagedCanonicalArchive(variant, [message('a', 'unchanged history')]);
    const file = path.join(directory, variant, 'canonical', `${canonical.pages[0].sha256}.json.gz`);
    const bytes = await fs.readFile(file);
    if (variant === 'truncated') await fs.writeFile(file, bytes.subarray(0, bytes.length - 1));
    else { bytes[bytes.length - 5] ^= 1; await fs.writeFile(file, bytes); }
    await expect(archiveModelDispatch(request(variant, canonical))).rejects.toThrow();
    expect((await fs.readdir(path.join(directory, variant))).filter(name => name !== 'canonical')).toEqual([]);
  });
});
