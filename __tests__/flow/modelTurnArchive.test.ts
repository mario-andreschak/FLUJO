import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
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
    _setModelTurnArchiveDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
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
