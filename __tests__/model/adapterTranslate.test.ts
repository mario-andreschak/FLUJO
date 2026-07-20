import OpenAI from 'openai';
import { toAnthropicMessages, toAnthropicTools } from '@/backend/services/model/adapters/anthropicAdapter';
import { toGeminiContents, toGeminiTools } from '@/backend/services/model/adapters/geminiAdapter';
import { buildUserMessage } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';

// A single shared logger mock so tests can assert `log.warn` was emitted when a
// remote image fetch fails. The factory builds the object internally (no outer
// reference) to avoid a TDZ crash from jest.mock hoisting; createLogger always
// returns the same singleton, which we then grab for our assertions.
jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
const mockLog = (jest.requireMock('@/utils/logger') as { createLogger: () => Record<string, jest.Mock> }).createLogger();

// A 1x1 PNG as a base64 data URL — the shape a pasted screenshot arrives in.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A user turn carrying both text and an image, in OpenAI multipart form.
const MULTIMODAL_CONVERSATION: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are helpful.' },
  {
    role: 'user',
    content: [
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
    ],
  },
];

// A representative tool-using conversation in OpenAI wire format:
// system + user, an assistant turn with a tool_call, then the tool result.
const CONVERSATION: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'Weather in Berlin?' },
  {
    role: 'assistant',
    content: 'Let me check.',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'mcp_get_weather_abc', arguments: '{"city":"Berlin"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":18}' },
];

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'mcp_get_weather_abc',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

describe('anthropic translation', () => {
  it('hoists system, maps tool_calls to tool_use, and tool results to tool_result', () => {
    const { system, messages } = toAnthropicMessages(CONVERSATION);
    expect(system).toBe('You are helpful.');

    // user, assistant(text+tool_use), user(tool_result)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);

    const assistant = messages[1];
    const blocks = assistant.content as Array<{ type: string; id?: string; name?: string }>;
    expect(blocks.some(b => b.type === 'text')).toBe(true);
    const toolUse = blocks.find(b => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ id: 'call_1', name: 'mcp_get_weather_abc' });

    const toolResult = messages[2].content as Array<{ type: string; tool_use_id?: string }>;
    expect(toolResult[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });

  it('maps a multipart user turn to text + base64 image blocks', () => {
    const { messages } = toAnthropicMessages(MULTIMODAL_CONVERSATION);
    expect(messages).toHaveLength(1);
    const blocks = messages[0].content as Array<{ type: string; text?: string; source?: any }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'What is in this image?' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    // The base64 payload is forwarded without the data-URL prefix.
    expect((blocks[1].source as any).data).toBe(PNG_DATA_URL.split(',')[1]);
  });

  it('converts tools to Anthropic input_schema shape', () => {
    const tools = toAnthropicTools(TOOLS)!;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'mcp_get_weather_abc', description: 'Get weather' });
    expect(tools[0].input_schema).toMatchObject({ type: 'object' });
  });
});

