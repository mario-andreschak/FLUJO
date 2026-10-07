import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { gzipSync, gunzipSync } from 'zlib';
import { MODEL_TURN_OUTCOME_MAX_BYTES } from '@/shared/types/modelTurn';
import { withWorkspaceRecoveryCapture, workspaceMutationStatus } from '@/backend/services/workspace/workspaceMutationGate';
import {
  _setModelTurnArchiveDirForTests,
  archiveModelDispatch,
  deleteModelTurnArchive,
  readModelTurnMedia,
  readModelTurnSnapshot,
  updateModelDispatchOutcome,
} from '@/backend/execution/flow/modelTurnArchive';

describe('modelTurnArchive', () => {
  let tempDir: string;
  let previousDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-model-turn-'));
    previousDir = _setModelTurnArchiveDirForTests(tempDir);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    _setModelTurnArchiveDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const input = (conversationId = 'large_context', attempt = 1) => ({
    conversationId, nodeId: 'model_node', modelId: 'model_test', modelName: 'Test model',
    adapter: 'openai', operation: 'create', attempt,
    canonicalMessages: [{ id: 'user_large', role: 'user' as const, timestamp: 1, content: 'history'.repeat(800_000) }],
    genericWire: [{ role: 'user' as const, content: 'wire'.repeat(500_000) }],
    sdkRequest: { image: `data:image/png;base64,${Buffer.alloc(1024 * 1024, 7).toString('base64')}` },
  });

  it('keeps each large-context/media dispatch immutable across retry outcomes without reading transcripts', async () => {
    const request = input();
    const entries = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const entry = await archiveModelDispatch({ ...request, attempt });
      const file = path.join(tempDir, request.conversationId, `${entry.id}.v2.json.gz`);
      const before = await fs.readFile(file);
      const reads = jest.spyOn(fs, 'readFile');
      const outcome = attempt === 3 ? 'completed' : 'error';
      await updateModelDispatchOutcome(request.conversationId, entry.id, outcome);
      expect(reads.mock.calls.filter(([name]) => String(name).endsWith('.json.gz'))).toEqual([]);
      reads.mockRestore();
      expect(await fs.readFile(file)).toEqual(before);
      const record = await fs.readFile(path.join(tempDir, request.conversationId, `${entry.id}.outcome.json`));
      expect(record.length).toBeLessThanOrEqual(MODEL_TURN_OUTCOME_MAX_BYTES);
      const snapshot = (await readModelTurnSnapshot(request.conversationId, entry.id))!;
      expect(snapshot.entry).toMatchObject({ id: entry.id, attempt, outcome, archiveVersion: 2 });
      expect(snapshot.canonicalMessages).toEqual(request.canonicalMessages);
      expect(snapshot.genericWire).toEqual(request.genericWire);
      expect((await readModelTurnMedia(request.conversationId, entry.id, snapshot.media[0].id))?.bytes)
        .toEqual(Buffer.alloc(1024 * 1024, 7));
      expect(JSON.parse(gunzipSync(before).toString()).entry.outcome).toBe('running');
      entries.push(entry.id);
    }
    expect(new Set(entries).size).toBe(3);
    expect(request.canonicalMessages[0].content).toBe('history'.repeat(800_000));
  });

  it('preserves running state after a failed atomic outcome write and removes its temporary file', async () => {
    const entry = await archiveModelDispatch({ ...input('failed_outcome'), canonicalMessages: [], genericWire: [], sdkRequest: {} });
    const rename = jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(updateModelDispatchOutcome('failed_outcome', entry.id, 'cancelled')).rejects.toThrow('disk unavailable');
    rename.mockRestore();
    expect((await readModelTurnSnapshot('failed_outcome', entry.id))?.entry.outcome).toBe('running');
    expect(await fs.readdir(path.join(tempDir, 'failed_outcome'))).toEqual([`${entry.id}.v2.json.gz`]);
    await updateModelDispatchOutcome('failed_outcome', entry.id, 'cancelled');
    expect((await readModelTurnSnapshot('failed_outcome', entry.id))?.entry.outcome).toBe('cancelled');
  });

  it('reads and updates historical v1 snapshots without rewriting their format', async () => {
    const entry = await archiveModelDispatch({ ...input('legacy'), canonicalMessages: [], genericWire: [], sdkRequest: {} });
    const current = path.join(tempDir, 'legacy', `${entry.id}.v2.json.gz`);
    const snapshot = JSON.parse(gunzipSync(await fs.readFile(current)).toString());
    snapshot.version = 1;
    snapshot.entry.archiveVersion = 1;
    const file = path.join(tempDir, 'legacy', `${entry.id}.json.gz`);
    await fs.writeFile(file, gzipSync(JSON.stringify(snapshot)));
    await fs.unlink(current);
    expect((await readModelTurnSnapshot('legacy', entry.id))?.version).toBe(1);
    await updateModelDispatchOutcome('legacy', entry.id, 'error');
    expect((await readModelTurnSnapshot('legacy', entry.id))?.entry).toMatchObject({ archiveVersion: 1, outcome: 'error' });
    expect(await fs.readdir(path.join(tempDir, 'legacy'))).toEqual([`${entry.id}.json.gz`]);
  });

  it('rejects a nonregular outcome descriptor before reading its bytes', async () => {
    const entry = await archiveModelDispatch({ ...input('nonregular_outcome'), canonicalMessages: [], genericWire: [], sdkRequest: {} });
    const file = path.join(tempDir, 'nonregular_outcome', `${entry.id}.outcome.json`);
    await fs.writeFile(file, '{}');
    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    jest.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === file && !swapped) {
        swapped = true;
        await fs.unlink(file);
        await fs.mkdir(file);
      }
      return originalOpen(...args);
    });
    await expect(readModelTurnSnapshot('nonregular_outcome', entry.id)).rejects.toThrow();
    expect(swapped).toBe(true);
  });

  it('rejects oversized, foreign, malformed and nonterminal outcome records without changing dispatch bytes', async () => {
    const entry = await archiveModelDispatch({ ...input('invalid_outcome'), canonicalMessages: [], genericWire: [], sdkRequest: {} });
    const file = path.join(tempDir, 'invalid_outcome', `${entry.id}.outcome.json`);
    const record = { version: 1, archiveVersion: 2, conversationId: 'invalid_outcome', dispatchId: entry.id, outcome: 'completed' };
    for (const invalid of [
      { ...record, conversationId: 'other' }, { ...record, dispatchId: 'other' },
      { ...record, outcome: 'running' }, { ...record, version: 2 }, { ...record, extra: 'unknown' },
    ]) {
      await fs.writeFile(file, JSON.stringify(invalid));
      await expect(readModelTurnSnapshot('invalid_outcome', entry.id)).rejects.toThrow('Invalid model-turn outcome');
    }
    await fs.writeFile(file, Buffer.alloc(MODEL_TURN_OUTCOME_MAX_BYTES + 1, 32));
    await expect(readModelTurnSnapshot('invalid_outcome', entry.id)).rejects.toThrow('byte limit');
    await fs.writeFile(file, '{');
    await expect(readModelTurnSnapshot('invalid_outcome', entry.id)).rejects.toThrow();
    await fs.unlink(file);
    expect((await readModelTurnSnapshot('invalid_outcome', entry.id))?.entry.outcome).toBe('running');
    await expect(updateModelDispatchOutcome('invalid_outcome', 'missing', 'completed')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(updateModelDispatchOutcome('../escape', entry.id, 'completed')).rejects.toThrow('Unsafe conversation');
  });

  it('holds model-turn outcome writes behind a coherent recovery capture', async () => {
    const entry = await archiveModelDispatch({
      conversationId: 'capture_conversation', nodeId: 'process_capture', modelId: 'model_capture',
      modelName: 'Capture model', adapter: 'openai', operation: 'create', attempt: 1,
      canonicalMessages: [], genericWire: [], sdkRequest: { messages: [] },
    });
    let update!: Promise<void>;
    let settled = false;
    await withWorkspaceRecoveryCapture(async () => {
      update = updateModelDispatchOutcome('capture_conversation', entry.id, 'completed')
        .then(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(workspaceMutationStatus().blocked).toBe(true);
      expect(settled).toBe(false);
      expect((await readModelTurnSnapshot('capture_conversation', entry.id))?.entry.outcome).toBe('running');
    });
    await update;
    expect((await readModelTurnSnapshot('capture_conversation', entry.id))?.entry.outcome).toBe('completed');
  });

  it('archives native SDK media, redacts credentials, and updates outcomes', async () => {
    const imageBytes = Buffer.from('real-image-bytes');
    const localImage = path.join(tempDir, 'request.png');
    await fs.writeFile(localImage, imageBytes);

    const entry = await archiveModelDispatch({
      conversationId: 'conversation_1',
      runId: 'run_1',
      nodeId: 'process_1',
      nodeName: 'Research',
      modelId: 'model_1',
      modelName: 'Example Model',
      adapter: 'codex-cli',
      operation: 'thread.runStreamed',
      attempt: 1,
      canonicalMessages: [{
        id: 'user_1',
        role: 'user',
        content: 'inspect this image',
        timestamp: 1,
      }],
      genericWire: [{ role: 'user', content: 'inspect this image' }],
      sdkRequest: {
        apiKey: 'must-not-survive',
        input: [{ type: 'local_image', path: localImage }],
        signedUrl: 'https://example.test/media?token=secret&keep=yes',
      },
      modelInput: {
        systemMessage: null,
        wireMessages: [],
        provenance: [{ id: 'user_1', role: 'user', status: 'emergency-stripped' }],
        counts: {
          threaded: 1,
          sent: 0,
          folded: 0,
          scopedOut: 0,
          handoffStripped: 0,
          emergencyStripped: 1,
        },
        contextCompaction: {
          events: [{
            kind: 'emergency-refit',
            reason: 'test hard limit',
            before: 1_100_000,
            after: 980_000,
            unit: 'characters',
            omittedMessages: 1,
          }],
        },
      },
    });

    expect(entry.mediaCount).toBe(1);
    expect(entry.outcome).toBe('running');

    const snapshot = await readModelTurnSnapshot('conversation_1', entry.id);
    expect(snapshot).toBeDefined();
    expect(snapshot?.sdkRequest).toMatchObject({
      apiKey: '[redacted]',
      signedUrl: 'https://example.test/media?token=%5Bredacted%5D&keep=yes',
    });
    expect(snapshot?.media[0]).toMatchObject({
      parameterPath: 'sdkRequest.input[0].path',
      kind: 'image',
      mimeType: 'image/png',
      encoding: 'file',
    });
    expect(JSON.stringify(snapshot?.sdkRequest)).not.toContain(localImage);
    expect(snapshot?.provenance?.[0].status).toBe('emergency-stripped');
    expect(snapshot?.contextCompaction?.events[0]).toMatchObject({
      kind: 'emergency-refit',
      before: 1_100_000,
      after: 980_000,
    });

    const archivedMedia = await readModelTurnMedia(
      'conversation_1',
      entry.id,
      snapshot!.media[0].id,
    );
    expect(archivedMedia?.bytes).toEqual(imageBytes);

    await updateModelDispatchOutcome('conversation_1', entry.id, 'completed');
    expect((await readModelTurnSnapshot('conversation_1', entry.id))?.entry.outcome).toBe('completed');

    await deleteModelTurnArchive('conversation_1');
    expect(await readModelTurnSnapshot('conversation_1', entry.id)).toBeUndefined();
  });

  it('redacts opaque Gemini thought signatures from diagnostic archives', async () => {
    const entry = await archiveModelDispatch({
      conversationId: 'conversation_signature',
      nodeId: 'process_signature',
      modelId: 'model_signature',
      modelName: 'Gemini',
      adapter: 'gemini',
      operation: 'models.generateContent',
      attempt: 1,
      canonicalMessages: [{
        id: 'assistant_signature',
        role: 'assistant',
        content: null,
        timestamp: 1,
        tool_calls: [{
          id: 'call_signature',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"x"}' },
          providerMetadata: { gemini: { thoughtSignature: 'opaque-signature' } },
        }],
      }],
      genericWire: [],
      sdkRequest: {
        contents: [{
          role: 'model',
          parts: [{
            functionCall: { name: 'lookup', args: { query: 'x' } },
            thoughtSignature: 'opaque-signature',
          }],
        }],
      },
    });

    const snapshot = await readModelTurnSnapshot('conversation_signature', entry.id);
    expect(snapshot?.canonicalMessages[0]).toMatchObject({
      tool_calls: [{
        providerMetadata: { gemini: { thoughtSignature: '[redacted]' } },
      }],
    });
    expect(snapshot?.sdkRequest).toMatchObject({
      contents: [{ parts: [{ thoughtSignature: '[redacted]' }] }],
    });
    expect(JSON.stringify(snapshot)).not.toContain('opaque-signature');
  });

  it('extracts inline base64 media from provider parameters', async () => {
    const entry = await archiveModelDispatch({
      conversationId: 'conversation_2',
      nodeId: 'process_2',
      modelId: 'model_2',
      modelName: 'Gemini',
      adapter: 'gemini',
      operation: 'models.generateContent',
      attempt: 1,
      canonicalMessages: [],
      genericWire: [],
      sdkRequest: {
        contents: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }],
      },
    });

    const snapshot = await readModelTurnSnapshot('conversation_2', entry.id);
    expect(snapshot?.media).toHaveLength(1);
    expect(snapshot?.media[0].encoding).toBe('base64');
    expect(JSON.stringify(snapshot?.sdkRequest)).not.toContain(Buffer.from('png').toString('base64'));
  });

  it('archives the JSON Schema projection of Zod SDK parameters, not Zod internals', async () => {
    const entry = await archiveModelDispatch({
      conversationId: 'conversation_zod',
      nodeId: 'process_zod',
      modelId: 'model_zod',
      modelName: 'Claude',
      adapter: 'claude-cli',
      operation: 'query',
      attempt: 1,
      canonicalMessages: [],
      genericWire: [],
      sdkRequest: {
        inputSchema: z.object({ query: z.string().describe('Search query') }),
      },
    });

    const snapshot = await readModelTurnSnapshot('conversation_zod', entry.id);
    expect(snapshot?.sdkRequest).toMatchObject({
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    });
    expect(JSON.stringify(snapshot?.sdkRequest)).not.toContain('_zod');
  });
});
