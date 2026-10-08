/**
 * Tests for the OpenAI Responses API adapter.
 *
 * The adapter exists for ONE reason: carrying encrypted reasoning items across
 * turns of an agentic tool loop, so a gpt-5 / o-series model stops re-deriving its
 * own reasoning on every iteration. Everything else must be behaviour-identical to
 * the Chat Completions path — same stateless full-history request, same
 * ChatCompletion-shaped result — because ModelHandler/ToolHandler are unchanged.
 *
 * Pins:
 *  - message/tool translation into Responses `input` shape
 *  - tool translation (flattened, non-strict)
 *  - ChatCompletion-shaped result incl. usage in Chat Completions spelling
 *  - `call_id` (not the item `id`) becomes the tool_call id
 *  - reasoning items are carried to the next turn, anchored to the first tool call
 *  - the request is stateless (store:false, no previous_response_id)
 *  - unsupported optional params are negotiated away, once, and remembered
 */

const mockResponsesCreate = jest.fn();

jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: () => ({ responses: { create: (...a: unknown[]) => mockResponsesCreate(...a) } }),
  getProviderDefaultHeaders: () => undefined,
}));

jest.mock('@/backend/utils/transientRetry', () => ({
  withTransientRetry: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

import type OpenAI from 'openai';
import {
  OpenAiResponsesAdapter,
  toResponsesInput,
  toResponsesTools,
  fromResponse,
  __resetReasoningStore,
  __resetParamNegotiation,
} from '@/backend/services/model/adapters/openaiResponsesAdapter';
import type { Model } from '@/shared/types/model';

const model = (name = 'gpt-5'): Model =>
  ({
    id: 'm1',
    name,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    ApiKey: 'k',
    adapter: 'openai-responses',
  } as unknown as Model);

/** A Responses result carrying text + a function call + an encrypted reasoning item. */
const responseWithToolCall = (overrides: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  created_at: 1700000000,
  model: 'gpt-5',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED_BLOB' },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
    {
      type: 'function_call',
      id: 'fc_item_1',
      call_id: 'call_abc',
      name: 'get_weather',
      arguments: '{"city":"Berlin"}',
    },
  ],
  usage: {
    input_tokens: 1200,
    output_tokens: 40,
    total_tokens: 1240,
    input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
    output_tokens_details: { reasoning_tokens: 25 },
  },
  ...overrides,
});

const call = (m: Model, messages: OpenAI.ChatCompletionMessageParam[], extra = {}) =>
  new OpenAiResponsesAdapter().createCompletion({
    model: m,
    apiKey: 'sk-test',
    messages,
    temperature: 0,
    ...extra,
  });

const bodyOf = (n = 0) => mockResponsesCreate.mock.calls[n][0] as Record<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  __resetReasoningStore();
  __resetParamNegotiation();
  mockResponsesCreate.mockResolvedValue(responseWithToolCall());
});

describe('toResponsesInput', () => {
  it('translates a full tool-using conversation', () => {
    const input = toResponsesInput([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Weather in Berlin?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' },
    ]);

    expect(input).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Weather in Berlin?' },
      { role: 'assistant', content: 'Let me check.' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Berlin"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"tempC":18}' },
    ]);
  });

  it('omits an assistant item with no text but keeps its tool call', () => {
    const input = toResponsesInput([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
    ]);
    expect(input).toEqual([{ type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' }]);
  });

  it('renames multipart user content to the Responses part types', () => {
    const input = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);

    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
    ]);
  });

  it('never relabels unsupported audio bytes as WAV', () => {
    const input = toResponsesInput([{
      role: 'user',
      content: [{
        type: 'audio_url',
        audio_url: { url: 'data:audio/ogg;base64,T0dH' },
      }] as never,
    }]);

    expect(input).toEqual([{
      role: 'user',
      content: [{
        type: 'input_text',
        text: '[audio/ogg audio attachment omitted: OpenAI input_audio accepts only MP3 or WAV]',
      }],
    }]);
    expect(JSON.stringify(input)).not.toContain('format\":\"wav');
  });

  it('inserts carried reasoning immediately before its anchoring tool call', () => {
    const carried = new Map([
      ['call_1', [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' }]],
    ]);
    const input = toResponsesInput(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'thinking',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
      carried as never,
    );

    const types = input.map((i) => (i as { type?: string; role?: string }).type ?? (i as { role: string }).role);
    // Reasoning must precede the assistant text and the function call of its turn.
    expect(types).toEqual(['user', 'reasoning', 'assistant', 'function_call', 'function_call_output']);
  });

  it('does not re-send reasoning whose anchoring tool call is gone from history', () => {
    // FLUJO's history rewriting (compaction, collapse, handoff strip) can drop the
    // exchange; the reasoning then belongs to something the model isn't shown.
    const carried = new Map([
      ['call_gone', [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' }]],
    ]);
    const input = toResponsesInput([{ role: 'user', content: 'go' }], carried as never);
    expect(input).toEqual([{ role: 'user', content: 'go' }]);
  });
});

describe('toResponsesTools', () => {
  it('flattens the nested function object and disables strict mode', () => {
    const out = toResponsesTools([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ]);

    expect(out).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        // Arbitrary MCP schemas don't satisfy strict mode's requirements.
        strict: false,
      },
    ]);
  });

  it('returns undefined for an empty tool list', () => {
    expect(toResponsesTools([])).toBeUndefined();
    expect(toResponsesTools(undefined)).toBeUndefined();
  });
});

