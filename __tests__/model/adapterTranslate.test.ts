import OpenAI from 'openai';
import { toAnthropicMessages, toAnthropicTools } from '@/backend/services/model/adapters/anthropicAdapter';
import { toGeminiContents, toGeminiTools } from '@/backend/services/model/adapters/geminiAdapter';

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

  it('converts tools to Anthropic input_schema shape', () => {
    const tools = toAnthropicTools(TOOLS)!;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'mcp_get_weather_abc', description: 'Get weather' });
    expect(tools[0].input_schema).toMatchObject({ type: 'object' });
  });
});

describe('gemini translation', () => {
  it('hoists system, uses model role, and maps tool_calls/results to function parts', () => {
    const { systemInstruction, contents } = toGeminiContents(CONVERSATION);
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
});
