/**
 * Tests for `prompt_cache_key` handling in the OpenAI-compatible adapter.
 *
 * The parameter is a cache-ROUTING hint: without it OpenAI derives the shard from
 * the prompt prefix alone, so concurrent requests sharing a prefix can scatter
 * across cold machines and miss a cache that is actually warm. It is sent only to
 * providers on an allowlist, and permanently dropped for any endpoint that turns
 * out to reject it — this codebase has been bitten before by strict
 * OpenAI-compatible gateways 400-ing on parameters they don't recognise.
 *
 * Pins:
 *  - sent for allowlisted providers (openai, openrouter)
 *  - NOT sent for providers off the allowlist (e.g. requesty, ollama)
 *  - omitted entirely when the caller supplied no key
 *  - a 400 naming the parameter → retried once WITHOUT it, and disabled for that
 *    endpoint thereafter
 *  - an unrelated 400 propagates unchanged (no masking retry)
 */

const mockCreate = jest.fn();

jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: () => ({ chat: { completions: { create: (...a: unknown[]) => mockCreate(...a) } } }),
  getProviderDefaultHeaders: () => undefined,
}));

// Pass-through: the transient-retry wrapper is not what these tests exercise.
jest.mock('@/backend/utils/transientRetry', () => ({
  withTransientRetry: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import type { Model } from '@/shared/types/model';

const OK = { id: 'c1', choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: {} };

const model = (provider: string, baseUrl = `https://${provider}.example/v1`): Model =>
  ({ id: 'm1', name: 'gpt-test', provider, baseUrl, ApiKey: 'k' } as unknown as Model);

const call = (m: Model, promptCacheKey?: string) =>
  new OpenAiAdapter().createCompletion({
    model: m,
    apiKey: 'sk-test',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0,
    promptCacheKey,
  });

/** The request body the adapter handed to the SDK on call `n` (0-indexed). */
const bodyOf = (n = 0) => mockCreate.mock.calls[n][0] as Record<string, unknown>;

/** An error shaped like a strict gateway rejecting an unknown parameter. */
const unknownParamError = () =>
  Object.assign(new Error('Unrecognized request argument supplied: prompt_cache_key'), {
    status: 400,
    error: { message: 'Unrecognized request argument supplied: prompt_cache_key' },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(OK);
});

describe('prompt_cache_key send policy', () => {
  it('sends the key for openai', async () => {
    await call(model('openai'), 'flujo-tabc123');
    expect(bodyOf().prompt_cache_key).toBe('flujo-tabc123');
  });

  it('sends the key for openrouter', async () => {
    await call(model('openrouter'), 'flujo-tabc123');
    expect(bodyOf().prompt_cache_key).toBe('flujo-tabc123');
  });

  it('does not send the key for providers off the allowlist', async () => {
    await call(model('requesty'), 'flujo-tabc123');
    expect(bodyOf()).not.toHaveProperty('prompt_cache_key');

    mockCreate.mockClear();
    await call(model('ollama', 'http://localhost:11434/v1'), 'flujo-tabc123');
    expect(bodyOf()).not.toHaveProperty('prompt_cache_key');
  });

  it('omits the key when the caller supplied none', async () => {
    await call(model('openai'), undefined);
    expect(bodyOf()).not.toHaveProperty('prompt_cache_key');
  });
});

describe('prompt_cache_key rejection handling', () => {
  it('retries once without the key, then stops sending it for that endpoint', async () => {
    const m = model('openrouter', 'https://strict-gateway.example/v1');

    mockCreate.mockRejectedValueOnce(unknownParamError()).mockResolvedValue(OK);

    // First call: rejected with the key, retried without it, and still succeeds.
    const result = await call(m, 'flujo-tabc123');
    expect(result.completion).toBe(OK);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(bodyOf(0).prompt_cache_key).toBe('flujo-tabc123');
    expect(bodyOf(1)).not.toHaveProperty('prompt_cache_key');

    // Second call: the endpoint is now known-bad, so the key is never attached
    // again — one retry per process, not one per request.
    mockCreate.mockClear();
    await call(m, 'flujo-tabc123');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).not.toHaveProperty('prompt_cache_key');
  });

  it('scopes the disable to the endpoint that rejected it', async () => {
    const bad = model('openrouter', 'https://another-strict.example/v1');
    mockCreate.mockRejectedValueOnce(unknownParamError()).mockResolvedValue(OK);
    await call(bad, 'flujo-tabc123');

    // A different endpoint is unaffected.
    mockCreate.mockClear();
    await call(model('openai', 'https://api.openai.com/v1'), 'flujo-tabc123');
    expect(bodyOf(0).prompt_cache_key).toBe('flujo-tabc123');
  });

  it('propagates an unrelated 400 without retrying', async () => {
    const err = Object.assign(new Error('context_length_exceeded'), {
      status: 400,
      error: { message: 'context_length_exceeded' },
    });
    mockCreate.mockRejectedValue(err);

    await expect(call(model('openai'), 'flujo-tabc123')).rejects.toThrow('context_length_exceeded');
    // No masking retry — exactly one attempt.
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 400 that merely mentions the parameter without rejecting it', async () => {
    const err = Object.assign(new Error('invalid value for prompt_cache_key: too long'), {
      status: 400,
      error: { message: 'invalid value for prompt_cache_key: too long' },
    });
    mockCreate.mockRejectedValue(err);

    await expect(call(model('openai'), 'flujo-tabc123')).rejects.toThrow('too long');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('native chat-completions streaming', () => {
  it('emits text and tool-argument deltas and assembles the final completion', async () => {
    async function* chunks() {
      yield {
        id: 'chatcmpl-stream',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }],
      };
      yield {
        id: 'chatcmpl-stream',
        created: 1,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: {
            content: 'lo',
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"' },
            }],
          },
          finish_reason: null,
        }],
      };
      yield {
        id: 'chatcmpl-stream',
        created: 1,
        model: 'gpt-test',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: 'Paris"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
    }
    mockCreate.mockResolvedValueOnce(chunks());
    const deltas: unknown[] = [];
    const result = await new OpenAiAdapter().createStreamCompletion({
      model: model('openai'),
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      onModelDelta: delta => deltas.push(delta),
    });

    expect(bodyOf()).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(result.completion.choices[0].message.content).toBe('Hello');
    expect(result.completion.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'weather', arguments: '{"city":"Paris"}' },
    });
    expect(result.completion.usage?.total_tokens).toBe(5);
    expect(new Set(deltas.map(delta => (delta as { messageId: string }).messageId))).toEqual(
      new Set([result.liveMessageId]),
    );
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentDelta: 'Hel' }),
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({ argumentsDelta: '{"city":"' }),
      }),
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({ argumentsDelta: 'Paris"}' }),
      }),
    ]));
  });
});