describe('fromResponse', () => {
  it('produces a ChatCompletion with tool calls keyed by call_id', () => {
    const { completion } = fromResponse(responseWithToolCall() as never, 'gpt-5');
    const message = completion.choices[0].message;

    expect(completion.object).toBe('chat.completion');
    expect(message.content).toBe('Checking.');
    // call_id, NOT the output item's own id — the follow-up output must reference it.
    expect(message.tool_calls?.[0].id).toBe('call_abc');
    expect(message.tool_calls?.[0]).toMatchObject({
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(completion.choices[0].finish_reason).toBe('tool_calls');
  });

  it('maps usage into Chat Completions spelling so mapOpenAiUsage works unchanged', () => {
    const { completion } = fromResponse(responseWithToolCall() as never, 'gpt-5');
    expect(completion.usage).toMatchObject({
      prompt_tokens: 1200,
      completion_tokens: 40,
      total_tokens: 1240,
      prompt_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
      completion_tokens_details: { reasoning_tokens: 25 },
    });
  });

  it('maps an output-token-capped response to finish_reason "length"', () => {
    const { completion } = fromResponse(
      responseWithToolCall({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
      }) as never,
      'gpt-5',
    );
    expect(completion.choices[0].finish_reason).toBe('length');
  });

  it('returns null content and finish_reason "stop" for a text-free, tool-free turn', () => {
    const { completion } = fromResponse(responseWithToolCall({ output: [] }) as never, 'gpt-5');
    expect(completion.choices[0].message.content).toBeNull();
    expect(completion.choices[0].finish_reason).toBe('stop');
  });

  it('extracts only encrypted reasoning items (summary-only ones are not re-sendable)', () => {
    const { reasoning } = fromResponse(
      responseWithToolCall({
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' },
          { type: 'reasoning', id: 'rs_2', summary: [{ type: 'summary_text', text: 'no blob' }] },
        ],
      }) as never,
      'gpt-5',
    );
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].id).toBe('rs_1');
  });

  it('normalizes image-generation and audio output items as media', () => {
    const { media } = fromResponse(responseWithToolCall({
      output: [
        {
          type: 'image_generation_call',
          id: 'ig_1',
          status: 'completed',
          result: 'IMAGE_BASE64',
        },
        {
          type: 'message',
          id: 'm_audio',
          role: 'assistant',
          status: 'completed',
          content: [{
            type: 'output_audio',
            data: 'AUDIO_BASE64',
            transcript: 'hello',
            mime_type: 'audio/mpeg',
          }],
        },
      ],
    }) as never, 'gpt-5');

    expect(media).toEqual([
      { type: 'image', data: 'IMAGE_BASE64', mimeType: 'image/png' },
      {
        type: 'audio',
        data: 'AUDIO_BASE64',
        mimeType: 'audio/mpeg',
        transcript: 'hello',
      },
    ]);
  });

  it('maps audio and file/video extensions into Responses input parts', () => {
    const input = toResponsesInput([{
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: { data: 'AUDIO', format: 'mp3' },
        },
        {
          type: 'file',
          file: {
            file_data: 'data:application/pdf;base64,PDF',
            filename: 'brief.pdf',
          },
        },
        {
          type: 'video_url',
          video_url: { url: 'data:video/mp4;base64,VIDEO' },
        },
      ],
    } as never]);

    expect(input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_audio', data: 'AUDIO', format: 'mp3' },
        {
          type: 'input_file',
          file_data: 'data:application/pdf;base64,PDF',
          filename: 'brief.pdf',
        },
        {
          type: 'input_file',
          file_data: 'data:video/mp4;base64,VIDEO',
          filename: 'video',
        },
      ],
    }]);
  });
});

