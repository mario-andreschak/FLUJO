import { createServer, type Server } from 'node:http';
import { promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import type OpenAI from 'openai';
import type { Model } from '@/shared/types/model';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { CompletionInput } from '@/backend/services/model/adapters/types';
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { OpenAiResponsesAdapter } from '@/backend/services/model/adapters/openaiResponsesAdapter';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import { cancelAllToolCalls, listInFlightToolCalls } from '@/backend/execution/flow/toolCancelRegistry';

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
// Re-export the real module as plain properties so tests can inject a refusal.
jest.mock('@/backend/execution/flow/conversationPublication', () => ({ __esModule: true, ...jest.requireActual('@/backend/execution/flow/conversationPublication') }));
jest.mock('@/backend/services/model', () => ({ modelService: {
  getModel: (...args: unknown[]) => getModelMock(...args),
  resolveAndDecryptApiKey: async () => 'offline-not-a-secret',
} }));
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: () => ({ createCompletion: (input: CompletionInput) => responsesMode
    ? new OpenAiResponsesAdapter().createCompletion(input) : new LocalAdapter().createCompletion(input),
    createStreamCompletion: (input: CompletionInput) => responsesMode
      ? new OpenAiResponsesAdapter().createStreamCompletion(input) : new LocalAdapter().createStreamCompletion(input) }),
}));

import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { COMPACTION_SUMMARY_SECTIONS } from '@/backend/execution/flow/handlers/summarizingCompaction';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, readModelTurnSnapshot, readModelTurnSnapshotResponse, updateModelDispatchOutcome } from '@/backend/execution/flow/modelTurnArchive';
import { getArchiveWritePressure, MODEL_TURN_ARCHIVE_WRITE_LIMITS, withArchiveWriteMemory } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { _setConversationLogDirForTests, allocateSeq, flushConversationLog } from '@/backend/execution/flow/conversationLog';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import { ConversationPublicationError, getConversationPublicationDiagnostics } from '@/backend/execution/flow/conversationPublication';
import * as publicationModule from '@/backend/execution/flow/conversationPublication';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';

