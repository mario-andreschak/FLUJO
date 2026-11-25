/**
 * Issue #1367: models on self-hosted OpenAI-compatible servers (vLLM serving
 * Qwen, llama.cpp, Ollama, LM Studio, Groq). The response shapes below are the
 * ones these servers send; a loopback server replays them through FLUJO's real
 * adapter, so the request FLUJO builds and the reply it reads are both checked.
 *
 * Also: a reply cut off by the length limit in the middle of a tool call never
 * runs that call (the rule #1227 set for Gemini, now for every adapter).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Model } from '@/shared/types/model';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { withoutCutOffToolCalls } from '@/backend/services/model/adapters/cutOffReply';
import { readOpenAiCompatibleUsage } from '@/backend/services/model/adapters/openaiUsage';
import type { CompletionResult } from '@/backend/services/model/adapters/types';

jest.setTimeout(30_000);

type WireBody = { stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: unknown[] };
type Reply = (body: WireBody, response: ServerResponse) => void;

const VLLM_ID = 'chatcmpl-9f1c2b7d4e';
const QWEN = 'Qwen/Qwen3-32B';

/** One vLLM 0.11 stream chunk; vLLM sends `usage: null` on every chunk once usage is requested. */
const vllmChunk = (choice: Record<string, unknown> | null, extra: Record<string, unknown> = {}, body?: WireBody) => ({
  id: VLLM_ID, object: 'chat.completion.chunk', created: 1764060000, model: QWEN,
  choices: choice ? [{ index: 0, logprobs: null, finish_reason: null, ...choice }] : [],
  ...(body?.stream_options?.include_usage ? { usage: null } : {}),
  ...extra,
});

function sse(response: ServerResponse, chunks: unknown[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** vLLM: usage only in a final empty-choices chunk, and only when asked for. */
const vllmStream: Reply = (body, response) => sse(response, [
  vllmChunk({ delta: { role: 'assistant', content: '' } }, {}, body),
  vllmChunk({ delta: { content: 'Hello' } }, {}, body),
  vllmChunk({ delta: { content: '!' }, finish_reason: 'stop', stop_reason: null }, {}, body),
  ...(body.stream_options?.include_usage
    ? [vllmChunk(null, { usage: { prompt_tokens: 25, total_tokens: 27, completion_tokens: 2, prompt_tokens_details: null } })]
    : []),
]);

const vllmCompletion: Reply = (_body, response) => json(response, 200, {
  id: VLLM_ID, object: 'chat.completion', created: 1764060000, model: QWEN,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!', refusal: null, tool_calls: [], reasoning_content: null },
    logprobs: null, finish_reason: 'stop', stop_reason: null }],
  usage: { prompt_tokens: 25, total_tokens: 27, completion_tokens: 2, prompt_tokens_details: null },
  prompt_logprobs: null, kv_transfer_params: null,
});

/** Older llama.cpp server: no usage block, only its own `timings`. */
const llamaCppStream: Reply = (_body, response) => sse(response, [
  { id: 'chatcmpl-llama', object: 'chat.completion.chunk', created: 1, model: 'qwen3-8b-q4_k_m.gguf',
    choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
  { id: 'chatcmpl-llama', object: 'chat.completion.chunk', created: 1, model: 'qwen3-8b-q4_k_m.gguf',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    timings: { prompt_n: 12, prompt_ms: 40.1, predicted_n: 3, predicted_ms: 30.5, cache_n: 30 } },
]);

/** Groq: usage under `x_groq` in the last chunk. */
const groqStream: Reply = (_body, response) => sse(response, [
  { id: 'chatcmpl-groq', object: 'chat.completion.chunk', created: 1, model: 'qwen/qwen3-32b',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }], x_groq: { id: 'req_1' } },
  { id: 'chatcmpl-groq', object: 'chat.completion.chunk', created: 1, model: 'qwen/qwen3-32b',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    x_groq: { id: 'req_1', usage: { prompt_tokens: 18, completion_tokens: 1, total_tokens: 19 } } },
]);

