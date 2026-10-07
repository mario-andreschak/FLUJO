import { promises as fs } from 'fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { FileHandle } from 'fs/promises';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import type { ModelTurnSnapshot } from '@/shared/types/modelTurn';
import {
  MODEL_TURN_ARCHIVE_READ_LIMITS,
  getModelTurnArchiveReadDiagnostics,
  readBoundedModelTurnFile,
  readBoundedModelTurnJson,
  withModelTurnArchiveRead,
} from '@/backend/execution/flow/modelTurnArchiveReadBudget';
import {
  _setModelTurnArchiveDirForTests,
  readModelTurnMedia,
  readModelTurnSnapshot,
} from '@/backend/execution/flow/modelTurnArchive';

describe('model-turn archive inspection bounds', () => {
  let root: string;
  let previous: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-archive-read-'));
    previous = _setModelTurnArchiveDirForTests(root);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    _setModelTurnArchiveDirForTests(previous);
    await fs.rm(root, { recursive: true, force: true });
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
    expect(getModelTurnArchiveReadDiagnostics().reservedJsonAllocationBytes).toBe(0);
  });

  const snapshot = (): ModelTurnSnapshot => ({
    version: 2,
    entry: {
      id: 'dispatch', conversationId: 'conversation', archiveVersion: 2, outcome: 'running', attempt: 1,
      node: { nodeId: 'model-node' }, modelId: 'test-model', modelName: 'Test model', adapter: 'openai',
      operation: 'create', timestamp: 1, canonicalMessageCount: 1, wireMessageCount: 0, mediaCount: 0,
    },
    canonicalMessages: [{ id: 'canonical', role: 'user', content: 'complete retained history', timestamp: 1 }],
    genericWire: [], sdkRequest: {}, media: [],
  });

  async function writeSnapshot(value: unknown, version: 1 | 2 = 2) {
    const dir = path.join(root, 'conversation');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, version === 2 ? 'dispatch.v2.json.gz' : 'dispatch.json.gz');
    const bytes = gzipSync(JSON.stringify(value));
    await fs.writeFile(file, bytes);
    return { file, bytes };
  }

  it('admits exact compressed and decoded boundaries using real gzip and UTF-8 JSON', async () => {
    const value = { content: 'á🌍 retained history' };
    const decoded = Buffer.from(JSON.stringify(value));
    const compressed = gzipSync(decoded);
    const file = path.join(root, 'boundary.gz');
    await fs.writeFile(file, compressed);
    await expect(readBoundedModelTurnJson(file, { compressedBytes: compressed.length, decodedBytes: decoded.length }))
      .resolves.toEqual(value);
    expect(await fs.readFile(file)).toEqual(compressed);
  });

  it('rejects compressed oversize before a body allocation/read and closes the sole descriptor', async () => {
    const file = path.join(root, 'oversize');
    await fs.writeFile(file, '123456789');
    const handle = await fs.open(file, 'r');
    const original = await handle.stat({ bigint: true });
    const unchanged = Buffer.alloc(9);
    const verifyRead = handle.read.bind(handle);
    const realClose = handle.close.bind(handle);
    const realOpen = fs.open.bind(fs);
    jest.spyOn(fs, 'open').mockImplementation((...args) => args[0] === file ? Promise.resolve(handle) : realOpen(...args));
    const inspectionScope = new AsyncLocalStorage<boolean>();
    const read = jest.spyOn(handle, 'read');
    const close = jest.spyOn(handle, 'close').mockImplementation(() => inspectionScope.exit(async () => {
      try {
        // This control reads the original fixture only after the helper rejects
        // it. Keep it separate from the production read and allocation spies.
        const { bytesRead } = await verifyRead(unchanged, 0, unchanged.length, 0);
        expect(bytesRead).toBe(unchanged.length);
        const named = await fs.lstat(file, { bigint: true });
        expect(named.isFile() && !named.isSymbolicLink()).toBe(true);
        for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const) {
          expect(named[field]).toBe(original[field]);
        }
      } finally { await realClose(); }
    }));
    const bodyAllocation = jest.fn();
    const realAllocate = Buffer.alloc;
    const allocate = jest.spyOn(Buffer, 'alloc').mockImplementation((...args) => {
      if (inspectionScope.getStore()) bodyAllocation(...args);
      return realAllocate(...args);
    });
    // Schedule independent work before entering the inspection context. Its
    // allocation must not obscure the zero-allocation archive boundary.
    const independent = new Promise<Buffer>(resolve => setImmediate(() => resolve(Buffer.alloc(7))));
    await expect(inspectionScope.run(true, () => readBoundedModelTurnFile(file, 8)))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect((await independent).length).toBe(7);
    expect(allocate).toHaveBeenCalledWith(7);
    expect(read).not.toHaveBeenCalled();
    expect(bodyAllocation).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(unchanged).toEqual(Buffer.from('123456789'));
  });

  it('stops a highly compressible decoded payload at the declared zlib output limit', async () => {
    const file = path.join(root, 'expansion.gz');
    const compressed = gzipSync(JSON.stringify({ content: 'x'.repeat(4096) }));
    expect(compressed.length).toBeLessThan(128);
    await fs.writeFile(file, compressed);
    await expect(readBoundedModelTurnJson(file, { compressedBytes: 128, decodedBytes: 256 }))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect(await fs.readFile(file)).toEqual(compressed);
  });

  it.each(['growth', 'shrinkage'] as const)('limits descriptor reads and refuses %s after admission', async scenario => {
    const body = Buffer.from(scenario === 'growth' ? '123456789' : '12');
    const read = jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const copied = body.copy(buffer, offset, position, position + Math.min(length, 1));
      return { bytesRead: copied, buffer };
    });
    const close = jest.fn().mockResolvedValue(undefined);
    const handle = { stat: jest.fn().mockResolvedValue({ size: 3, isFile: () => true }), read, close };
    jest.spyOn(fs, 'open').mockResolvedValueOnce(handle as unknown as FileHandle);
    await expect(readBoundedModelTurnFile('virtual', 8)).rejects.toThrow('changed during inspection');
    expect(read.mock.calls.every(([buffer, offset, length]) => buffer.length === 4 && offset + length <= 4)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, Number.NaN])('refuses unsafe descriptor size %s before allocating', async size => {
    const read = jest.fn();
    const close = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(fs, 'open').mockResolvedValueOnce({
      stat: jest.fn().mockResolvedValue({ size, isFile: () => true }), read, close,
    } as unknown as FileHandle);
    await expect(readBoundedModelTurnFile('virtual', 8)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT' });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('retains original gzip/JSON/storage errors and releases their admission slots', async () => {
    const file = path.join(root, 'invalid.gz');
    await fs.writeFile(file, 'not gzip');
    await expect(withModelTurnArchiveRead(() => readBoundedModelTurnJson(file))).rejects.toMatchObject({ code: 'Z_DATA_ERROR' });
    await fs.writeFile(file, gzipSync('{'));
    await expect(withModelTurnArchiveRead(() => readBoundedModelTurnJson(file))).rejects.toBeInstanceOf(SyntaxError);
    const denied = Object.assign(new Error('read denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'open').mockRejectedValueOnce(denied);
    await expect(readModelTurnSnapshot('conversation', 'dispatch')).rejects.toBe(denied);
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('rejects the fifth read before invoking its task and admits new work after release', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const admitted = Array.from({ length: 4 }, () => withModelTurnArchiveRead(() => hold));
    const fifth = jest.fn().mockResolvedValue(undefined);
    const open = jest.spyOn(fs, 'open');
    const rejectedBefore = getModelTurnArchiveReadDiagnostics().rejectedReads;
    try {
      await expect(withModelTurnArchiveRead(fifth)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_BUSY', status: 429 });
      await expect(readModelTurnSnapshot('conversation', 'dispatch')).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_BUSY' });
      expect(fifth).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(getModelTurnArchiveReadDiagnostics()).toMatchObject({ activeReads: 4, rejectedReads: rejectedBefore + 2 });
    } finally {
      release();
      await Promise.all(admitted);
    }
    await expect(withModelTurnArchiveRead(async () => 'admitted')).resolves.toBe('admitted');
  });

  it('refuses dense JSON object inflation before parsing and leaves the original archive unchanged', async () => {
    const file = path.join(root, 'dense.gz');
    const compressed = gzipSync(`[${'{"a":0},'.repeat(400_000)}{}]`);
    await fs.writeFile(file, compressed);
    const parse = jest.spyOn(JSON, 'parse');
    await expect(withModelTurnArchiveRead(() => readBoundedModelTurnJson(file)))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(await fs.readFile(file)).toEqual(compressed);
    expect(getModelTurnArchiveReadDiagnostics().reservedJsonAllocationBytes).toBe(0);
  });

  it('retains JSON allocation reservation until the admitted caller finishes, including awaits after parsing', async () => {
    const { file } = await writeSnapshot(snapshot());
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const parsed = new Promise<void>(resolve => { ready = resolve; });
    const reading = withModelTurnArchiveRead(async () => {
      const result = await readBoundedModelTurnJson(file);
      ready(); await held;
      return result;
    });
    try {
      await parsed;
      expect(getModelTurnArchiveReadDiagnostics().reservedJsonAllocationBytes).toBeGreaterThan(0);
    } finally { release(); await reading; }
    expect(getModelTurnArchiveReadDiagnostics().reservedJsonAllocationBytes).toBe(0);
  });

  it('propagates pre-admission cancellation without opening a file or retaining a permit', async () => {
    const controller = new AbortController();
    const reason = new Error('inspection cancelled');
    controller.abort(reason);
    const open = jest.spyOn(fs, 'open');
    await expect(readModelTurnSnapshot('conversation', 'dispatch', controller.signal)).rejects.toBe(reason);
    await expect(readModelTurnMedia('conversation', 'dispatch', 'media', controller.signal)).rejects.toBe(reason);
    expect(open).not.toHaveBeenCalled();
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('keeps a cancelled pending read admitted until I/O settles, then closes and releases it', async () => {
    const { file, bytes } = await writeSnapshot(snapshot());
    let releaseRead!: () => void;
    const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
    let started!: () => void;
    const readStarted = new Promise<void>(resolve => { started = resolve; });
    const read = jest.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      started();
      await heldRead;
      return { bytesRead: bytes.copy(buffer, offset, position, position + length), buffer };
    });
    const close = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(fs, 'open').mockResolvedValueOnce({
      stat: jest.fn().mockResolvedValue({ size: bytes.length, isFile: () => true }), read, close,
    } as unknown as FileHandle);
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    const inspection = readModelTurnSnapshot('conversation', 'dispatch', controller.signal);
    let settled = false;
    const observedSettlement = inspection.then(() => { settled = true; }, () => { settled = true; });
    try {
      await readStarted;
      controller.abort(reason);
      expect(settled).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(1);
    } finally { releaseRead(); await observedSettlement; }
    await expect(inspection).rejects.toBe(reason);
    await observedSettlement;
    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
    await expect(withModelTurnArchiveRead(async () => 'next inspection')).resolves.toBe('next inspection');
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('closes and releases a permit after a descriptor read failure', async () => {
    const failure = Object.assign(new Error('descriptor read failed'), { code: 'EIO' });
    const close = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(fs, 'open').mockResolvedValueOnce({
      stat: jest.fn().mockResolvedValue({ size: 3, isFile: () => true }),
      read: jest.fn().mockRejectedValue(failure), close,
    } as unknown as FileHandle);
    await expect(withModelTurnArchiveRead(() => readBoundedModelTurnFile('virtual', 8))).rejects.toBe(failure);
    expect(close).toHaveBeenCalledTimes(1);
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('keeps v2 dispatch bytes and canonical history immutable while applying an outcome sidecar', async () => {
    const value = snapshot();
    const { file, bytes } = await writeSnapshot(value);
    await fs.writeFile(path.join(root, 'conversation', 'dispatch.outcome.json'), JSON.stringify({
      version: 1, archiveVersion: 2, conversationId: 'conversation', dispatchId: 'dispatch', outcome: 'error',
    }));
    const result = await readModelTurnSnapshot('conversation', 'dispatch');
    expect(result?.canonicalMessages).toEqual(value.canonicalMessages);
    expect(result?.entry).toMatchObject({ id: 'dispatch', attempt: 1, outcome: 'error' });
    expect(await fs.readFile(file)).toEqual(bytes);
  });

  it('bounds historical v1 reads without changing their format or missing-record behavior', async () => {
    const value = snapshot();
    const legacy = { ...value, version: 1, entry: { ...value.entry, archiveVersion: 1, outcome: 'completed' } };
    const { file, bytes } = await writeSnapshot(legacy, 1);
    await expect(readModelTurnSnapshot('conversation', 'dispatch')).resolves.toEqual(legacy);
    expect(await fs.readFile(file)).toEqual(bytes);
    await expect(readModelTurnSnapshot('conversation', 'missing')).resolves.toBeUndefined();
  });

  it('rejects a sparse over-limit snapshot on the public path without falling back or mutating it', async () => {
    const { file } = await writeSnapshot(snapshot());
    await fs.truncate(file, MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes + 1);
    await expect(readModelTurnSnapshot('conversation', 'dispatch')).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect((await fs.stat(file)).size).toBe(MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes + 1);
    expect(await fs.readdir(path.dirname(file))).toEqual(['dispatch.v2.json.gz']);
  });

  it('shares one slot between snapshot and media and refuses sparse oversized media', async () => {
    const hash = 'a'.repeat(64);
    const value: ModelTurnSnapshot = {
      ...snapshot(), media: [{
        id: 'media', sha256: hash, mimeType: 'image/png', byteLength: 3,
        parameterPath: 'image', kind: 'image', encoding: 'file',
      }],
    };
    const { file, bytes } = await writeSnapshot(value);
    const mediaDir = path.join(root, 'conversation', 'media');
    await fs.mkdir(mediaDir);
    const mediaFile = path.join(mediaDir, hash);
    await fs.writeFile(mediaFile, 'png');
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: 3 }, () => withModelTurnArchiveRead(() => hold));
    try {
      expect((await readModelTurnMedia('conversation', 'dispatch', 'media'))?.bytes).toEqual(Buffer.from('png'));
    } finally { release(); await Promise.all(held); }
    await fs.truncate(mediaFile, MODEL_TURN_ARCHIVE_READ_LIMITS.mediaBytes + 1);
    await expect(readModelTurnMedia('conversation', 'dispatch', 'media')).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect(await fs.readFile(file)).toEqual(bytes);
    expect((await fs.stat(mediaFile)).size).toBe(MODEL_TURN_ARCHIVE_READ_LIMITS.mediaBytes + 1);
  });
});
