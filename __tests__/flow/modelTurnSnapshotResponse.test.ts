import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';
import { prepareModelTurnSnapshotResponse } from '@/backend/execution/flow/modelTurnSnapshotResponse';
import { getModelTurnArchiveReadDiagnostics, withModelTurnArchiveResponse } from '@/backend/execution/flow/modelTurnArchiveReadBudget';

const identity = { version: 2 as const, conversationId: 'conversation', dispatchId: 'dispatch' };
const snapshot = (history = 'original') => JSON.stringify({ version: 2,
  entry: { id: identity.dispatchId, conversationId: identity.conversationId, archiveVersion: 2, outcome: 'running' }, history });

describe('snapshot response resource lifetime', () => {
  let directory: string;
  let file: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'snapshot-response-'));
    file = join(directory, 'snapshot.gz');
    await fs.writeFile(file, gzipSync(snapshot()));
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  const prepare = async (signal?: AbortSignal) => prepareModelTurnSnapshotResponse(await fs.open(file, 'r'), identity, 'completed', signal);
  const settled = async () => { for (let i = 0; i < 100 && getModelTurnArchiveReadDiagnostics().activeReads; i++) await new Promise(resolve => setTimeout(resolve, 5)); };

  it('holds all four admissions until unread bodies are cancelled', async () => {
    const bodies = await Promise.all(Array.from({ length: 4 }, () => withModelTurnArchiveResponse(() => prepare())));
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(4);
    await expect(withModelTurnArchiveResponse(() => prepare())).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_BUSY' });
    await Promise.all(bodies.map(body => body!.cancel()));
    await settled();
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('preserves response JSON and releases admission after actual EOF', async () => {
    const body = await withModelTurnArchiveResponse(() => prepare());
    expect(await new Response(body).json()).toEqual({ ...JSON.parse(snapshot()), entry: { ...JSON.parse(snapshot()).entry, outcome: 'completed' } });
    await settled();
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('errors an unread response with the original abort reason and closes its descriptor', async () => {
    const controller = new AbortController();
    const handle = await fs.open(file, 'r');
    const prepared = await prepareModelTurnSnapshotResponse(handle, identity, undefined, controller.signal);
    const reason = new Error('client disconnected');
    controller.abort(reason);
    await expect(prepared.body.getReader().read()).rejects.toBe(reason);
    await prepared.completed;
    expect(handle.fd).toBe(-1);
  });

  it('rejects in-place mutation before the first emitted byte', async () => {
    const prepared = await prepare();
    await fs.writeFile(file, gzipSync(snapshot('changed')));
    await expect(prepared.body.getReader().read()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_CHANGED' });
    await prepared.completed;
  });

  it('rejects mutation between pulls before publishing another buffered chunk', async () => {
    await fs.writeFile(file, gzipSync(snapshot('x'.repeat(2 * 1024 * 1024))));
    const prepared = await prepare();
    const reader = prepared.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await fs.writeFile(file, gzipSync(snapshot('changed')));
    await expect(reader.read()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_CHANGED' });
    await prepared.completed;
  });

  it('reads the original held revision after its pathname is replaced', async () => {
    const prepared = await prepare();
    const replacement = join(directory, 'replacement.gz');
    await fs.writeFile(replacement, gzipSync(snapshot('replacement')));
    // Windows forbids rename-over-open-file; move the original aside first.
    // POSIX exercises the atomic replacement and detached-inode case.
    if (process.platform === 'win32') await fs.rename(file, join(directory, 'original.gz'));
    await fs.rename(replacement, file);
    if (process.platform === 'win32') {
      // Windows changes the held file's ctime on rename. Fail closed rather
      // than treating that event as indistinguishable from an in-place write.
      await expect(prepared.body.getReader().read()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_CHANGED' });
    } else expect((await new Response(prepared.body).json()).history).toBe('original');
    await prepared.completed;
    expect(JSON.parse(gunzipSync(await fs.readFile(file)).toString()).history).toBe('replacement');
  });

  it('closes the descriptor when validation fails before headers', async () => {
    await fs.writeFile(file, gzipSync('{"version":2,"entry":'));
    const handle = await fs.open(file, 'r');
    await expect(prepareModelTurnSnapshotResponse(handle, identity)).rejects.toThrow();
    expect(handle.fd).toBe(-1);
  });

  it('retains admission during failed close and releases only after retry succeeds', async () => {
    const handle = await fs.open(file, 'r');
    const close = handle.close.bind(handle);
    let attempts = 0;
    jest.spyOn(handle, 'close').mockImplementation(async () => {
      if (++attempts <= 3) throw new Error('transient close failure');
      await close();
    });
    const body = await withModelTurnArchiveResponse(() => prepareModelTurnSnapshotResponse(handle, identity));
    await expect(body!.cancel()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_CLEANUP_FAILED' });
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(1);
    expect(getModelTurnArchiveReadDiagnostics().quarantinedReads).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 650));
    await settled();
    expect(handle.fd).toBe(-1);
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
    expect(getModelTurnArchiveReadDiagnostics().quarantinedReads).toBe(0);
  });
});