// One application observation is one actual HTTP request in this offline fixture.
// This does not qualify the ordinary SDK's internal retry profile.
let archiveMetadata: Record<string, unknown> | undefined;
let sdkRequestObserved: (() => void) | undefined;
let responsesMode: 'recover' | 'refuse' | 'partial' | 'unavailable' | undefined;
let transcriptRevisions = 0;
class LocalAdapter extends OpenAiAdapter {
  async createCompletion(input: CompletionInput) {
    for (let revision = 0; revision < transcriptRevisions; revision++) {
      input.onTranscriptMessage?.({ id: 'same-streamed-message', timestamp: revision, role: 'assistant', content: 'x'.repeat(250_000) });
    }
    return super.createCompletion({ ...input, onSdkRequest: snapshot => {
      sdkRequestObserved?.();
      return input.onSdkRequest?.({
        ...snapshot, request: archiveMetadata ? { ...(snapshot.request as Record<string, unknown>), ...archiveMetadata } : snapshot.request,
      }) ?? Promise.resolve(undefined);
    } });
  }
  protected createClient(model: Model, apiKey: string): OpenAI {
    return createOpenAIClient({ baseURL: model.baseUrl, apiKey, maxRetries: 0, timeout: 5000 });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const invoke = (messages: FlujoChatMessage[], canonical = messages, options: Record<string, unknown> = {}) => (
  ModelHandler as unknown as { generateCompletion: (
    model: string, prompt: string, messages: FlujoChatMessage[], tools: undefined, options: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: { code: string; message: string } }> }
).generateCompletion('memory-model', '', messages, undefined, {
  archiveModelTurns: true, canonicalMessages: canonical,
  conversationId: 'memory-conversation', nodeId: 'memory-node', runId: 'memory-run',
  ...options,
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
  let fixtureUncertain: boolean;
  let summarizeHistory: boolean;
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
    fixtureUncertain = false;
    summarizeHistory = false;
    writeOpenControl = undefined;
    archiveMetadata = undefined;
    sdkRequestObserved = undefined;
    responsesMode = undefined;
    transcriptRevisions = 0;
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.setHeader('Content-Type', 'application/json');
      if (responsesMode) {
        const failed = responsesMode === 'refuse' || responsesMode === 'unavailable' || requests.length === 1;
        const envelope = { id: 'response-' + requests.length, object: 'response',
          status: failed ? 'failed' : 'completed', model: 'offline-model',
          error: failed ? { code: responsesMode === 'refuse' ? 'invalid_prompt' : 'server_error', message: 'Provider did not complete the response' } : null,
          output: failed ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued', annotations: [] }] }],
        };
        if ((requests.at(-1) as { stream?: boolean }).stream) {
          response.setHeader('Content-Type', 'text/event-stream');
          if (responsesMode === 'partial') response.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'visible partial reply' }) + '\n\n');
          response.end('data: ' + JSON.stringify({ type: failed ? 'response.failed' : 'response.completed', response: envelope }) + '\n\ndata: [DONE]\n\n');
        } else response.end(JSON.stringify(envelope));
        return;
      }
      if (bad400) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: { message: 'Provider returned error (upstream: AtlasCloud: {"code":400,"msg":"bad request"})' } }));
      } else {
        let content = 'continued';
        const body = requests.at(-1) as { messages?: Array<{ role: string; content: string }> };
        if (summarizeHistory && body.messages?.[0]?.content?.startsWith('You are compacting')) {
          const summary = COMPACTION_SUMMARY_SECTIONS.map(section => section + '\n- Sending prohibited; destination Bogotá.').join('\n\n');
          content = body.messages[0].content.includes('protectedUserIds') ? JSON.stringify({ summary,
            protectedUserIds: body.messages.some(message => message.content?.includes('"id":"history-0"')) ? ['history-0'] : [],
          }) : summary;
        }
        if ((requests.at(-1) as { stream?: boolean }).stream) {
          response.setHeader('Content-Type', 'text/event-stream');
          response.end('data: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model',
            choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })
            + '\n\ndata: ' + JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', created: 1, model: 'offline-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } else response.end(JSON.stringify({ id: 'offline', object: 'chat.completion', created: 1, model: 'offline-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    getModelMock.mockReset().mockResolvedValue({ id: 'memory-model', name: 'offline-model', displayName: 'Offline',
      provider: 'openai', adapter: 'openai', ApiKey: 'offline-not-a-secret',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      inputModalities: ['text'], outputModalities: ['text'] });
  });

  it('refuses an impossible configured context budget before provider I/O', async () => {
    const configured = await getModelMock();
    getModelMock.mockResolvedValue({ ...configured, contextWindow: 100000, maxTokens: 100000 });
    const result = await invoke([message], [message], { maxTokens: 100000 });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('leaves no room for input');
    expect(requests).toHaveLength(0);
  });

  it('refuses real SDK HTTP dispatch when its immutable dispatch marker exhausts the conversation sequence', async () => {
    const logDirectory = path.join(root, 'sequence-logs');
    await fs.mkdir(logDirectory);
    const previous = _setConversationLogDirForTests(logDirectory);
    try {
      await fs.writeFile(path.join(logDirectory, 'memory-conversation.jsonl'), `{"seq":${Number.MAX_SAFE_INTEGER - 2}}\n`);
      // The callback runs immediately before the real ModelHandler observer.
      sdkRequestObserved = () => { allocateSeq('memory-conversation'); };
      const canonical = structuredClone([message]);
      const result = await invoke(canonical);
      expect(result).toMatchObject({ success: false, error: { code: 'CONVERSATION_SEQUENCE_EXHAUSTED' } });
      expect(requests).toHaveLength(0);
      expect(canonical).toEqual([message]);
      expect(listInFlightToolCalls('memory-conversation')).toHaveLength(0);
      const log = await fs.readFile(path.join(logDirectory, 'memory-conversation.jsonl'), 'utf8');
      expect(log).not.toContain('model:dispatch');
    } finally {
      await flushConversationLog('memory-conversation');
      sdkRequestObserved = undefined;
      _setConversationLogDirForTests(previous);
    }
  });

  it.each([false, true])('continues after an HTTP 200 failed response (stream=%s), archiving error then success', async stream => {
    responsesMode = 'recover';
    getModelMock.mockResolvedValue({ ...(await getModelMock()), adapter: 'openai-responses' });
    const onRecoveryRetry = jest.fn();
    expect((await invoke([message], [message], { onRecoveryRetry, ...(stream ? { onModelDelta: jest.fn() } : {}) })).success).toBe(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(onRecoveryRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2, failure: expect.objectContaining({ category: 'provider_failure', retryable: true }),
    }));
    const directory = path.join(root, 'archives', 'memory-conversation');
    const outcomes = await Promise.all((await fs.readdir(directory)).filter(name => name.endsWith('.outcome.json'))
      .map(async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')).outcome));
    expect(outcomes.sort()).toEqual(['completed', 'error']);
  });

  it.each(['capture', 'write'] as const)('refuses real SDK HTTP dispatch when required publication fails at %s', async failurePoint => {
    const conversationId = `publication-${failurePoint}`;
    const logDirectory = path.join(root, 'publication-logs');
    await fs.mkdir(logDirectory);
    const previous = _setConversationLogDirForTests(logDirectory);
    const canonical = structuredClone([message]);
    FlowExecutor.conversationStates.set(conversationId, { conversationId, messages: canonical } as SharedState);
    const before = getConversationPublicationDiagnostics();
    const delivered: string[] = [];
    const unsubscribe = executionEventBus.subscribe(conversationId, event => { delivered.push(event.type); });
    const refusals: jest.SpyInstance[] = [];
    const open = fs.open.bind(fs);
    const writer = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (failurePoint !== 'write' || !String(args[0]).endsWith(`${conversationId}.jsonl`)) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'write') return async () => { throw Object.assign(new Error('required log write failed'), { code: 'ENOSPC' }); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    sdkRequestObserved = () => {
      // A synchronous capture refusal (allocation pressure) on the next required publication.
      if (failurePoint === 'capture') for (const name of ['publishConversation', 'publishConversationBatch'] as const) {
        refusals.push(jest.spyOn(publicationModule, name).mockImplementation(() => {
          throw new ConversationPublicationError('CONVERSATION_PUBLICATION_MEMORY', 'publication allocation capacity is occupied');
        }));
      }
    };
    try {
      const result = await invoke(canonical, canonical, { conversationId });
      expect(result).toMatchObject({ success: false, error: {
        code: failurePoint === 'capture' ? 'CONVERSATION_PUBLICATION_MEMORY' : 'CONVERSATION_PUBLICATION_UNCERTAIN',
      } });
      expect(requests).toHaveLength(0);
      if (failurePoint === 'capture') {
        expect(delivered).not.toContain('model:dispatch');
        expect(executionEventBus.getBufferedSince(conversationId, 0)).toEqual([]);
      }
      expect(canonical).toEqual([message]);
      expect(listInFlightToolCalls(conversationId)).toHaveLength(0);
      if (failurePoint === 'write') {
        // The append's rejected promise has already left pendingCommits. Its
        // bounded fence must still make a later flush fail closed.
        await new Promise(resolve => setImmediate(resolve));
        await expect(flushConversationLog(conversationId)).rejects.toMatchObject({ code: 'CONVERSATION_PUBLICATION_UNCERTAIN' });
      }
    } finally {
      for (const refusal of refusals) refusal.mockRestore();
      await flushConversationLog(conversationId).catch(() => {});
      unsubscribe();
      writer.mockRestore(); sdkRequestObserved = undefined;
      FlowExecutor.conversationStates.delete(conversationId);
      _setConversationLogDirForTests(previous);
      expect(getConversationPublicationDiagnostics()).toMatchObject({ writers: 0, allocationBytes: 0, retainedBytes: 0, chains: 0 });
      if (failurePoint === 'capture') expect(getConversationPublicationDiagnostics()).toMatchObject({
        owners: before.owners, fences: before.fences, receipts: before.receipts, quarantinedWriterSlots: before.quarantinedWriterSlots,
      });
    }
  });

  it('retains the completed inference receipt and never redispatches after real SDK result publication fails', async () => {
    const conversationId = 'publication-result';
    const logDirectory = path.join(root, 'result-publication-logs');
    await fs.mkdir(logDirectory);
    const previous = _setConversationLogDirForTests(logDirectory);
    const canonical = structuredClone([message]);
    FlowExecutor.conversationStates.set(conversationId, { conversationId, messages: canonical } as SharedState);
    const open = fs.open.bind(fs);
    const writer = jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (!String(args[0]).endsWith(`${conversationId}.jsonl`)) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === 'write') return async (bytes: Buffer, offset: number, length: number, position: number) => {
          if (bytes.subarray(offset, offset + length).toString().includes('model:dispatch-result')) {
            throw Object.assign(new Error('result marker write failed'), { code: 'ENOSPC' });
          }
          return target.write(bytes, offset, length, position);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const onRecoveryRetry = jest.fn();
    try {
      expect(await invoke(canonical, canonical, { conversationId, onRecoveryRetry })).toMatchObject({
        success: false, error: { code: 'CONVERSATION_PUBLICATION_UNCERTAIN' },
      });
      expect(requests).toHaveLength(1);
      expect(onRecoveryRetry).not.toHaveBeenCalled();
      const archive = path.join(root, 'archives', conversationId);
      const outcomes = (await fs.readdir(archive)).filter(name => name.endsWith('.outcome.json'));
      expect(outcomes).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(archive, outcomes[0]), 'utf8')).outcome).toBe('completed');
      expect(canonical).toEqual([message]);
      expect(listInFlightToolCalls(conversationId)).toHaveLength(0);
    } finally {
      await flushConversationLog(conversationId).catch(() => {});
      writer.mockRestore(); FlowExecutor.conversationStates.delete(conversationId);
      _setConversationLogDirForTests(previous);
    }
  });

  it('does not replay a failed stream after visible output', async () => {
    responsesMode = 'partial';
    getModelMock.mockResolvedValue({ ...(await getModelMock()), adapter: 'openai-responses' });
    const onModelDelta = jest.fn(), onRecoveryRetry = jest.fn();
    expect((await invoke([message], [message], { onModelDelta, onRecoveryRetry })).success).toBe(false);
    expect(requests).toHaveLength(1);
    expect(onModelDelta).toHaveBeenCalled();
    expect(onRecoveryRetry).not.toHaveBeenCalled();
  });

  it('stops an interruption retry immediately when the user cancels its wait', async () => {
    responsesMode = 'recover';
    getModelMock.mockResolvedValue({ ...(await getModelMock()), adapter: 'openai-responses' });
    const result = await invoke([message], [message], {
      onRecoveryRetry: () => cancelAllToolCalls('memory-conversation'),
    });
    expect(result).toMatchObject({ success: false, error: { code: 'cancelled' } });
    expect(requests).toHaveLength(1);
  });

  it('bounds persistent provider interruptions to the initial attempt and three retries', async () => {
    responsesMode = 'unavailable';
    getModelMock.mockResolvedValue({ ...(await getModelMock()), adapter: 'openai-responses' });
    expect((await invoke([message])).success).toBe(false);
    expect(requests).toHaveLength(4);
  });

  it('does not retry a provider refusal disguised as HTTP 200', async () => {
    responsesMode = 'refuse';
    getModelMock.mockResolvedValue({ ...(await getModelMock()), adapter: 'openai-responses' });
    expect((await invoke([message])).success).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('archives a large canonical history and continues with a small wire without charging JSON buffers to its clone', async () => {
    const canonical = [{ ...message, content: 'x'.repeat(8 * 1024 * 1024) }];
    expect((await invoke([message], canonical)).success).toBe(true);
    expect(requests).toHaveLength(1);
    const names = await fs.readdir(path.join(root, 'archives', 'memory-conversation'));
    const id = names.find(name => name.endsWith('.v2.json.gz'))?.replace('.v2.json.gz', '');
    expect(id).toBeDefined();
    expect((await readModelTurnSnapshot('memory-conversation', id!))?.canonicalMessages).toEqual(canonical);
  });

  it('fits an actual 8K PNG for the SDK and preserves the full original', async () => {
    let seed = 1792700001;
    const noise = Buffer.alloc(512 * 512 * 3);
    for (let i = 0; i < noise.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; noise[i] = seed & 255;
    }
    const tile = await sharp(noise, { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
    const png = await sharp({ create: { width: 7680, height: 4320, channels: 3, background: 'white' } })
      .composite([{ input: tile, tile: true }]).png().toBuffer();
    expect(png.length).toBeGreaterThan(2_000_000);
    getModelMock.mockResolvedValue({ ...(await getModelMock()), contextWindow: 200_000, inputModalities: ['text', 'image'] });
    const url = 'data:image/png;base64,' + png.toString('base64');
    const imageMessage: FlujoChatMessage = { ...message, content: [
      { type: 'text', text: 'Describe this screenshot.' }, { type: 'image_url', image_url: { url } },
    ] };
    const result = await invoke([imageMessage]);
    expect(result).toMatchObject({ success: true });
    expect(requests).toHaveLength(1);
    const request = requests[0] as { messages: OpenAI.ChatCompletionMessageParam[] };
    const sent = request.messages.flatMap(m => Array.isArray(m.content) ? m.content as OpenAI.ChatCompletionContentPart[] : [])
      .find(part => part.type === 'image_url') as OpenAI.ChatCompletionContentPartImage;
    expect(sent.image_url.url).not.toBe(url);
    const size = await sharp(Buffer.from(sent.image_url.url.split(',')[1], 'base64')).metadata();
    expect(Math.max(size.width!, size.height!)).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(request)).toContain('Full-resolution original: flujo://run/');
    expect(imageMessage.content).toEqual([{ type: 'text', text: 'Describe this screenshot.' }, { type: 'image_url', image_url: { url } }]);
  }, 60_000);

  it('continues with 80000 canonical messages and a bounded provider projection', async () => {
    const canonical: FlujoChatMessage[] = Array.from({ length: 80_000 }, (_, index) => ({
      id: `history-${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: index,
      content: `Message ${index}: retained exact history, including Unicode \u00e9\u6f22\ud83d\ude42.`,
    }));
    const result = await invoke([message], canonical);
    expect(result).toMatchObject({ success: true });
    expect(requests).toHaveLength(1);
    const names = await fs.readdir(path.join(root, 'archives', 'memory-conversation'));
    const id = names.find(name => name.endsWith('.v2.json.gz'))!.replace('.v2.json.gz', '');
    // Exercise the bounded streaming API used by the actual archive route;
    // the separate all-at-once inspection API deliberately caps JSON heap.
    const stream = await readModelTurnSnapshotResponse('memory-conversation', id);
    const snapshot = await new Response(stream).json();
    expect(snapshot.canonicalMessages).toEqual(canonical);
    expect(snapshot.entry).toMatchObject({ canonicalMessageCount: 80_000, outcome: 'completed' });
    expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0 });
  }, 60_000);

  it('automatically compacts all 80000 mixed messages before SDK dispatch, including full debugger provenance', async () => {
    summarizeHistory = true;
    getModelMock.mockResolvedValue({ ...(await getModelMock()), contextWindow: 200_000, maxTokens: 4000 });
    const canonical: FlujoChatMessage[] = Array.from({ length: 80_000 }, (_, index) => ({
      id: 'history-' + index, role: index % 2 ? 'assistant' : 'user', timestamp: index,
      content: index === 0 ? 'Never send messages or publish anything.'
        : index % 2 ? 'Record checked; no outstanding action.' : 'Check historical record ' + index + '.',
    }));
    const result = await ModelHandler.callModel({
      modelId: 'memory-model', prompt: '', messages: canonical,
      iteration: 1, maxIterations: 1, nodeId: 'memory-node', nodeName: 'Memory', conversationId: 'memory-conversation',
      archiveModelTurns: true,
      modelInputForArchive: { systemMessage: null, wireMessages: canonical,
        provenance: canonical.map(message => ({ id: message.id, role: message.role, status: 'sent' })),
        counts: { threaded: 80_000, sent: 80_000, folded: 0, scopedOut: 0, handoffStripped: 0 } },
    });
    expect(result).toMatchObject({ success: true });
    expect(requests.length).toBeGreaterThan(5);
    for (const request of requests) expect(JSON.stringify(request).length / 4).toBeLessThan(196_000);
    expect(JSON.stringify(requests.at(-1))).toContain('Never send messages or publish anything.');
    const names = await fs.readdir(path.join(root, 'archives', 'memory-conversation'));
    const id = names.find(name => name.endsWith('.v2.json.gz'))!.replace('.v2.json.gz', '');
    const snapshot = await new Response(await readModelTurnSnapshotResponse('memory-conversation', id)).json();
    expect(snapshot.canonicalMessages).toEqual(canonical);
    expect(snapshot.provenance).toHaveLength(80_000);
    expect(snapshot.counts.threaded).toBe(80_000);
  }, 120_000);

  it('counts replacement transcript messages once instead of exhausting memory across stream revisions', async () => {
    transcriptRevisions = 100;
    expect((await invoke([message])).success).toBe(true);
    expect(requests).toHaveLength(1);
    const names = await fs.readdir(path.join(root, 'archives', 'memory-conversation'));
    const id = names.find(name => name.endsWith('.v2.json.gz'))!.replace('.v2.json.gz', '');
    const snapshot = await readModelTurnSnapshot('memory-conversation', id);
    expect(snapshot?.canonicalMessages.filter(message => message.id === 'same-streamed-message')).toHaveLength(1);
    expect(snapshot?.canonicalMessages.at(-1)?.timestamp).toBe(99);
  });

  it('directly cancels an admitted provider call and releases its registered controller', async () => {
    sdkRequestObserved = () => { expect(cancelAllToolCalls('memory-conversation')).toBe(1); };
    const result = await invoke([message]);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('cancelled');
    expect(requests).toHaveLength(0);
    expect(listInFlightToolCalls('memory-conversation')).toHaveLength(0);
  });

  afterEach(async () => {
    // Do not delete underneath a writer, even on a failed assertion.
    const pressure = getArchiveWritePressure();
    if (pressure.writers || pressure.quarantined || pressure.bytes || fixtureUncertain) {
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
      () => { archiveMetadata = undefined; },
      () => { sdkRequestObserved = undefined; },
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

  it('refuses a protected per-dispatch write before cloning or starting HTTP, then admits a successor after drainage', async () => {
    const gate = deferred();
    const entered = deferred();
    let count = 0;
    const writes = Array.from({ length: MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites }, () => withArchiveWriteMemory('held', async () => {
      if (++count === MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites) entered.resolve();
      await gate.promise;
    }));
    const prepare = jest.fn(() => ({ conversationId: 'no-write', nodeId: 'node', modelId: 'model', modelName: 'model',
      adapter: 'openai', operation: 'create', attempt: 1, canonicalMessages: [message], genericWire: [], sdkRequest: {} }));
    try {
      await entered.promise;
      await expect(archiveModelDispatch(prepare(), prepare)).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' });
      // One call only builds the input references; deferred clone factory did not run.
      expect(prepare).toHaveBeenCalledTimes(1);
      const result = await invoke([message], [message], {
        durableContext: { executionAuthority: { assertCurrent: async () => {} } },
      });
      expect(result).toMatchObject({ success: false, error: { code: 'MODEL_TURN_ARCHIVE_MEMORY_BUSY' } });
      expect(requests).toHaveLength(0);
    } finally { gate.resolve(); await Promise.allSettled(writes); }
    expect((await invoke([message])).success).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('queues an ordinary dispatch before HTTP and archives it after the held writers drain', async () => {
    const gate = deferred();
    const entered = deferred();
    const sdkEntered = deferred();
    let count = 0;
    const writes = Array.from({ length: MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites }, () => withArchiveWriteMemory('held', async () => {
      if (++count === MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites) entered.resolve();
      await gate.promise;
    }));
    let running: ReturnType<typeof invoke> | undefined;
    let settled = false;
    try {
      await entered.promise;
      sdkRequestObserved = sdkEntered.resolve;
      running = invoke([message]).then(result => { settled = true; return result; });
      await sdkEntered.promise;
      expect(getArchiveWritePressure().writers).toBe(MODEL_TURN_ARCHIVE_WRITE_LIMITS.concurrentWrites);
      expect((globalThis as typeof globalThis & { __flujoArchiveWriteQueue?: unknown[] }).__flujoArchiveWriteQueue).toHaveLength(1);
      expect(settled).toBe(false);
      expect(requests).toHaveLength(0);
      gate.resolve();
      await Promise.all(writes);
      expect((await running).success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(getArchiveWritePressure()).toMatchObject({ bytes: 0, writers: 0, quarantined: 0 });
      const files = (await fs.readdir(path.join(root, 'archives', 'memory-conversation'))).filter(file => file.endsWith('.v2.json.gz'));
      expect(files).toHaveLength(1);
      const snapshot = await readModelTurnSnapshot('memory-conversation', files[0].slice(0, -'.v2.json.gz'.length));
      expect(snapshot!.canonicalMessages).toEqual([message]);
      expect(snapshot!.entry.outcome).toBe('completed');
    } finally {
      gate.resolve();
      await Promise.allSettled(writes);
      await running;
      sdkRequestObserved = undefined;
    }
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

  it('projects actual Zod schema and omits AbortSignal/environment metadata before actual SDK dispatch', async () => {
    const schema = z.object({ text: z.string() });
    const privateEnvironment = new Proxy({}, { ownKeys: () => { throw new Error('Environment was traversed'); } });
    class PrivateGraph { get hidden() { throw new Error('Private getter was invoked'); } }
    archiveMetadata = { schema, signal: new AbortController().signal, env: privateEnvironment, privateGraph: new PrivateGraph() };
    expect((await invoke([message])).success).toBe(true);
    expect(requests).toHaveLength(1);
    const files = (await fs.readdir(path.join(root, 'archives', 'memory-conversation'))).filter(file => file.endsWith('.v2.json.gz'));
    expect(files).toHaveLength(1);
    const snapshot = await readModelTurnSnapshot('memory-conversation', files[0].slice(0, -'.v2.json.gz'.length));
    expect(snapshot!.sdkRequest).toMatchObject({ schema: { type: 'object', properties: { text: { type: 'string' } } },
      signal: '[AbortSignal]', env: '[environment omitted]', privateGraph: '[object omitted]' });
    expect(snapshot!.canonicalMessages).toEqual([message]);
  });

  it('preserves a physical outcome temp on unscoped close uncertainty and does not replace the committed outcome', async () => {
    expect((await invoke([message])).success).toBe(true);
    const directory = path.join(root, 'archives', 'memory-conversation');
    const files = (await fs.readdir(directory)).filter(file => file.endsWith('.v2.json.gz'));
    expect(files).toHaveLength(1);
    const id = files[0].slice(0, -'.v2.json.gz'.length);
    let uncertainTemp: string | undefined;
    let physicallyClosed = false;
    const closeCalls = jest.fn();
    writeOpenControl = (handle, file) => {
      if (!file.includes('.outcome.json.') || !file.endsWith('.tmp')) return handle;
      uncertainTemp = file;
      fixtureUncertain = true;
      return new Proxy(handle, { get(target, key) {
        if (key === 'close') return async () => {
          closeCalls();
          await target.close();
          physicallyClosed = true;
          fixtureUncertain = false;
          // Controlled ambiguous result AFTER actual OS close: the production
          // writer cannot know this, but fixture cleanup can prove drainage.
          throw new Error('Injected ambiguous close result');
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    try {
      await expect(updateModelDispatchOutcome('memory-conversation', id, 'error'))
        .rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_WRITE_CLEANUP' });
      expect(physicallyClosed).toBe(true);
      expect(closeCalls).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await fs.readFile(uncertainTemp!, 'utf8'))).toMatchObject({ outcome: 'error' });
      expect((await readModelTurnSnapshot('memory-conversation', id))!.entry.outcome).toBe('completed');
    } finally {
      writeOpenControl = undefined;
      // Cleanup may remove this owned fixture only with independently observed
      // successful OS drainage, never from the production error alone.
      if (uncertainTemp && !physicallyClosed) throw new Error(`Unresolved descriptor; preserve ${root}`);
    }
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
