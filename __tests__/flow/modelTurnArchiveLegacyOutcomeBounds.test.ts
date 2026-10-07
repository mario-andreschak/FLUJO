import { promises as fs, createWriteStream } from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGzip, gzipSync, gunzipSync } from 'zlib';
import { spawnSync } from 'child_process';
import {
  _setModelTurnArchiveDirForTests, updateModelDispatchOutcome,
} from '@/backend/execution/flow/modelTurnArchive';
import {
  MODEL_TURN_ARCHIVE_READ_LIMITS, getModelTurnArchiveReadDiagnostics, withModelTurnArchiveRead,
} from '@/backend/execution/flow/modelTurnArchiveReadBudget';

describe('legacy model-turn outcome allocation bounds', () => {
  let root: string;
  let previous: string | undefined;
  const legacy = () => ({ version: 1, entry: { id: 'dispatch', conversationId: 'conversation', archiveVersion: 1,
    outcome: 'running', attempt: 1 }, canonicalMessages: [{ id: 'history', role: 'user', content: 'retained á🌍 history' }],
    genericWire: [], sdkRequest: {}, media: [{ id: 'media', sha256: 'a'.repeat(64), byteLength: 3 }] });
  const filename = () => path.join(root, 'conversation', 'dispatch.json.gz');
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-legacy-outcome-'));
    previous = _setModelTurnArchiveDirForTests(root);
    await fs.mkdir(path.join(root, 'conversation'));
    await fs.writeFile(filename(), gzipSync(JSON.stringify(legacy())));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    _setModelTurnArchiveDirForTests(previous);
    await fs.rm(root, { recursive: true, force: true });
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
  });

  it('rejects a compressed over-limit historical archive before reading its body or replacing it', async () => {
    await fs.truncate(filename(), MODEL_TURN_ARCHIVE_READ_LIMITS.compressedSnapshotBytes + 1);
    const before = await fs.stat(filename());
    const readFile = jest.spyOn(fs, 'readFile');
    const rename = jest.spyOn(fs, 'rename');
    await expect(updateModelDispatchOutcome('conversation', 'dispatch', 'completed'))
      .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_LIMIT', status: 413 });
    expect(readFile.mock.calls.filter(([file]) => String(file) === filename())).toEqual([]);
    expect(rename.mock.calls.filter(([, destination]) => String(destination) === filename())).toEqual([]);
    const after = await fs.stat(filename());
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(await fs.readdir(path.dirname(filename()))).toEqual(['dispatch.json.gz']);
  });

  it('shares the no-queue inspection allowance and leaves a busy legacy archive unchanged', async () => {
    const before = await fs.readFile(filename());
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: MODEL_TURN_ARCHIVE_READ_LIMITS.concurrentReads }, () => withModelTurnArchiveRead(() => hold));
    try {
      await expect(updateModelDispatchOutcome('conversation', 'dispatch', 'error'))
        .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_BUSY', status: 429 });
      expect(await fs.readFile(filename())).toEqual(before);
    } finally { release(); await Promise.all(held); }
    await updateModelDispatchOutcome('conversation', 'dispatch', 'error');
    const updated = JSON.parse(gunzipSync(await fs.readFile(filename())).toString('utf8'));
    expect(updated).toEqual({ ...legacy(), entry: { ...legacy().entry, outcome: 'error' } });
  });

  it('retains its permit through the atomic write and releases it after durable replacement', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const rename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (...args) => { entered(); await held; return rename(...args); });
    const update = updateModelDispatchOutcome('conversation', 'dispatch', 'cancelled');
    try { await started; expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(1); }
    finally { release(); await update; }
    expect(getModelTurnArchiveReadDiagnostics().activeReads).toBe(0);
    expect(JSON.parse(gunzipSync(await fs.readFile(filename())).toString()).entry.outcome).toBe('cancelled');
  });

  it('does not reserve a transcript inspection slot for a v2 companion outcome', async () => {
    const value = { ...legacy(), version: 2, entry: { ...legacy().entry, archiveVersion: 2 } };
    const bytes = gzipSync(JSON.stringify(value));
    await fs.writeFile(path.join(root, 'conversation', 'dispatch.v2.json.gz'), bytes);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const held = Array.from({ length: MODEL_TURN_ARCHIVE_READ_LIMITS.concurrentReads }, () => withModelTurnArchiveRead(() => hold));
    try { await updateModelDispatchOutcome('conversation', 'dispatch', 'completed'); }
    finally { release(); await Promise.all(held); }
    expect(await fs.readFile(path.join(root, 'conversation', 'dispatch.v2.json.gz'))).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(path.join(root, 'conversation', 'dispatch.outcome.json'), 'utf8')).outcome).toBe('completed');
  });

  it('bounds repeated real 96 MiB expansion attempts in a 128 MiB heap child without changing persisted history', async () => {
    const value = legacy();
    value.canonicalMessages[0].content = '__PRESSURE_CONTENT__';
    const [prefix, suffix] = JSON.stringify(value).split('__PRESSURE_CONTENT__');
    async function* chunks() {
      yield Buffer.from(prefix);
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let bytes = 0; bytes < 96 * 1024 * 1024; bytes += chunk.length) yield chunk;
      yield Buffer.from(suffix);
    }
    await pipeline(Readable.from(chunks()), createGzip(), createWriteStream(filename()));
    const allowed = ['SystemRoot', 'WINDIR', 'PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'];
    const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) as NodeJS.ProcessEnv;
    const result = spawnSync(process.execPath, ['--max-old-space-size=128', '--expose-gc',
      path.join(__dirname, 'fixtures', 'model-turn-legacy-outcome-child.cjs'), root],
    { env, encoding: 'utf8', timeout: 45_000, maxBuffer: 128 * 1024, windowsHide: true });
    expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
    const report = JSON.parse(result.stdout.trim());
    expect(report).toMatchObject({ attempts: 6, limited: 6, activeReads: 0, persistedUnchanged: true });
    expect(report.peakRss).toBeLessThan(512 * 1024 * 1024);
  }, 60_000);
});
