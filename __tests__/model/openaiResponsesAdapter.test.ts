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
  withResponsesCacheBreakpoints,
  prepareResponsesReasoning,
  forgetReasoning,
} from '@/backend/services/model/adapters/openaiResponsesAdapter';
import type { Model } from '@/shared/types/model';
import { runWithWorkspace } from '@/utils/workspace';
import type { ResponsesSessionState } from '@/backend/services/model/adapters/responsesSessionState';

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
  it('marks Responses history without marking late instructions or changing encrypted reasoning', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] };
    const input = [
      { role: 'user', content: 'task' }, reasoning,
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'result' },
      { role: 'system', content: 'late instruction' },
    ];
    const marked = withResponsesCacheBreakpoints(input as never);
    expect(marked[1]).toBe(reasoning);
    expect(marked[4]).toBe(input[4]);
    expect(marked[0]).toMatchObject({ content: [{ prompt_cache_breakpoint: { mode: 'explicit' } }] });
    expect(marked[3]).toMatchObject({ output: [{ prompt_cache_breakpoint: { mode: 'explicit' } }] });
  });
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

describe('reasoning ownership and projection invalidation (#1091)', () => {
  const history = (): OpenAI.ChatCompletionMessageParam[] => [
    { role: 'system', content: 'Never send messages.' },
    { role: 'user', content: 'Check the weather in Berlin.' },
  ];
  const tools: OpenAI.ChatCompletionFunctionTool[] = [{ type: 'function', function: {
    name: 'get_weather', description: 'Read weather', parameters: { type: 'object', properties: {} },
  } }];
  const session = { conversationId: 'owned-conversation', nodeId: 'owned-node', tools };
  const seed = async () => {
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny' });
    return messages;
  };
  const noReasoning = () => expect((bodyOf(1).input as { type?: string }[])
    .some(item => item.type === 'reasoning')).toBe(false);

  it.each([
    ['model', { name: 'another-model' }],
    ['connection', { id: 'another-connection' }],
    ['provider', { provider: 'openrouter' }],
    ['endpoint', { baseUrl: 'https://openrouter.ai/api/v1' }],
    ['reasoning policy', { reasoningEffort: 'high' }],
  ])('does not replay opaque state after changing %s', async (_name, change) => {
    const messages = await seed();
    await call({ ...model(), ...change } as Model, messages, session);
    noReasoning();
  });

  it('does not replay another credential scope', async () => {
    await call(model(), await seed(), { ...session, apiKey: 'another-fixture-key' });
    noReasoning();
  });

  it('does not replay state after changing tool authority', async () => {
    await call(model(), await seed(), { ...session, tools: [{ type: 'function', function: {
      ...tools[0].function, parameters: { type: 'object', properties: { recipient: { type: 'string' } } },
    } }] });
    noReasoning();
  });

  it.each(['instruction', 'source', 'arguments'])('does not replay an edited %s prefix', async kind => {
    const messages = await seed();
    if (kind === 'instruction') messages[0].content = 'Sending is now allowed.';
    if (kind === 'source') messages[1].content = 'Check the weather in Bogota.';
    if (kind === 'arguments') (messages[2] as OpenAI.ChatCompletionAssistantMessageParam)
      .tool_calls![0] = { id: 'call_abc', type: 'function', function: {
        name: 'get_weather', arguments: '{"city":"Bogota"}',
      } };
    await call(model(), messages, session);
    noReasoning();
  });

  it('does not replay stale state on the streaming route', async () => {
    const messages = await seed();
    mockResponsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.completed', response: responseWithToolCall() };
    })());
    await new OpenAiResponsesAdapter().createStreamCompletion({ model: model('another-model'),
      apiKey: 'sk-test', messages, temperature: 0, ...session });
    noReasoning();
  });

  it('keeps unchanged streaming continuation and exact opaque bytes', async () => {
    const messages = await seed();
    mockResponsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.completed', response: responseWithToolCall({ output: [] }) };
    })());
    await new OpenAiResponsesAdapter().createStreamCompletion({ model: model(),
      apiKey: 'sk-test', messages, temperature: 0, ...session });
    expect(bodyOf(1).input).toContainEqual({ type: 'reasoning', id: 'rs_1', summary: [],
      encrypted_content: 'ENCRYPTED_BLOB' });
  });

  it('does not confuse delimiter-containing conversation and node IDs', async () => {
    const messages = history();
    const first = await call(model(), messages, { ...session, conversationId: 'a|b', nodeId: 'c' });
    messages.push(first.completion.choices[0].message);
    await call(model(), messages, { ...session, conversationId: 'a', nodeId: 'b|c' });
    noReasoning();
  });

  it('keeps workspace ownership across an asynchronous completion', async () => {
    const data = { model: model(), apiKey: 'fixture', messages: history(), ...session };
    const translated = fromResponse(responseWithToolCall() as never, model().name);
    const pending = runWithWorkspace('reasoning-owner-a', () => prepareResponsesReasoning(data, 'openai-responses'));
    runWithWorkspace('reasoning-owner-b', () => pending.remember(translated.completion, translated.reasoning));
    const next = { ...data, messages: [...data.messages, translated.completion.choices[0].message] };
    expect(runWithWorkspace('reasoning-owner-b', () => prepareResponsesReasoning(next, 'openai-responses').carried?.size)).toBe(0);
    expect(runWithWorkspace('reasoning-owner-a', () => prepareResponsesReasoning(next, 'openai-responses').carried?.get('call_abc')))
      .toEqual(translated.reasoning);
  });

  it.each(['route replacement', 'forget'])('ignores late completion after %s', kind => {
    const data = { model: model(), apiKey: 'fixture', messages: history(), ...session };
    const first = prepareResponsesReasoning(data, 'openai-responses');
    if (kind === 'route replacement') prepareResponsesReasoning({ ...data, model: model('replacement') }, 'openai-responses');
    else forgetReasoning(session.conversationId, session.nodeId);
    const current = prepareResponsesReasoning(data, 'openai-responses');
    const translated = fromResponse(responseWithToolCall() as never, model().name);
    current.remember(translated.completion, [{ ...translated.reasoning[0], encrypted_content: 'CURRENT' }]);
    first.remember(translated.completion, translated.reasoning);
    const next = prepareResponsesReasoning({ ...data, messages: [...data.messages, translated.completion.choices[0].message] }, 'openai-responses');
    expect(next.carried?.get('call_abc')?.[0].encrypted_content).toBe('CURRENT');
  });

  it('invalidates state when switching between the shared SDK adapters', () => {
    const data = { model: model(), apiKey: 'fixture', messages: history(), ...session };
    const first = prepareResponsesReasoning(data, 'openrouter-agent');
    const translated = fromResponse(responseWithToolCall() as never, model().name);
    first.remember(translated.completion, translated.reasoning);
    expect(prepareResponsesReasoning({ ...data, messages: [...data.messages, translated.completion.choices[0].message] },
      'openai-responses').carried?.size).toBe(0);
  });
});

