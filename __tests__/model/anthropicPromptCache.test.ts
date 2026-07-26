/**
 * Prompt caching on the native Anthropic path.
 *
 * The Anthropic Messages API caches NOTHING without explicit `cache_control`
 * breakpoints (unlike the OpenAI-compatible path's automatic prefix cache), so
 * before this the adapter re-read the whole prefix at full price on every turn of
 * every agentic loop. These tests pin the three things that can regress:
 *   - where the breakpoints land, and that placement is pure,
 *   - that an endpoint which rejects `cache_control` degrades instead of failing,
 *   - that the reported usage exposes the cache buckets, so the saving is visible
 *     to the context meter and the prompt-cache metrics rather than invisible.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  AnthropicAdapter,
  applyCacheBreakpoints,
  isCacheControlRejection,
  clearModelCapabilityCache,
  __resetCacheControlSupport,
} from '@/backend/services/model/adapters/anthropicAdapter';
import { Model } from '@/shared/types/model';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const retrieve = jest.fn();
  const stream = jest.fn();
  const BadRequestError = class extends Error {
    status = 400;
    constructor(msg: string) { super(msg); }
  };
  const AnthropicMock = jest.fn().mockImplementation(() => ({
    messages: { create, stream },
    models: { retrieve },
  }));
  (AnthropicMock as any).BadRequestError = BadRequestError;
  return { __esModule: true, default: AnthropicMock, __create: create, __retrieve: retrieve, __stream: stream };
});

const sdk = jest.requireMock('@anthropic-ai/sdk') as any;
const anthropicCreate = sdk.__create;
const anthropicRetrieve = sdk.__retrieve;
const anthropicStream = sdk.__stream;

const GOOD_RESP = {
  id: 'a',
  model: 'test',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const MODEL: Model = { id: 'm', name: 'claude-3-5-sonnet-20241022', ApiKey: 'k' } as Model;
const MSGS: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' },
];
const TOOLS: OpenAI.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'a', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'b', parameters: { type: 'object', properties: {} } } },
];

/** The `cache_control` marker, as it appears on a marked block. */
const EPHEMERAL = { type: 'ephemeral' };

describe('applyCacheBreakpoints', () => {
  const SYSTEM = 'You are helpful.';
  const MESSAGES: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
  const ANTHROPIC_TOOLS: Anthropic.Tool[] = [
    { name: 'a', input_schema: { type: 'object', properties: {} } },
    { name: 'b', input_schema: { type: 'object', properties: {} } },
  ];

  test('marks the last tool, the system block, and the last message — three breakpoints', () => {
    const out = applyCacheBreakpoints({
      system: SYSTEM,
      messages: MESSAGES,
      tools: ANTHROPIC_TOOLS,
    });

    expect(out.breakpoints).toBe(3);

    // 1. Last tool only — an inner breakpoint on every tool would waste slots.
    expect(out.tools?.[0]).not.toHaveProperty('cache_control');
    expect(out.tools?.[1]).toHaveProperty('cache_control', EPHEMERAL);

    // 2. System is promoted from a string to a marked text block: the only shape
    //    that can carry the marker.
    expect(out.system).toEqual([
      { type: 'text', text: SYSTEM, cache_control: EPHEMERAL },
    ]);

    // 3. Tail message string content is promoted to a marked block array.
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'hi', cache_control: EPHEMERAL },
    ]);
  });

  test('never mutates its inputs, so a retry can rebuild from the originals', () => {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];
    const tools: Anthropic.Tool[] = [{ name: 'a', input_schema: { type: 'object', properties: {} } }];

    applyCacheBreakpoints({ system: SYSTEM, messages, tools });

    expect(messages[0].content).toBe('hi');
    expect(tools[0]).not.toHaveProperty('cache_control');
  });

  test('anchors the tail to the last block that can carry the marker', () => {
    // A trailing block of an unmarkable type must not be marked; the breakpoint
    // moves back to the tool_result, which caches a shorter (still valid) prefix.
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'some_future_block' },
        ],
      },
    ] as unknown as Anthropic.MessageParam[];

    const out = applyCacheBreakpoints({ messages });

    const content = out.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toHaveProperty('cache_control', EPHEMERAL);
    expect(content[1]).not.toHaveProperty('cache_control');
    expect(out.breakpoints).toBe(1);
  });

  test('skips the tail breakpoint on an empty turn (Anthropic rejects empty text blocks)', () => {
    const out = applyCacheBreakpoints({
      system: SYSTEM,
      messages: [{ role: 'user', content: '' }],
    });

    expect(out.breakpoints).toBe(1); // system only — no tool block, no markable tail
    expect(out.messages[0].content).toBe('');
  });

  test('places nothing when there is no system, no tools and no messages', () => {
    const out = applyCacheBreakpoints({ messages: [] });
    expect(out.breakpoints).toBe(0);
    expect(out.system).toBeUndefined();
    expect(out.tools).toBeUndefined();
  });
});

describe('isCacheControlRejection', () => {
  test('matches a 400 that names cache_control as unsupported', () => {
    expect(isCacheControlRejection({ status: 400, message: 'Unsupported field: cache_control' })).toBe(true);
    expect(isCacheControlRejection({ status: 422, message: 'unknown parameter cache_control' })).toBe(true);
  });

  test('does not match unrelated failures — they must propagate, not be retried', () => {
    // Right shape, wrong field.
        expect(isCacheControlRejection({ status: 400, message: 'Unsupported field: temperature' })).toBe(false);
    // Names the field but is not an unsupported-parameter error (e.g. too many
    // breakpoints) — silently retrying would mask a real bug.
    expect(isCacheControlRejection({ status: 400, message: 'too many cache_control blocks' })).toBe(false);
    expect(isCacheControlRejection({ status: 500, message: 'cache_control unsupported' })).toBe(false);
    expect(isCacheControlRejection(new Error('boom'))).toBe(false);
  });
});

