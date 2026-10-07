import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, readNativeModelTurnSnapshot,
  updateModelDispatchOutcome } from '@/backend/execution/flow/modelTurnArchive';
import { withModelTurnArchiveRead } from '@/backend/execution/flow/modelTurnArchiveReadBudget';
import { assertNativeArchiveFormat } from '@/backend/execution/flow/handlers/nativeSavedOrigin';

describe('private native Original archive format composition', () => {
  let directory: string;
  let previous: string | undefined;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-archive-formats-'));
    previous = _setModelTurnArchiveDirForTests(directory);
  });
  afterEach(async () => {
    _setModelTurnArchiveDirForTests(previous);
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function fixture() {
    const entry = await archiveModelDispatch({ conversationId: 'native-format', runId: 'native-run',
      nodeId: 'native-node', modelId: 'native-model', modelName: 'offline', adapter: 'claude-cli',
      operation: 'query', attempt: 1, canonicalMessages: [], genericWire: [], sdkRequest: { saved: true } });
    const folder = path.join(directory, entry.conversationId);
    const current = path.join(folder, `${entry.id}.v2.json.gz`);
    const legacy = path.join(folder, `${entry.id}.json.gz`);
    const outcome = path.join(folder, `${entry.id}.outcome.json`);
    const snapshot = JSON.parse(gunzipSync(await fs.readFile(current)).toString('utf8'));
    const read = () => readNativeModelTurnSnapshot(entry.conversationId, entry.id, 'default-workspace');
    return { entry, current, legacy, outcome, snapshot, read };
  }
  it('binds V2 explicitly and reads its exact companion without rewriting the immutable input', async () => {
    const f = await fixture();
    const before = await fs.readFile(f.current);
    const running = await f.read();
    expect(() => assertNativeArchiveFormat(running, 2)).not.toThrow();
    expect(() => assertNativeArchiveFormat(running)).toThrow();
    expect(() => assertNativeArchiveFormat(running, 1)).toThrow();
    await updateModelDispatchOutcome(f.entry.conversationId, f.entry.id, 'completed');
    expect((await f.read()).entry.outcome).toBe('completed');
    expect(await fs.readFile(f.current)).toEqual(before);
  });
  it('accepts historical V1 only when V2 is absent and both format identities agree', async () => {
    const f = await fixture();
    f.snapshot.version = 1; f.snapshot.entry.archiveVersion = 1;
    await fs.writeFile(f.legacy, gzipSync(JSON.stringify(f.snapshot)));
    await fs.unlink(f.current);
    const legacy = await f.read();
    expect(() => assertNativeArchiveFormat(legacy)).not.toThrow();
    expect(() => assertNativeArchiveFormat(legacy, 2)).toThrow();
    f.snapshot.entry.archiveVersion = 2;
    await fs.writeFile(f.legacy, gzipSync(JSON.stringify(f.snapshot)));
    await expect(f.read()).rejects.toThrow('Invalid native');
  });
  it.each(['corrupt', 'wrong-format', 'embedded-completed'])('refuses %s V2 without falling back to valid V1', async mode => {
    const f = await fixture();
    const legacy = structuredClone(f.snapshot);
    legacy.version = 1; legacy.entry.archiveVersion = 1;
    await fs.writeFile(f.legacy, gzipSync(JSON.stringify(legacy)));
    if (mode === 'wrong-format') f.snapshot.entry.archiveVersion = 1;
    if (mode === 'embedded-completed') f.snapshot.entry.outcome = 'completed';
    await fs.writeFile(f.current, mode === 'corrupt' ? 'corrupt' : gzipSync(JSON.stringify(f.snapshot)));
    await expect(f.read()).rejects.toThrow();
  });
  it.each(['wrong-dispatch', 'wrong-conversation', 'extra-field', 'oversize', 'hardlink'])('refuses %s companion evidence', async mode => {
    const f = await fixture();
    const record = { version: 1, archiveVersion: 2, conversationId: f.entry.conversationId,
      dispatchId: f.entry.id, outcome: 'completed' };
    const invalid = mode === 'wrong-dispatch' ? { ...record, dispatchId: 'other' }
      : mode === 'wrong-conversation' ? { ...record, conversationId: 'other' }
      : mode === 'extra-field' ? { ...record, untrusted: true } : record;
    await fs.writeFile(f.outcome, mode === 'oversize' ? 'x'.repeat(1025) : JSON.stringify(invalid));
    if (mode === 'hardlink') await fs.link(f.outcome, `${f.outcome}.foreign`);
    await expect(f.read()).rejects.toThrow();
    expect(JSON.parse(gunzipSync(await fs.readFile(f.current)).toString('utf8')).entry.outcome).toBe('running');
  });
  it('shares the four-slot Core read allowance and releases it on refusal', async () => {
    const f = await fixture();
    await withModelTurnArchiveRead(() => withModelTurnArchiveRead(() =>
      withModelTurnArchiveRead(() => withModelTurnArchiveRead(async () => {
        await expect(f.read()).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_READ_BUSY' });
      }))));
    expect((await f.read()).entry.outcome).toBe('running');
  });
});