describe('complete native output replay', () => {
  const nativeOutput = () => [
    { type: 'reasoning', id: 'rs_a', summary: [], encrypted_content: 'OPAQUE_ñ_A' },
    { type: 'message', id: 'msg_a', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Checking.', annotations: [] }] },
    { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'get_weather', arguments: '{"city":"Berlin"}' },
    { type: 'reasoning', id: 'rs_b', summary: [], encrypted_content: 'OPAQUE_ñ_B' },
    { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'get_weather', arguments: '{"city":"Bogota"}' },
    { type: 'message', id: 'msg_b', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'Please wait.', annotations: [] }] },
  ];
  const session = { conversationId: 'complete-window', nodeId: 'weather' };
  const history = (): OpenAI.ChatCompletionMessageParam[] => [{ role: 'user', content: 'Compare both cities.' }];

  it.each([false, true])('restores complete output after a JSON checkpoint and process-cache loss (streaming=%s)', async streaming => {
    const output = nativeOutput();
    const messages = history();
    let saved: ResponsesSessionState | undefined;
    const onResponsesSessionChange = (value: ResponsesSessionState | undefined) => {
      saved = value ? JSON.parse(JSON.stringify(value)) : undefined;
    };
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const first = await call(model(), messages, { ...session, onResponsesSessionChange });
    messages.push(first.completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call_a', content: 'Berlin: sunny' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Bogota: rain' });
    __resetReasoningStore();
    if (streaming) mockResponsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.completed', response: responseWithToolCall({ output: [] }) };
    })());
    await new OpenAiResponsesAdapter()[streaming ? 'createStreamCompletion' : 'createCompletion']({
      model: model(), apiKey: 'sk-test', messages, ...session,
      ...{ responsesSession: saved, onResponsesSessionChange },
    });
    expect((bodyOf(1).input as unknown[]).slice(1, 1 + output.length)).toEqual(output);
    expect(JSON.stringify(saved)).not.toContain('sk-test');
  });

  it.each(['connection', 'credential', 'node', 'conversation', 'prefix', 'policy', 'missing', 'corrupt', 'workspace'])(
    'uses canonical history after restart with an incompatible %s checkpoint', async change => {
      const output = nativeOutput();
      const messages = history();
      let saved: ResponsesSessionState | undefined;
      const onResponsesSessionChange = (value: ResponsesSessionState | undefined) => { saved = value; };
      mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
      const first = await call(model(), messages, { ...session, onResponsesSessionChange });
      messages.push(first.completion.choices[0].message);
      __resetReasoningStore();
      if (change === 'policy') saved!.version = 0 as never;
      if (change === 'missing') saved = undefined;
      if (change === 'corrupt') saved!.records[0][1].retainedChars = 0;
      if (change === 'prefix') messages[0].content = 'An accepted correction.';
      const data = { model: change === 'connection' ? { ...model(), id: 'other' } : model(),
        apiKey: change === 'credential' ? 'other' : 'sk-test', messages,
        conversationId: change === 'conversation' ? 'other' : session.conversationId,
        nodeId: change === 'node' ? 'other' : session.nodeId, responsesSession: saved, onResponsesSessionChange };
      if (change === 'workspace') await runWithWorkspace('other-workspace', () => new OpenAiResponsesAdapter().createCompletion(data));
      else await new OpenAiResponsesAdapter().createCompletion(data);
      expect(bodyOf(1).input).toEqual(toResponsesInput(messages));
    });

  it('does not resurrect process-local output when the owning checkpoint was removed', async () => {
    const output = nativeOutput();
    const messages = history();
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const first = await call(model(), messages, { ...session, onResponsesSessionChange: () => undefined });
    messages.push(first.completion.choices[0].message);
    await call(model(), messages, { ...session, responsesSession: undefined, onResponsesSessionChange: () => undefined });
    expect(bodyOf(1).input).toEqual(toResponsesInput(messages));
  });

  it.each(['replacement', 'stop'])('fences late durable publication after %s', change => {
    const controller = new AbortController();
    const publish = jest.fn();
    const data = { model: model(), apiKey: 'sk-test', messages: history(), ...session,
      signal: controller.signal, onResponsesSessionChange: publish };
    const first = prepareResponsesReasoning(data, 'openai-responses');
    if (change === 'replacement') prepareResponsesReasoning(data, 'openai-responses');
    else controller.abort();
    publish.mockClear();
    const response = responseWithToolCall({ output: nativeOutput() });
    const translated = fromResponse(response as never, model().name);
    first.remember(translated.completion, translated.reasoning, response.output as never);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([false, true])('replays exact interleaved items, IDs and phases (streaming=%s)', async streaming => {
    const output = nativeOutput();
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call_a', content: 'Berlin: sunny' },
      { role: 'tool', tool_call_id: 'call_b', content: 'Bogota: rain' });
    if (streaming) mockResponsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.completed', response: responseWithToolCall({ output: [] }) };
    })());
    await new OpenAiResponsesAdapter()[streaming ? 'createStreamCompletion' : 'createCompletion']({
      model: model(), apiKey: 'sk-test', messages, ...session,
    });
    expect((bodyOf(1).input as unknown[]).slice(1, 1 + output.length)).toEqual(output);
    expect((bodyOf(1).input as unknown[]).slice(1 + output.length)).toEqual([
      { type: 'function_call_output', call_id: 'call_a', output: 'Berlin: sunny' },
      { type: 'function_call_output', call_id: 'call_b', output: 'Bogota: rain' },
    ]);
  });

  it.each([false, true])('keeps final-answer output without a tool anchor (reasoning=%s)', async reasoning => {
    const output = nativeOutput().filter(item => item.type === 'message' || (reasoning && item.type === 'reasoning'));
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message, { role: 'user', content: 'Continue.' });
    await call(model(), messages, session);
    expect((bodyOf(1).input as unknown[]).slice(1, -1)).toEqual(output);
  });

  it('preserves both native windows and the intervening tool results over three turns', async () => {
    const firstOutput = nativeOutput();
    const secondOutput = nativeOutput().map(item => ({ ...item, id: item.id + '_2',
      ...('call_id' in item ? { call_id: item.call_id + '_2' } : {}) }));
    const messages = history();
    for (const output of [firstOutput, secondOutput]) {
      mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
      const turn = await call(model(), messages, session);
      messages.push(turn.completion.choices[0].message);
      for (const item of output) if ('call_id' in item) messages.push({ role: 'tool',
        tool_call_id: item.call_id!, content: 'Read-only result ' + item.call_id });
    }
    await call(model(), messages, session);
    const input = bodyOf(2).input as { type?: string }[];
    expect(input.slice(1, 1 + firstOutput.length)).toEqual(firstOutput);
    expect(input.slice(1 + firstOutput.length + 2, -2)).toEqual(secondOutput);
    expect(input.filter(item => item.type === 'function_call_output')).toHaveLength(4);
  });

  it('uses canonical fallback for an incomplete native response', async () => {
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' } }));
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message);
    await call(model(), messages, session);
    expect((bodyOf(1).input as { type?: string }[]).some(item => item.type === 'reasoning')).toBe(false);
  });

  it('invalidates a descendant when a late sibling replaces native input with identical canonical text', async () => {
    const messages = history();
    const racing = prepareResponsesReasoning({ model: model(), apiKey: 'sk-test', messages, ...session }, 'openai-responses');
    const output = nativeOutput();
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message,
      { role: 'tool', tool_call_id: 'call_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', content: 'B' });
    const secondOutput = [{ type: 'reasoning', id: 'rs_child', summary: [], encrypted_content: 'CHILD' },
      { type: 'message', id: 'msg_child', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Done.' }] }];
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output: secondOutput }));
    const second = await call(model(), messages, session);
    messages.push(second.completion.choices[0].message, { role: 'user', content: 'Continue.' });
    const replacement = output.map(item => ({ ...item, id: item.id + '_replacement' }));
    const translated = fromResponse(responseWithToolCall({ output: replacement }) as never, model().name);
    racing.remember(translated.completion, translated.reasoning, replacement as never);
    await call(model(), messages, session);
    const replay = bodyOf(2).input as { id?: string; type?: string; content?: unknown }[];
    expect(replay.slice(1, 1 + replacement.length)).toEqual(replacement);
    expect(replay.some(item => item.id === 'rs_child' || item.id === 'msg_child')).toBe(false);
    expect(replay).toContainEqual({ role: 'assistant', content: 'Done.' });
  });

  it('owns a snapshot of provider output and does not mutate the canonical conversation', async () => {
    const output = nativeOutput();
    const expected = structuredClone(output);
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message);
    const canonical = structuredClone(messages);
    output[0].encrypted_content = 'MUTATED';
    await call(model(), messages, session);
    expect((bodyOf(1).input as unknown[]).slice(1)).toEqual(expected);
    expect(messages).toEqual(canonical);
  });

  it('falls back when one native window exceeds the disposable cache bound', async () => {
    const output = nativeOutput();
    output[0].encrypted_content = 'x'.repeat(1024 * 1024);
    mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
    const messages = history();
    const first = await call(model(), messages, session);
    messages.push(first.completion.choices[0].message);
    await call(model(), messages, session);
    expect(bodyOf(1).input).toEqual(toResponsesInput(messages));
  });

  it('invalidates dependent windows after total cache eviction', async () => {
    const messages = history();
    for (let round = 0; round < 2; round++) {
      const output = [{ type: 'reasoning', id: 'large-' + round, summary: [], encrypted_content: 'x'.repeat(600_000) },
        { type: 'message', id: 'message-' + round, role: 'assistant', phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Round ' + round }] }];
      mockResponsesCreate.mockResolvedValueOnce(responseWithToolCall({ output }));
      const result = await call(model(), messages, session);
      messages.push(result.completion.choices[0].message, { role: 'user', content: 'Continue.' });
    }
    await call(model(), messages, session);
    expect(bodyOf(2).input).toEqual(toResponsesInput(messages));
  });
});

