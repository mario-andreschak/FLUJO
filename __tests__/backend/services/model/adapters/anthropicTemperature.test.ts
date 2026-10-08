import { AnthropicAdapter, anthropicModelSupportsTemperature, clearModelCapabilityCache }
  from '@/backend/services/model/adapters/anthropicAdapter';
import { Model } from '@/shared/types/model';
import OpenAI from 'openai';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
const mockLog = (jest.requireMock('@/utils/logger') as any).createLogger();

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const retrieve = jest.fn();
  const stream = jest.fn();
  const BadRequestError = class extends Error {
    status = 400;
    constructor(msg: string) { super(msg); }
  };
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create, stream },
    models: { retrieve },
  }));
  (Anthropic as any).BadRequestError = BadRequestError;
  return { __esModule: true, default: Anthropic, __create: create, __retrieve: retrieve, __stream: stream };
});

const anthropicCreate = (jest.requireMock('@anthropic-ai/sdk') as any).__create;
const anthropicRetrieve = (jest.requireMock('@anthropic-ai/sdk') as any).__retrieve;
const anthropicStream = (jest.requireMock('@anthropic-ai/sdk') as any).__stream;

const GOOD_RESP = {
  id: 'a', model: 'test', content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
};
const BASE_MODEL: Model = { id: 'm', name: 'claude-3-5-sonnet-20241022', ApiKey: 'k' } as Model;
const NO_TEMP_MODEL: Model = { ...BASE_MODEL, name: 'claude-opus-4-7-20260501' };
const MSGS: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

/** Create a minimal MockStream for the streaming tests. */
function makeMockStream(resolveWith: typeof GOOD_RESP) {
  return { finalMessage: jest.fn().mockResolvedValue(resolveWith) };
}

describe('anthropicModelSupportsTemperature', () => {
  beforeEach(() => { jest.clearAllMocks(); clearModelCapabilityCache(); });

  test('returns false for known no-temperature models', async () => {
    expect(await anthropicModelSupportsTemperature('claude-opus-4-7', undefined)).toBe(false);
    expect(await anthropicModelSupportsTemperature('claude-opus-4-7-20260401', undefined)).toBe(false);
    expect(await anthropicModelSupportsTemperature('claude-opus-4-8', undefined)).toBe(false);
    expect(await anthropicModelSupportsTemperature('claude-fable-5', undefined)).toBe(false);
    expect(await anthropicModelSupportsTemperature('claude-sonnet-5', undefined)).toBe(false);
  });
  test('returns true for standard models', async () => {
    expect(await anthropicModelSupportsTemperature('claude-3-5-sonnet-20241022', undefined)).toBe(true);
    expect(await anthropicModelSupportsTemperature('claude-opus-4-6', undefined)).toBe(true);
  });
});

describe('AnthropicAdapter temperature behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearModelCapabilityCache();
    anthropicCreate.mockResolvedValue(GOOD_RESP);
    // Return empty object so retrieve falls through to static denylist
    anthropicRetrieve.mockResolvedValue({});
  });

  test('includes temperature for standard models', async () => {
    await new AnthropicAdapter().createCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicCreate.mock.calls[0][0]).toHaveProperty('temperature', 0.7);
  });

  test('omits temperature for known no-temp models', async () => {
    await new AnthropicAdapter().createCompletion({
      model: NO_TEMP_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  test('retries without temperature when Anthropic returns 400 "deprecated" error', async () => {
    const Anthropic = jest.requireMock('@anthropic-ai/sdk').default;
    const err = new Anthropic.BadRequestError('`temperature` is deprecated for this model.');
    anthropicCreate.mockRejectedValueOnce(err).mockResolvedValueOnce(GOOD_RESP);

    // Use a standard model (not on denylist) so temperature IS included on first call.
    const result = await new AnthropicAdapter().createCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });

    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    // First call included temperature
    expect(anthropicCreate.mock.calls[0][0]).toHaveProperty('temperature');
    // Second call omitted it
    expect(anthropicCreate.mock.calls[1][0]).not.toHaveProperty('temperature');
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(result.completion).toBeDefined();
  });
});