describe('request shape', () => {
  it('is stateless: store:false and no previous_response_id', () => {
    return call(model(), [{ role: 'user', content: 'hi' }]).then(() => {
      expect(bodyOf().store).toBe(false);
      expect(bodyOf()).not.toHaveProperty('previous_response_id');
      expect(bodyOf()).not.toHaveProperty('conversation');
    });
  });

  it('enables the Responses image-generation tool for image-output models', async () => {
    await call(
      { ...model(), outputModalities: ['text', 'image'] },
      [{ role: 'user', content: 'draw a banana' }],
    );
    expect(bodyOf().tools).toEqual(expect.arrayContaining([
      { type: 'image_generation' },
    ]));
  });

  it('requests encrypted reasoning content', async () => {
    await call(model(), [{ role: 'user', content: 'hi' }]);
    expect(bodyOf().include).toEqual(['reasoning.encrypted_content']);
  });

  it('sends the output cap as max_output_tokens', async () => {
    await call(model(), [{ role: 'user', content: 'hi' }], { maxTokens: 512 });
    expect(bodyOf().max_output_tokens).toBe(512);
    expect(bodyOf()).not.toHaveProperty('max_tokens');
  });

  it('maps configured effort to Responses reasoning.effort', async () => {
    await call(
      { ...model(), reasoningEffort: 'high' },
      [{ role: 'user', content: 'hi' }],
    );
    expect(bodyOf().reasoning).toEqual({ effort: 'high' });
  });

  it('forwards the prompt cache key', async () => {
    await call(model(), [{ role: 'user', content: 'hi' }], { promptCacheKey: 'flujo-tabc' });
    expect(bodyOf().prompt_cache_key).toBe('flujo-tabc');
  });
});

describe('native Responses streaming', () => {
  it('forwards output text and function arguments before returning the final response', async () => {
    async function* events() {
      yield {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'fc_item_1',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '',
        },
      };
      yield { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Checking.' };
      yield {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_item_1',
        output_index: 1,
        delta: '{"city":"Berlin"}',
      };
      yield { type: 'response.completed', response: responseWithToolCall() };
    }
    mockResponsesCreate.mockResolvedValueOnce(events());
    const deltas: unknown[] = [];
    const result = await new OpenAiResponsesAdapter().createStreamCompletion({
      model: model(),
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      onModelDelta: delta => deltas.push(delta),
    });

    expect(bodyOf().stream).toBe(true);
    expect(result.completion.choices[0].message.tool_calls?.[0].id).toBe('call_abc');
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ contentDelta: 'Checking.' }),
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({
          id: 'call_abc',
          nameDelta: 'get_weather',
        }),
      }),
      expect.objectContaining({
        toolCallDelta: expect.objectContaining({ argumentsDelta: '{"city":"Berlin"}' }),
      }),
    ]));
    expect(new Set(deltas.map(delta => (delta as { messageId: string }).messageId))).toEqual(
      new Set([result.liveMessageId]),
    );
  });
});

