import OpenAI from 'openai';
import {
  buildProviderToolNameTranslation,
  translateCompletionFromProvider,
  translateMessagesForProvider,
  translateToolsForProvider,
} from '@/backend/services/model/adapters/providerToolNames';

const tool = (name: string): OpenAI.ChatCompletionFunctionTool => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object' } },
});

describe('OpenAI-compatible MCP tool-name translation', () => {
  it('exposes a readable server_tool name and restores the canonical call name', () => {
    const tools = [tool('mcp_search_1y5m6cu')];
    const translation = buildProviderToolNameTranslation(tools, {
      mcp_search_1y5m6cu: { server: 'filesystem', tool: 'search' },
    });

    expect(translateToolsForProvider(tools, translation)?.[0].function.name)
      .toBe('filesystem_search');

    const completion = translateCompletionFromProvider({
      id: 'c1', object: 'chat.completion', created: 1, model: 'test',
      choices: [{
        index: 0, finish_reason: 'tool_calls', logprobs: null,
        message: {
          role: 'assistant', content: null, refusal: null,
          tool_calls: [{
            id: 'call1', type: 'function',
            function: { name: 'filesystem_search', arguments: '{}' },
          }],
        },
      }],
    }, translation);
    expect(completion.choices[0].message.tool_calls?.[0]).toMatchObject({
      function: { name: 'mcp_search_1y5m6cu' },
    });
  });

  it('uses hashes only for collisions and overlength names', () => {
    const tools = [tool('mcp_one'), tool('mcp_two'), tool('mcp_long')];
    const translation = buildProviderToolNameTranslation(tools, {
      mcp_one: { server: 'a_b', tool: 'c' },
      mcp_two: { server: 'a', tool: 'b_c' },
      mcp_long: { server: 'filesystem', tool: 'x'.repeat(80) },
    });
    const names = translateToolsForProvider(tools, translation)!.map(t => t.function.name);

    expect(names[0]).toMatch(/^a_b_c_[0-9a-z]+$/);
    expect(names[1]).toMatch(/^a_b_c_[0-9a-z]+$/);
    expect(names[0]).not.toBe(names[1]);
    expect(names[2]).toMatch(/^filesystem_x+_[0-9a-z]+$/);
    expect(names.every(name => name.length <= 64)).toBe(true);
  });

  it('avoids collisions with non-MCP tools and translates prior calls', () => {
    const tools = [tool('read_resource'), tool('mcp_read')];
    const translation = buildProviderToolNameTranslation(tools, {
      mcp_read: { server: 'read', tool: 'resource' },
    });
    expect(translateToolsForProvider(tools, translation)?.map(t => t.function.name)).toEqual([
      'read_resource',
      expect.stringMatching(/^read_resource_[0-9a-z]+$/),
    ]);

    const messages = translateMessagesForProvider([{
      role: 'assistant', content: null,
      tool_calls: [{
        id: 'call1', type: 'function',
        function: { name: 'mcp_read', arguments: '{}' },
      }],
    }], translation);
    expect((messages[0] as OpenAI.ChatCompletionAssistantMessageParam).tool_calls?.[0])
      .toMatchObject({ function: { name: expect.stringMatching(/^read_resource_[0-9a-z]+$/) } });
  });
});
