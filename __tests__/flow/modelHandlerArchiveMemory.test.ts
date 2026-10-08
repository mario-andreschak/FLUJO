import { createServer, type Server } from 'node:http';
import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';

const getModelMock = jest.fn();
let writeOpenControl: ((handle: FileHandle, file: string) => FileHandle) | undefined;
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return { ...actual, promises: { ...actual.promises,
    open: async (...args: Parameters<typeof actual.promises.open>) => {
      const handle = await actual.promises.open(...args);
      return writeOpenControl ? writeOpenControl(handle, String(args[0])) : handle;
    },
  } };
});
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModelMock(...args),
  resolveAndDecryptApiKey: async () => 'offline-not-a-secret',
} }));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (input: CompletionInput) => new LocalAdapter().createCompletion(input) }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, readModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure, MODEL_TURN_ARCHIVE_WRITE_LIMITS, withArchiveWriteMemory } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

// One application observation is one actual HTTP request in this offline fixture.
// This does not qualify the ordinary SDK's internal retry profile.
class LocalAdapter extends OpenAiAdapter {
  protected createClient(model: Model, apiKey: string): OpenAI {
    return createOpenAIClient({ baseURL: model.baseUrl, apiKey, maxRetries: 0, timeout: 5000 });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const invoke = (messages: FlujoChatMessage[], canonical = messages) => (
  ModelHandler as unknown as { generateCompletion: (
    model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, options: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { code: string; message: string } }> }
).generateCompletion('memory-model', '', messages, undefined, {
  archiveModelTurns: true, canonicalMessages: canonical,
  conversationId: 'memory-conversation', nodeId: 'memory-node', runId: 'memory-run',
});

describe('actual ModelHandler / SDK / archive memory boundary', () => {
  let server: Server;
  let root: string;
  let temporaryParent: string;
  let identity: BigIntStats;
  let parentIdentity: BigIntStats;
  let priorArchive: string | undefined;
  let priorData: string | undefined;
  let priorParentData: string | undefined;
  let requests: unknown[];
  let bad400: boolean;
  const message: FlujoChatMessage = { id: 'original', role: 'user', timestamp: 1, content: 'retained history' };

  beforeEach(async () => {
    temporaryParent = await fs.realpath(os.tmpdir());
    parentIdentity = await fs.lstat(temporaryParent, { bigint: true });
    root = await fs.mkdtemp(path.join(temporaryParent, 'flujo-archive-memory-'));
    identity = await fs.lstat(root, { bigint: true });
    priorArchive = _setModelTurnArchiveDirForTests(path.join(root, 'archives'));
    priorData = process.env.FLUJO_DATA_DIR;
    priorParentData = process.env.FLUJO_PARENT_DATA_DIR;
    process.env.FLUJO_DATA_DIR = root;
    delete process.env.FLUJO_PARENT_DATA_DIR;
    requests = [];
    bad400 = false;
    writeOpenControl = undefined;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.setHeader('Content-Type', 'application/json');
      if (bad400) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'Provider returned error (upstream: AtlasCloud: {"code":400,"msg":"bad request"})' } }));
      } else {
        response.end(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: 'offline-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'continued' } }] }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    getModelMock.mockReset().mockResolvedValue({ id: 'memory-model', name: 'offline-model', displayName: 'Offline',
      provider: 'openai', adapter: 'openai', ApiKey: 'offline-not-a-secret',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      inputModalities: ['text'], outputModalities: ['text'] });
  });

  afterEach(async () => {
    // Do not delete underneath a writer, even on a failed assertion.
    const pressure = getArchiveWritePressure();
    if (pressure.writers || pressure.quarantined || pressure.bytes) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      throw new Error(`Archive ownership still pending; preserving ${root}`);
    }
    const errors: unknown[] = [];
    const steps: Array<() => void | Promise<void>> = [
      async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
      () => { _setModelTurnArchiveDirForTests(priorArchive); },
      () => { writeOpenControl = undefined; },
      () => { if (priorData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = priorData; },
      () => { if (priorParentData === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = priorParentData; },
      async () => {
        if (errors.length) throw new Error('Earlier cleanup failed; preserving fixture');
        const resolved = path.resolve(root);
        const relative = path.relative(temporaryParent, resolved);
        const current = await fs.lstat(resolved, { bigint: true });
        const parent = await fs.lstat(temporaryParent, { bigint: true });
        if (!path.isAbsolute(root) || relative !== path.basename(resolved) || !relative.startsWith('flujo-archive-memory-')
            || current.isSymbolicLink() || !current.isDirectory() || await fs.realpath(resolved) !== resolved
            || parent.isSymbolicLink() || !parent.isDirectory() || await fs.realpath(temporaryParent) !== temporaryParent
            || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino || parent.birthtimeNs !== parentIdentity.birthtimeNs
            || current.dev !== identity.dev || current.ino !== identity.ino || current.birthtimeNs !== identity.birthtimeNs) {
          throw new Error('Fixture identity changed; preserving it');
        }
        await fs.rm(resolved, { recursive: true, force: false });
      },
    ];
    for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Offline memory fixture cleanup failed');
  });

  it('refuses the initial canonical clone before entering the actual SDK', async () => {
    const canonical = new Array<FlujoChatMessage>(MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues + 1);
    const result = await invoke([message], canonical);
    expect(result).toMatchObject({ success: false, error: { code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' } });
    expect(requests).toHaveLength(0);
    expect(canonical).toHaveLength(MODEL_TURN_ARCHIVE_WRITE_LIMITS.inspectedValues + 1);
  });

  it('refuses a per-dispatch write before cloning or starting HTTP, then admits a successor after drainage', async () => {
    const gate = deferred();
    const entered = deferred();
    let count = 0;
    const writes = Array.from({ length: 4 }, () => withArchiveWriteMemory('held', async () => {
      if (++count === 4) entered.resolve();
      await gate.promise;
    }));
    const prepare = jest.fn(() => ({ conversationId: 'no-write', nodeId: 'node', modelId: 'model', modelName: 'model',
      adapter: 'openai', operation: 'create', attempt: 1, canonicalMessages: [message], genericWire: [], sdkRequest: {} }));
    try {
      await entered.promise;
      await expect(archiveModelDispatch(prepare(), prepare)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
      // One call only builds the input references; deferred clone factory did not run.
      expect(prepare).toHaveBeenCalledTimes(1);
      const result = await invoke([message]);
      expect(result).toMatchObject({ success: false, error: { code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' } });
      expect(requests).toHaveLength(0);
    } finally { gate.resolve(); await Promise.allSettled(writes); }
    expect((await invoke([message])).success).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('archives actual 400 and continuation attempts with original canonical history and zero leaked reservations', async () => {
    bad400 = true;
    expect((await invoke([message])).success).toBe(false);
    expect(requests).toHaveLength(1);
    bad400 = false;
    expect((await invoke([message])).success).toBe(true);
    expect(requests).toHaveLength(2);
    const files = (await fs.readdir(path.join(root, 'archives', 'memory-conversation'))).filter(file => file.endsWith('.v2.json.gz'));
    expect(files).toHaveLength(2);
    const snapshots = await Promise.all(files.map(file => readModelTurnSnapshot('memory-conversation', file.slice(0, -'.v2.json.gz'.length))));
    expect(snapshots.map(snapshot => snapshot!.entry.outcome).sort()).toEqual(['completed', 'error']);
    for (const snapshot of snapshots) expect(snapshot!.canonicalMessages).toEqual([message]);
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
  });

  it('holds admission while a real snapshot write has produced disk bytes but its owned task has not drained', async () => {
    const entered = deferred();
    const release = deferred();
    let snapshotTemp: string | undefined;
    writeOpenControl = (handle, file) => {
      if (!file.replaceAll('\\', '/').includes('/archives/memory-conversation/')
          || !file.includes('.v2.json.gz.') || !file.endsWith('.tmp')) return handle;
      snapshotTemp = file;
      return new Proxy(handle, { get(target, key) {
        if (key === 'writeFile') return async (...args: Parameters<FileHandle['writeFile']>) => {
          await target.writeFile(...args); // Actual OS write, not a synthetic success.
          entered.resolve();
          await release.promise;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    const running = invoke([message]);
    try {
      await Promise.race([entered.promise, running.then(() => { throw new Error('Model call settled before the write gate'); })]);
      expect(snapshotTemp).toBeDefined();
      expect((await fs.readFile(snapshotTemp!)).byteLength).toBeGreaterThan(0);
      expect(getArchiveWritePressure().writers).toBe(1);
      expect(getArchiveWritePressure().bytes).toBeGreaterThan(0);
      expect(requests).toHaveLength(0);
      release.resolve();
      expect((await running).success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
    } finally {
      release.resolve();
      await running;
      writeOpenControl = undefined;
    }
  });
});