describe('native Responses streaming', () => {
  it.each(['max_output_tokens', 'content_filter'])('retains an incomplete terminal response (%s) without caching native output', async reason => {
    const output = [{ type: 'message', id: 'partial-message', role: 'assistant',
      content: [{ type: 'output_text', text: 'Partial answer' }] }];
    let session: ResponsesSessionState | undefined;
    const scope = { conversationId: 'incomplete-stream', nodeId: 'node' };
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'Check the weather.' }];
    const first = await call(model(), messages, { ...scope,
      onResponsesSessionChange: (state: ResponsesSessionState | undefined) => { session = state; } });
    expect(session?.records.length).toBeGreaterThan(0);
    const before = structuredClone(session);
    messages.push(first.completion.choices[0].message, { role: 'tool', tool_call_id: 'call_abc', content: 'Sunny.' },
      { role: 'user', content: 'Continue.' });
    const changed = jest.fn();
    const delta = jest.fn();
    mockResponsesCreate.mockResolvedValueOnce((async function* () {
      yield { type: 'response.output_text.delta', delta: 'Partial answer' };
      yield { type: 'response.incomplete', response: responseWithToolCall({ status: 'incomplete',
        incomplete_details: { reason }, output }) };
    })());
    const result = await new OpenAiResponsesAdapter().createStreamCompletion({ model: model(), apiKey: 'sk-test',
      messages, temperature: 0, ...scope,
      responsesSession: session, onResponsesSessionChange: changed, onModelDelta: delta });
    expect(result.completion.choices[0].message.content).toBe('Partial answer');
    expect(result.completion.choices[0].finish_reason).toBe(reason === 'max_output_tokens' ? 'length' : 'content_filter');
    expect(result.completion.usage?.completion_tokens).toBe(40);
    expect(delta).toHaveBeenCalledWith(expect.objectContaining({ contentDelta: 'Partial answer' }));
    expect(session).toEqual(before);
    for (const [published] of changed.mock.calls) expect(published).toEqual(before);
  });
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

  it.each([['openai', 'gpt-5.2'], ['openrouter', 'openai/gpt-5.6']])('omits explicit controls for unsupported %s %s', async (provider, name) => {
    await call({ ...model(name), provider } as Model, [{ role: 'user', content: 'hi' }], { promptCacheMode: 'explicit' });
    expect(bodyOf(0)).not.toHaveProperty('prompt_cache_options');
    expect(JSON.stringify(bodyOf(0).input)).not.toContain('prompt_cache_breakpoint');
  });

  it('negotiates unsupported LiteLLM breakpoint controls away together and remembers', async () => {
    const m = { ...model('openai/gpt-5.6'), provider: 'litellm' } as Model;
    mockResponsesCreate.mockRejectedValueOnce(unsupported('input[0].content[0].prompt_cache_breakpoint'));
    await call(m, [{ role: 'user', content: 'hi' }], { promptCacheMode: 'explicit' });
    expect(bodyOf(0)).toHaveProperty('prompt_cache_options', { mode: 'explicit' });
    expect(JSON.stringify(bodyOf(0).input)).toContain('prompt_cache_breakpoint');
    expect(bodyOf(1)).not.toHaveProperty('prompt_cache_options');
    expect(JSON.stringify(bodyOf(1).input)).not.toContain('prompt_cache_breakpoint');
    mockResponsesCreate.mockClear();
    await call(m, [{ role: 'user', content: 'hi' }], { promptCacheMode: 'explicit' });
    expect(mockResponsesCreate).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)).not.toHaveProperty('prompt_cache_options');
  });

  it('marks supported multimodal parts and leaves opaque or unsupported parts unchanged', () => {
    const input = [{ role: 'user', content: [
      { type: 'input_image', image_url: 'https://example.com/fixture.png', detail: 'auto' },
      { type: 'opaque_extension', payload: { nested: true } },
    ] }, { role: 'user', content: [{ type: 'input_audio', data: 'fixture' }] }];
    const marked = withResponsesCacheBreakpoints(input as never) as any[];
    expect(marked[0].content[0]).toEqual({ ...input[0].content[0], prompt_cache_breakpoint: { mode: 'explicit' } });
    expect(marked[0].content[1]).toBe(input[0].content[1]);
    expect(marked[1]).toBe(input[1]);
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