describe('reasoning carry-over across turns', () => {
  const history: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Weather in Berlin?' }];

  it('carries the reasoning blob into the next turn of the same node', async () => {
    const m = model();
    const session = { conversationId: 'conv-1', nodeId: 'node-1' };

    // Turn 1: model asks for a tool; the response carries an encrypted blob.
    const first = await call(m, history, session);
    const callId = first.completion.choices[0].message.tool_calls![0].id;
    expect(bodyOf(0)).not.toHaveProperty('include_reasoning'); // sanity: no invented fields

    // Turn 2: the loop re-enters with the tool result appended.
    mockResponsesCreate.mockResolvedValue(responseWithToolCall({ output: [] }));
    await call(
      m,
      [
        ...history,
        {
          role: 'assistant',
          content: 'Checking.',
          tool_calls: [
            { id: callId, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Berlin"}' } },
          ],
        },
        { role: 'tool', tool_call_id: callId, content: '{"tempC":18}' },
      ],
      session,
    );

    const input = bodyOf(1).input as Array<Record<string, unknown>>;
    const reasoning = input.find((i) => i.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect(reasoning!.encrypted_content).toBe('ENCRYPTED_BLOB');
  });

  it('scopes carried reasoning to the (conversation, node) pair', async () => {
    const m = model();
    const first = await call(m, history, { conversationId: 'conv-1', nodeId: 'node-1' });
    const callId = first.completion.choices[0].message.tool_calls![0].id;

    // A DIFFERENT node must not inherit node-1's reasoning.
    mockResponsesCreate.mockResolvedValue(responseWithToolCall({ output: [] }));
    await call(
      m,
      [
        ...history,
        {
          role: 'assistant',
          content: 'x',
          tool_calls: [{ id: callId, type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
      ],
      { conversationId: 'conv-1', nodeId: 'node-2' },
    );

    const input = bodyOf(1).input as Array<Record<string, unknown>>;
    expect(input.find((i) => i.type === 'reasoning')).toBeUndefined();
  });

  it('carries nothing when the turn made no tool calls', async () => {
    mockResponsesCreate.mockResolvedValue(
      responseWithToolCall({
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'BLOB' },
          { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
        ],
      }),
    );
    const session = { conversationId: 'conv-2', nodeId: 'node-1' };
    await call(model(), history, session);
    await call(model(), history, session);

    const input = bodyOf(1).input as Array<Record<string, unknown>>;
    // The exchange finished; there is no tool call to anchor reasoning to.
    expect(input.find((i) => i.type === 'reasoning')).toBeUndefined();
  });

  it('does not carry reasoning when there is no conversation in scope', async () => {
    await call(model(), history);
    await call(model(), history);
    const input = bodyOf(1).input as Array<Record<string, unknown>>;
    expect(input.find((i) => i.type === 'reasoning')).toBeUndefined();
  });
});

describe('optional-parameter negotiation', () => {
  const unsupported = (param: string) =>
    Object.assign(new Error(`Unsupported parameter: '${param}' is not supported with this model.`), {
      status: 400,
      error: { message: `Unsupported parameter: '${param}' is not supported with this model.` },
    });

  it('drops temperature when the model rejects it, then remembers', async () => {
    const m = model('o3');
    mockResponsesCreate
      .mockRejectedValueOnce(unsupported('temperature'))
      .mockResolvedValue(responseWithToolCall());

    await call(m, [{ role: 'user', content: 'hi' }]);
    expect(mockResponsesCreate).toHaveBeenCalledTimes(2);
    expect(bodyOf(0)).toHaveProperty('temperature');
    expect(bodyOf(1)).not.toHaveProperty('temperature');

    // Remembered: the next call skips the doomed first attempt entirely.
    mockResponsesCreate.mockClear();
    await call(m, [{ role: 'user', content: 'hi' }]);
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).not.toHaveProperty('temperature');
  });

  it('drops include when a non-reasoning model rejects encrypted_content', async () => {
    const m = model('gpt-4o-mini');
    mockResponsesCreate
      .mockRejectedValueOnce(unsupported('include[0].reasoning.encrypted_content'))
      .mockResolvedValue(responseWithToolCall());

    await call(m, [{ role: 'user', content: 'hi' }]);
    expect(bodyOf(0)).toHaveProperty('include');
    expect(bodyOf(1)).not.toHaveProperty('include');
  });

  it('negotiates away more than one parameter in sequence', async () => {
    const m = model('weird-model');
    mockResponsesCreate
      .mockRejectedValueOnce(unsupported('temperature'))
      .mockRejectedValueOnce(unsupported('include'))
      .mockResolvedValue(responseWithToolCall());

    await call(m, [{ role: 'user', content: 'hi' }], { promptCacheKey: 'flujo-tabc' });
    expect(mockResponsesCreate).toHaveBeenCalledTimes(3);
    expect(bodyOf(2)).not.toHaveProperty('temperature');
    expect(bodyOf(2)).not.toHaveProperty('include');
    // Untouched params survive the negotiation.
    expect(bodyOf(2).prompt_cache_key).toBe('flujo-tabc');
  });

  it('propagates an unrelated 400 without retrying', async () => {
    const err = Object.assign(new Error('context_length_exceeded'), {
      status: 400,
      error: { message: 'context_length_exceeded' },
    });
    mockResponsesCreate.mockRejectedValue(err);

    await expect(call(model(), [{ role: 'user', content: 'hi' }])).rejects.toThrow('context_length_exceeded');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
  });

  it('propagates a non-400 error without retrying', async () => {
    mockResponsesCreate.mockRejectedValue(Object.assign(new Error('server error'), { status: 500 }));
    await expect(call(model(), [{ role: 'user', content: 'hi' }])).rejects.toThrow('server error');
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
  });
});