/** A server that counts nothing: no usage at all, or a block of zeros. */
const silentStream: Reply = (_body, response) => sse(response, [
  { id: 'chatcmpl-silent', object: 'chat.completion.chunk', created: 1, model: QWEN,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }] },
]);
const zeroUsageCompletion: Reply = (_body, response) => json(response, 200, {
  id: 'chatcmpl-zero', object: 'chat.completion', created: 1, model: QWEN,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

/** An older gateway that refuses the field (Azure's wording before api-version 2024-09). */
const refusesStreamOptions: Reply = (body, response) => body.stream_options
  ? json(response, 400, { error: { message: 'Unrecognized request argument supplied: stream_options',
      type: 'invalid_request_error', param: null, code: null } })
  : vllmStream(body, response);

/** vLLM (hermes tool parser) streaming a call that the length limit cuts off mid-arguments. */
const cutOffToolCallStream: Reply = (body, response) => sse(response, [
  vllmChunk({ delta: { role: 'assistant', content: 'I will clean up the folder.' } }, {}, body),
  vllmChunk({ delta: { tool_calls: [{ id: 'chatcmpl-tool-5c1e', type: 'function', index: 0,
    function: { name: 'bash__run' } }] } }, {}, body),
  vllmChunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"command": "rm -rf /tmp/rep' } }] } }, {}, body),
  vllmChunk({ delta: { content: '' }, finish_reason: 'length', stop_reason: null }, {}, body),
  ...(body.stream_options?.include_usage
    ? [vllmChunk(null, { usage: { prompt_tokens: 900, total_tokens: 1012, completion_tokens: 112 } })]
    : []),
]);

const cutOffToolCallCompletion: Reply = (_body, response) => json(response, 200, {
  id: VLLM_ID, object: 'chat.completion', created: 1, model: QWEN,
  choices: [{ index: 0, finish_reason: 'length', logprobs: null, message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'chatcmpl-tool-7a2f', type: 'function', function: { name: 'bash__run', arguments: '' } }] } }],
  usage: { prompt_tokens: 900, total_tokens: 1012, completion_tokens: 112 },
});

const finishedToolCallStream: Reply = (body, response) => sse(response, [
  vllmChunk({ delta: { tool_calls: [{ id: 'chatcmpl-tool-8d3b', type: 'function', index: 0,
    function: { name: 'bash__run', arguments: '{"command": "ls"}' } }] } }, {}, body),
  vllmChunk({ delta: {}, finish_reason: 'tool_calls' }, {}, body),
]);

let server: Server;
let baseUrl = '';
const requests: Array<{ path: string; body: WireBody }> = [];
let reply: Reply = vllmStream;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
      requests.push({ path: request.url ?? '', body });
      reply(body, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  reply = vllmStream;
});

let endpoint = 0;
/** Each test gets its own address, so what one server refused never leaks into another test. */
const selfHosted = (provider: Model['provider'] = 'openai'): Model => ({
  id: `self-hosted-${++endpoint}`, name: QWEN, provider, adapter: 'openai', ApiKey: '',
  baseUrl: `${baseUrl}/server-${endpoint}`, contextWindow: 32_768,
});

const input = (model: Model) => ({
  model, apiKey: 'not-needed', temperature: 0,
  messages: [{ role: 'system' as const, content: 'You are a worker.' }, { role: 'user' as const, content: 'Say hello' }],
});

const stream = (model: Model, extra: Record<string, unknown> = {}) => {
  const adapter = getCompletionAdapter(model);
  return adapter.createStreamCompletion!({ ...input(model), onModelDelta: () => undefined, ...extra });
};

describe('token counts from self-hosted servers', () => {
  it.each(['openai', 'ollama', 'litellm'] as const)('asks a %s server for token counts while streaming', async provider => {
    await stream(selfHosted(provider));
    expect(requests[0].body.stream_options).toEqual({ include_usage: true });
  });

  it('reads vLLM\'s final usage chunk', async () => {
    const result = await stream(selfHosted());
    expect(result.completion.choices[0].message.content).toBe('Hello!');
    expect(result.completion.usage).toEqual(expect.objectContaining({ prompt_tokens: 25, completion_tokens: 2, total_tokens: 27 }));
    expect(result.contextUsage).toEqual(expect.objectContaining({ promptTokens: 25, completionTokens: 2 }));
  });

  it('reads usage from a vLLM reply without streaming', async () => {
    reply = vllmCompletion;
    const model = selfHosted();
    const result = await getCompletionAdapter(model).createCompletion(input(model));
    expect(result.completion.usage).toEqual(expect.objectContaining({ prompt_tokens: 25, completion_tokens: 2, total_tokens: 27 }));
  });

  it('reads llama.cpp timings when it sends no usage block', async () => {
    reply = llamaCppStream;
    const result = await stream(selfHosted());
    expect(result.completion.usage).toEqual(expect.objectContaining({
      prompt_tokens: 42, completion_tokens: 3, total_tokens: 45, prompt_tokens_details: { cached_tokens: 30 },
    }));
  });

  it('reads Groq\'s usage from x_groq', async () => {
    reply = groqStream;
    const result = await stream(selfHosted());
    expect(result.completion.usage).toEqual(expect.objectContaining({ prompt_tokens: 18, completion_tokens: 1, total_tokens: 19 }));
  });

  it('reports no usage, never 0, when a server counts nothing', async () => {
    reply = silentStream;
    const silent = await stream(selfHosted());
    expect(silent.completion.usage).toBeUndefined();
    expect(silent.contextUsage).toBeNull();

    reply = zeroUsageCompletion;
    const model = selfHosted();
    const zeros = await getCompletionAdapter(model).createCompletion(input(model));
    expect(zeros.completion.usage).toBeUndefined();
  });

  it('streams without stream_options once a server refuses it, and keeps the answer', async () => {
    reply = refusesStreamOptions;
    const model = selfHosted();
    const first = await stream(model);
    expect(first.completion.choices[0].message.content).toBe('Hello!');
    expect(requests.map(request => Boolean(request.body.stream_options))).toEqual([true, false]);

    await stream(model);
    expect(requests.map(request => Boolean(request.body.stream_options))).toEqual([true, false, false]);
  });
});