describe('AnthropicAdapter prompt-cache breakpoints on the wire', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearModelCapabilityCache();
    __resetCacheControlSupport();
    anthropicCreate.mockResolvedValue(GOOD_RESP);
    anthropicStream.mockReturnValue({ finalMessage: jest.fn().mockResolvedValue(GOOD_RESP) });
    anthropicRetrieve.mockResolvedValue({});
  });

  test('createCompletion sends breakpoints on tools, system and the last message', async () => {
    await new AnthropicAdapter().createCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, tools: TOOLS, temperature: 0,
    });

    const body = anthropicCreate.mock.calls[0][0];
    expect(body.tools[body.tools.length - 1]).toHaveProperty('cache_control', EPHEMERAL);
    expect(body.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: EPHEMERAL },
    ]);
    expect(body.messages[body.messages.length - 1].content).toEqual([
      { type: 'text', text: 'hi', cache_control: EPHEMERAL },
    ]);
  });

  test('the streaming path gets the same breakpoints', async () => {
    await new AnthropicAdapter().createStreamCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, tools: TOOLS, temperature: 0,
    });

    const body = anthropicStream.mock.calls[0][0];
    expect(body.tools[body.tools.length - 1]).toHaveProperty('cache_control', EPHEMERAL);
    expect(body.system[0]).toHaveProperty('cache_control', EPHEMERAL);
  });

  test('an endpoint that rejects cache_control degrades instead of failing, once per endpoint', async () => {
    const err = Object.assign(new Error('Unsupported field: cache_control'), { status: 400 });
    anthropicCreate.mockRejectedValueOnce(err).mockResolvedValue(GOOD_RESP);

    const proxied: Model = { ...MODEL, provider: 'anthropic', baseUrl: 'https://proxy.example/v1' } as Model;
    const result = await new AnthropicAdapter().createCompletion({
      model: proxied, apiKey: 'k', messages: MSGS, tools: TOOLS, temperature: 0,
    });

    expect(result.completion).toBeDefined();
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    // The retry drops the markers entirely — system falls back to a plain string.
    const retry = anthropicCreate.mock.calls[1][0];
    expect(retry.system).toBe('You are helpful.');
    expect(retry.tools.every((t: object) => !('cache_control' in t))).toBe(true);

    // A later call to the SAME endpoint must not pay the failed probe again.
    anthropicCreate.mockClear();
    await new AnthropicAdapter().createCompletion({
      model: proxied, apiKey: 'k', messages: MSGS, tools: TOOLS, temperature: 0,
    });
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(anthropicCreate.mock.calls[0][0].system).toBe('You are helpful.');
  });

  test('a different endpoint still gets breakpoints after another one opted out', async () => {
    const err = Object.assign(new Error('Unsupported field: cache_control'), { status: 400 });
    anthropicCreate.mockRejectedValueOnce(err).mockResolvedValue(GOOD_RESP);

    await new AnthropicAdapter().createCompletion({
      model: { ...MODEL, baseUrl: 'https://proxy.example/v1' } as Model,
      apiKey: 'k', messages: MSGS, temperature: 0,
    });

    anthropicCreate.mockClear();
    await new AnthropicAdapter().createCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, temperature: 0,
    });
    expect(Array.isArray(anthropicCreate.mock.calls[0][0].system)).toBe(true);
  });

  test('an unrelated 400 propagates rather than being masked by a retry', async () => {
    const err = Object.assign(new Error('credit balance is too low'), { status: 400 });
    anthropicCreate.mockRejectedValue(err);

    await expect(
      new AnthropicAdapter().createCompletion({
        model: MODEL, apiKey: 'k', messages: MSGS, temperature: 0,
      })
    ).rejects.toThrow('credit balance is too low');
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicAdapter usage mapping with cache buckets', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearModelCapabilityCache();
    __resetCacheControlSupport();
    anthropicRetrieve.mockResolvedValue({});
  });

  test('prompt_tokens is the FULL input context and cached_tokens is the re-read', async () => {
    anthropicCreate.mockResolvedValue({
      ...GOOD_RESP,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 900,
      },
    });

    const { completion } = await new AnthropicAdapter().createCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, temperature: 0,
    });

    // input_tokens alone (10) would badly under-report the context; the meter
    // needs all three buckets, with the cheap re-read broken out separately.
    expect(completion.usage?.prompt_tokens).toBe(1010);
    expect(completion.usage?.completion_tokens).toBe(5);
    expect(completion.usage?.total_tokens).toBe(1015);
    expect(completion.usage?.prompt_tokens_details?.cached_tokens).toBe(900);
  });

  test('omits prompt_tokens_details when the endpoint reports no cache buckets at all', async () => {
    anthropicCreate.mockResolvedValue(GOOD_RESP); // usage without cache fields

    const { completion } = await new AnthropicAdapter().createCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, temperature: 0,
    });

    // "doesn't report caching" must stay distinguishable from "0 cached".
    expect(completion.usage?.prompt_tokens).toBe(10);
    expect(completion.usage).not.toHaveProperty('prompt_tokens_details');
  });

  test('reports 0 cached when the endpoint does report buckets but nothing hit', async () => {
    anthropicCreate.mockResolvedValue({
      ...GOOD_RESP,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 0,
      },
    });

    const { completion } = await new AnthropicAdapter().createCompletion({
      model: MODEL, apiKey: 'k', messages: MSGS, temperature: 0,
    });

    expect(completion.usage?.prompt_tokens_details?.cached_tokens).toBe(0);
  });
});