describe('dynamic capability detection', () => {
  const ADAPTIVE_CAPS = {
    capabilities: { thinking: { types: { adaptive: { supported: true } } } },
  };
  const NON_ADAPTIVE_CAPS = {
    capabilities: { thinking: { types: { adaptive: { supported: false } } } },
  };

  beforeEach(() => { jest.clearAllMocks(); clearModelCapabilityCache(); });

  test('returns false when API reports adaptive.supported = true', async () => {
    anthropicRetrieve.mockResolvedValueOnce(ADAPTIVE_CAPS);
    const result = await anthropicModelSupportsTemperature(
      'claude-new-unknown-adaptive', new (jest.requireMock('@anthropic-ai/sdk').default)()
    );
    expect(result).toBe(false);
    expect(anthropicRetrieve).toHaveBeenCalledWith('claude-new-unknown-adaptive');
  });

  test('returns true when API reports adaptive.supported = false', async () => {
    anthropicRetrieve.mockResolvedValueOnce(NON_ADAPTIVE_CAPS);
    const result = await anthropicModelSupportsTemperature(
      'claude-3-future-model', new (jest.requireMock('@anthropic-ai/sdk').default)()
    );
    expect(result).toBe(true);
  });

  test('falls back to static denylist when API returns no capabilities', async () => {
    anthropicRetrieve.mockResolvedValueOnce({});
    // 'claude-opus-4-7' is on the static denylist → false
    const r1 = await anthropicModelSupportsTemperature(
      'claude-opus-4-7', new (jest.requireMock('@anthropic-ai/sdk').default)()
    );
    expect(r1).toBe(false);
  });

  test('falls back to static denylist when API throws', async () => {
    anthropicRetrieve.mockRejectedValueOnce(new Error('network error'));
    // standard model not on denylist → true
    const r2 = await anthropicModelSupportsTemperature(
      'claude-3-5-sonnet-20241022', new (jest.requireMock('@anthropic-ai/sdk').default)()
    );
    expect(r2).toBe(true);
  });

  test('caches API result — second call does not re-call retrieve', async () => {
    anthropicRetrieve.mockResolvedValue(ADAPTIVE_CAPS);
    const c = new (jest.requireMock('@anthropic-ai/sdk').default)();
    await anthropicModelSupportsTemperature('claude-cached-model', c);
    await anthropicModelSupportsTemperature('claude-cached-model', c);
    expect(anthropicRetrieve).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicAdapter streaming temperature behaviour', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    anthropicStream.mockReturnValue(makeMockStream(GOOD_RESP));
    if (typeof clearModelCapabilityCache === 'function') clearModelCapabilityCache();
    anthropicRetrieve.mockResolvedValue({});
  });

  test('includes temperature for standard models', async () => {
    await new AnthropicAdapter().createStreamCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicStream.mock.calls[0][0]).toHaveProperty('temperature', 0.7);
  });

  test('omits temperature for known no-temp models', async () => {
    await new AnthropicAdapter().createStreamCompletion({
      model: NO_TEMP_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicStream.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  test('retries without temperature when streaming yields 400 "deprecated" error', async () => {
    const Anthropic = jest.requireMock('@anthropic-ai/sdk').default;
    const err = new Anthropic.BadRequestError('`temperature` is deprecated for this model.');

    // First stream: finalMessage() rejects with BadRequestError
    const failingStream = { finalMessage: jest.fn().mockRejectedValueOnce(err) };
    const successStream = makeMockStream(GOOD_RESP);
    anthropicStream
      .mockReturnValueOnce(failingStream)
      .mockReturnValue(successStream);

    const result = await new AnthropicAdapter().createStreamCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });

    expect(anthropicStream).toHaveBeenCalledTimes(2);
    // First call: temperature included
    expect(anthropicStream.mock.calls[0][0]).toHaveProperty('temperature');
    // Retry call: temperature omitted
    expect(anthropicStream.mock.calls[1][0]).not.toHaveProperty('temperature');
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(result.completion).toBeDefined();
  });

  test('forwards native text and input-json deltas with one stable message id', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tool_1', name: 'lookup', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'working' },
      },
    ];
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
      finalMessage: jest.fn().mockResolvedValue(GOOD_RESP),
    };
    anthropicStream.mockReturnValueOnce(stream);
    const deltas: unknown[] = [];
    const result = await new AnthropicAdapter().createStreamCompletion({
      model: BASE_MODEL,
      apiKey: 'k',
      messages: MSGS,
      temperature: 0.7,
      onModelDelta: delta => deltas.push(delta),
    });

    expect(deltas).toEqual([
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({ id: 'tool_1', nameDelta: 'lookup' }),
      }),
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({ argumentsDelta: '{"q":"x"}' }),
      }),
      expect.objectContaining({ contentDelta: 'working' }),
    ]);
    expect(new Set(deltas.map(delta => (delta as { messageId: string }).messageId))).toEqual(
      new Set([result.liveMessageId]),
    );
  });
});