describe('readOpenAiCompatibleUsage', () => {
  it('reads every spelling servers use', () => {
    expect(readOpenAiCompatibleUsage({ usage: { prompt_tokens: 5, completion_tokens: 2 } }))
      .toEqual(expect.objectContaining({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }));
    expect(readOpenAiCompatibleUsage({ usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }))
      .toEqual(expect.objectContaining({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }));
    expect(readOpenAiCompatibleUsage({ usage: { prompt_eval_count: 5, eval_count: 2 } }))
      .toEqual(expect.objectContaining({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }));
    expect(readOpenAiCompatibleUsage({ choices: [{ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }] }))
      .toEqual(expect.objectContaining({ total_tokens: 7 }));
  });

  it('keeps the server\'s other usage fields, such as a cost', () => {
    expect(readOpenAiCompatibleUsage({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.001 } }))
      .toEqual(expect.objectContaining({ cost: 0.001 }));
  });

  it('treats a missing, null or all-zero block as not reported', () => {
    expect(readOpenAiCompatibleUsage({ usage: null })).toBeUndefined();
    expect(readOpenAiCompatibleUsage({})).toBeUndefined();
    expect(readOpenAiCompatibleUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })).toBeUndefined();
    expect(readOpenAiCompatibleUsage(undefined)).toBeUndefined();
  });
});

describe('a reply cut off in the middle of a tool call (finish_reason "length")', () => {
  it('never hands a streamed, half-written call to the flow', async () => {
    reply = cutOffToolCallStream;
    const result = await stream(selfHosted());
    const choice = result.completion.choices[0];
    expect(choice.finish_reason).toBe('length');
    expect(choice.message.tool_calls).toBeUndefined();
    expect(choice.message.content).toBe('I will clean up the folder.');
    expect(result.completion.usage).toEqual(expect.objectContaining({ completion_tokens: 112 }));
  });

  it('never hands a call with empty arguments to the flow without streaming', async () => {
    reply = cutOffToolCallCompletion;
    const model = selfHosted();
    const result = await getCompletionAdapter(model).createCompletion(input(model));
    expect(result.completion.choices[0].finish_reason).toBe('length');
    expect(result.completion.choices[0].message.tool_calls).toBeUndefined();
  });

  it('keeps a tool call that finished normally', async () => {
    reply = finishedToolCallStream;
    const result = await stream(selfHosted());
    expect(result.completion.choices[0].message.tool_calls).toEqual([
      expect.objectContaining({ id: 'chatcmpl-tool-8d3b', function: { name: 'bash__run', arguments: '{"command": "ls"}' } }),
    ]);
  });

  it('applies to every adapter\'s result the same way', () => {
    const result: CompletionResult = { completion: {
      id: 'r', object: 'chat.completion', created: 1, model: 'any',
      choices: [{ index: 0, finish_reason: 'length', logprobs: null, message: { role: 'assistant', content: 'Part', refusal: null,
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path": "/x' } }] } }],
    } };
    expect(withoutCutOffToolCalls(result).completion.choices[0].message).toEqual({ role: 'assistant', content: 'Part', refusal: null });
    const finished = { ...result, completion: { ...result.completion,
      choices: [{ ...result.completion.choices[0], finish_reason: 'tool_calls' as const }] } };
    expect(withoutCutOffToolCalls(finished)).toBe(finished);
  });
});
