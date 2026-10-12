import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import { observeSdkRequest, type CompletionInput } from '@/backend/services/model/adapters/types';
import {
  _setModelTurnArchiveDirForTests, archiveModelDispatch, readModelTurnSnapshot, updateModelDispatchOutcome,
} from '@/backend/execution/flow/modelTurnArchive';

// Keep HTTP retries inside the SDK disabled here so each observed adapter/SDK
// invocation is joined to one actual loopback HTTP request. No live provider.
class LocalAdapter extends OpenAiAdapter {
  protected createClient(model: Model, apiKey: string): OpenAI {
    return createOpenAIClient({ baseURL: model.baseUrl, apiKey, maxRetries: 0, timeout: 5000 });
  }
}

describe('model-turn outcomes at real SDK boundaries', () => {
  let server: Server;
  let tempDir: string;
  let previousDir: string | undefined;
  let url: string;
  let requests: Record<string, unknown>[];
  let mode: 'success' | 'bad400' | 'retry503' | 'cache-reject';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-archive-sdk-'));
    previousDir = _setModelTurnArchiveDirForTests(tempDir);
    requests = [];
    mode = 'success';
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      res.setHeader('Content-Type', 'application/json');
      if (mode === 'bad400') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'Provider returned error (upstream: AtlasCloud: {"code":400,"msg":"bad request"})' } }));
      } else if (mode === 'retry503' && requests.length === 1) {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: { message: 'service unavailable' } }));
      } else if (mode === 'cache-reject' && body.prompt_cache_key) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: 'unknown parameter prompt_cache_key' } }));
      } else {
        res.end(JSON.stringify({ id: 'local_completion', object: 'chat.completion', created: 1, model: 'local-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'resumed' } }] }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    _setModelTurnArchiveDirForTests(previousDir);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function fixture() {
    const canonicalMessages = [{ id: 'user_original', role: 'user' as const, timestamp: 1, content: 'context'.repeat(100_000) }];
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: canonicalMessages[0].content }];
    const dispatches: string[] = [];
    const input: CompletionInput = {
      model: { id: 'local', name: 'local-model', ApiKey: 'fixture', adapter: 'openai', provider: 'openai', baseUrl: url },
      apiKey: 'local-not-a-secret', messages,
      onSdkRequest: async snapshot => {
        const entry = await archiveModelDispatch({ conversationId: 'conversation', nodeId: 'model_node',
          modelId: 'local', modelName: 'Local fixture', adapter: snapshot.adapter, operation: snapshot.operation,
          attempt: dispatches.length + 1, canonicalMessages, genericWire: snapshot.wireMessages ?? messages,
          sdkRequest: snapshot.request });
        dispatches.push(entry.id);
        return entry.id;
      },
      onSdkRequestResult: async ({ dispatchId, outcome }) => updateModelDispatchOutcome('conversation', dispatchId, outcome),
    };
    return { input, dispatches, canonicalMessages };
  }

  it('retains one marker for a provider 400, then resumes with unchanged canonical history', async () => {
    const { input, dispatches, canonicalMessages } = fixture();
    mode = 'bad400';
    await expect(new LocalAdapter().createCompletion(input)).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
    expect(dispatches).toHaveLength(1);
    expect((await readModelTurnSnapshot('conversation', dispatches[0]))?.entry.outcome).toBe('error');
    mode = 'success';
    expect((await new LocalAdapter().createCompletion(input)).completion.choices[0].message.content).toBe('resumed');
    expect(requests).toHaveLength(2);
    expect(new Set(dispatches).size).toBe(2);
    for (const [index, id] of dispatches.entries()) {
      const snapshot = (await readModelTurnSnapshot('conversation', id))!;
      expect(snapshot.canonicalMessages).toEqual(canonicalMessages);
      expect(snapshot.entry).toMatchObject({ attempt: index + 1, outcome: index ? 'completed' : 'error' });
    }
  });

  it.each(['retry503', 'cache-reject'] as const)('preserves separate immutable SDK markers through %s', async scenario => {
    const { input, dispatches } = fixture();
    mode = scenario;
    if (scenario === 'cache-reject') input.promptCacheKey = 'local-cache-key';
    await new LocalAdapter().createCompletion(input);
    expect(requests).toHaveLength(2);
    expect(new Set(dispatches).size).toBe(2);
    const snapshots = await Promise.all(dispatches.map(id => readModelTurnSnapshot('conversation', id)));
    expect(snapshots.map(snapshot => snapshot!.entry.outcome)).toEqual(['error', 'completed']);
    expect(snapshots.map(snapshot => snapshot!.entry.attempt)).toEqual([1, 2]);
    if (scenario === 'cache-reject') {
      expect(snapshots[0]!.sdkRequest).toHaveProperty('prompt_cache_key', 'local-cache-key');
      expect(snapshots[1]!.sdkRequest).not.toHaveProperty('prompt_cache_key');
    }
  });

  it('retains a suspended streaming dispatch and canonical history until iteration completes', async () => {
    const { input, dispatches, canonicalMessages } = fixture();
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const stream = await observeSdkRequest(input,
      { adapter: 'local-stream', operation: 'stream', request: { messages: input.messages } },
      async () => (async function* () { yield 'partial'; await hold; yield 'final'; })());
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('partial');
    expect((await readModelTurnSnapshot('conversation', dispatches[0]))?.entry.outcome).toBe('running');
    expect((await readModelTurnSnapshot('conversation', dispatches[0]))?.canonicalMessages).toEqual(canonicalMessages);
    release();
    expect((await iterator.next()).value).toBe('final');
    expect((await iterator.next()).done).toBe(true);
    expect((await readModelTurnSnapshot('conversation', dispatches[0]))?.entry.outcome).toBe('completed');
  });
});