describe('gemini translation', () => {
  it('hoists system, uses model role, and maps tool_calls/results to function parts', async () => {
    const { systemInstruction, contents } = await toGeminiContents(CONVERSATION);
    expect(systemInstruction).toBe('You are helpful.');
    expect(contents.map(c => c.role)).toEqual(['user', 'model', 'user']);

    const modelParts = contents[1].parts!;
    const fnCall = modelParts.find(p => 'functionCall' in p) as { functionCall?: { name?: string; args?: unknown } };
    expect(fnCall.functionCall?.name).toBe('mcp_get_weather_abc');
    expect(fnCall.functionCall?.args).toEqual({ city: 'Berlin' });

    // Gemini keys the response by function NAME (resolved from the prior call id).
    const fnResponseParts = contents[2].parts!;
    const fnResp = fnResponseParts.find(p => 'functionResponse' in p) as {
      functionResponse?: { name?: string; response?: unknown };
    };
    expect(fnResp.functionResponse?.name).toBe('mcp_get_weather_abc');
    expect(fnResp.functionResponse?.response).toEqual({ tempC: 18 });
  });

  it('converts tools to function declarations with a JSON-schema passthrough', () => {
    const decls = toGeminiTools(TOOLS)!;
    expect(decls).toHaveLength(1);
    expect(decls[0]).toMatchObject({ name: 'mcp_get_weather_abc', description: 'Get weather' });
    expect((decls[0] as { parametersJsonSchema?: unknown }).parametersJsonSchema).toMatchObject({
      type: 'object',
    });
  });

  it('maps a multipart user turn to a text part + inlineData image part', async () => {
    const { contents } = await toGeminiContents(MULTIMODAL_CONVERSATION);
    expect(contents).toHaveLength(1);
    const parts = contents[0].parts!;
    expect(parts[0]).toMatchObject({ text: 'What is in this image?' });
    expect((parts[1] as any).inlineData).toMatchObject({
      mimeType: 'image/png',
      data: PNG_DATA_URL.split(',')[1],
    });
  });

  describe('remote (http/https) image URLs (issue #172)', () => {
    // A user turn carrying text plus a REMOTE image URL (not a data: URL).
    const REMOTE_IMAGE_CONVERSATION: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
        ],
      },
    ];

    // Build a minimal Response-like object for the mocked global fetch.
    function fakeResponse(opts: {
      ok?: boolean;
      status?: number;
      contentType?: string;
      body?: Buffer;
    }): Response {
      const { ok = true, status = 200, contentType = 'image/png', body = Buffer.from([1, 2, 3]) } = opts;
      return {
        ok,
        status,
        headers: {
          get: (k: string) => {
            const key = k.toLowerCase();
            if (key === 'content-type') return contentType;
            if (key === 'content-length') return String(body.length);
            return null;
          },
        },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    }

    beforeEach(() => {
      mockLog.warn.mockClear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('fetches a remote image URL and inlines it as base64', async () => {
      const body = Buffer.from('hello-image-bytes');
      const spy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(fakeResponse({ contentType: 'image/png', body }));

      const { contents } = await toGeminiContents(REMOTE_IMAGE_CONVERSATION);

      expect(spy).toHaveBeenCalledWith(
        'https://example.com/cat.png',
        expect.objectContaining({ cache: 'no-store' })
      );
      const parts = contents[0].parts!;
      expect(parts[0]).toMatchObject({ text: 'Describe this' });
      expect((parts[1] as any).inlineData).toMatchObject({
        mimeType: 'image/png',
        data: body.toString('base64'),
      });
    });

    it('normalizes image/jpg content-type to image/jpeg', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(fakeResponse({ contentType: 'image/jpg', body: Buffer.from('jpg') }));
      const { contents } = await toGeminiContents(REMOTE_IMAGE_CONVERSATION);
      expect((contents[0].parts![1] as any).inlineData.mimeType).toBe('image/jpeg');
    });

    it('skips a remote image on fetch failure but keeps the text and warns', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network down'));

      const { contents } = await toGeminiContents(REMOTE_IMAGE_CONVERSATION);

      const parts = contents[0].parts!;
      expect(parts).toHaveLength(1);
      expect(parts[0]).toMatchObject({ text: 'Describe this' });
      expect(parts.some(p => 'inlineData' in p)).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });

    it('skips a non-image content-type response and warns', async () => {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(fakeResponse({ contentType: 'text/html', body: Buffer.from('<html>') }));

      const { contents } = await toGeminiContents(REMOTE_IMAGE_CONVERSATION);

      const parts = contents[0].parts!;
      expect(parts).toHaveLength(1);
      expect(parts.some(p => 'inlineData' in p)).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });

    it('skips an oversized image (Content-Length over the cap) and warns', async () => {
      const spy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        status: 200,
        headers: {
          get: (k: string) => {
            const key = k.toLowerCase();
            if (key === 'content-type') return 'image/png';
            if (key === 'content-length') return String(11 * 1024 * 1024); // 11 MB > 10 MB cap
            return null;
          },
        },
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response);

      const { contents } = await toGeminiContents(REMOTE_IMAGE_CONVERSATION);

      expect(spy).toHaveBeenCalled();
      const parts = contents[0].parts!;
      expect(parts.some(p => 'inlineData' in p)).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });

    it('blocks a private/loopback host without fetching and warns', async () => {
      const spy = jest.spyOn(global, 'fetch');
      const convo: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'ssrf?' },
            { type: 'image_url', image_url: { url: 'http://169.254.169.254/latest/meta-data' } },
          ],
        },
      ];

      const { contents } = await toGeminiContents(convo);

      expect(spy).not.toHaveBeenCalled();
      expect(contents[0].parts!.some(p => 'inlineData' in p)).toBe(false);
      expect(mockLog.warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe('claude subscription buildUserMessage', () => {
  it('renders prior tool calls AND results as text (issue #160)', () => {
    const { systemPrompt, content } = buildUserMessage(CONVERSATION);
    expect(systemPrompt).toBe('You are helpful.');
    expect(typeof content).toBe('string');
    const text = content as string;
    // Plain turns still render as before.
    expect(text).toContain('Human: Weather in Berlin?');
    expect(text).toContain('Assistant: Let me check.');
    // The tool CALL and its RESULT are now rendered (previously dropped).
    expect(text).toContain('Assistant [tool call] mcp_get_weather_abc({"city":"Berlin"})');
    expect(text).toContain('Tool result [mcp_get_weather_abc]: {"tempC":18}');
  });

  it('renders an assistant tool-call turn that carries no text (content: \'\')', () => {
    const convo: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' },
    ];
    const { content } = buildUserMessage(convo);
    const text = content as string;
    expect(text).toContain('Assistant [tool call] list_files({})');
    expect(text).toContain('Tool result [list_files]: a.txt\nb.txt');
  });

  it('truncates oversized tool results and args with a marker', () => {
    const bigArgs = JSON.stringify({ content: 'A'.repeat(5000) });
    const bigResult = 'R'.repeat(9000);
    const convo: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write_file', arguments: bigArgs } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: bigResult },
    ];
    const { content } = buildUserMessage(convo);
    const text = content as string;
    // Args truncated at 2000, result at 4000; both carry the byte marker.
    // (bigResult is exactly 9000 chars → 9000-4000 = 5000 truncated.)
    expect(text).toMatch(/\[truncated 5000 chars\]/);
    // The args payload is truncated too (its exact count depends on JSON overhead).
    expect(text).toMatch(/write_file\(\{"content":"A+…\[truncated \d+ chars\]/);
    // The whole oversized payloads are not present verbatim.
    expect(text).not.toContain('R'.repeat(9000));
    expect(text).not.toContain('A'.repeat(5000));
  });

  it('is byte-identical to a raw single user message for a tool-free single turn', () => {
    const convo: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'just a question' },
    ];
    const { systemPrompt, content } = buildUserMessage(convo);
    expect(systemPrompt).toBe('sys');
    // No `Human:` prefix for the single-turn tool-free case (prefix-cache stability).
    expect(content).toBe('just a question');
  });

  it('emits text + image content blocks for a multimodal turn', () => {
    const { systemPrompt, content } = buildUserMessage(MULTIMODAL_CONVERSATION);
    expect(systemPrompt).toBe('You are helpful.');
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string; text?: string; source?: any }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'What is in this image?' });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG_DATA_URL.split(',')[1] },
    });
  });
});
