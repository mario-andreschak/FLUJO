import OpenAI from 'openai';

const mockCreate = jest.fn();

jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: () => ({
    chat: { completions: { create: (...args: unknown[]) => mockCreate(...args) } },
  }),
  getProviderDefaultHeaders: () => undefined,
}));

jest.mock('@/backend/utils/transientRetry', () => ({
  withTransientRetry: (task: () => Promise<unknown>) => task(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import type { Model } from '@/shared/types/model';

const canonicalName = 'mcp_search_1y5m6cu';
const providerName = 'filesystem_search';
const tools: OpenAI.ChatCompletionFunctionTool[] = [{
  type: 'function',
  function: {
    name: canonicalName,
    description: 'Search files',
    parameters: { type: 'object', properties: {} },
  },
}];
const model = {
  id: 'ollama-model',
  name: 'qwen',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  ApiKey: 'ollama',
} as Model;

describe('OpenAI-compatible provider tool names', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({
      id: 'completion',
      object: 'chat.completion',
      created: 1,
      model: 'qwen',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call1',
            type: 'function',
            function: { name: providerName, arguments: '{}' },
          }],
        },
      }],
    });
  });

  it('sends readable aliases to Ollama and restores canonical returned calls', async () => {
    const result = await new OpenAiAdapter().createCompletion({
      model,
      apiKey: 'ollama',
      temperature: 0,
      messages: [{
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'prior',
          type: 'function',
          function: { name: canonicalName, arguments: '{}' },
        }],
      }],
      tools,
      toolNameMap: {
        [canonicalName]: { server: 'filesystem', tool: 'search' },
      },
    });

    const body = mockCreate.mock.calls[0][0] as {
      tools: OpenAI.ChatCompletionFunctionTool[];
      messages: OpenAI.ChatCompletionMessageParam[];
    };
    expect(body.tools[0].function.name).toBe(providerName);
    expect((body.messages[0] as OpenAI.ChatCompletionAssistantMessageParam).tool_calls?.[0])
      .toMatchObject({ function: { name: providerName } });
    expect(result.completion.choices[0].message.tool_calls?.[0])
      .toMatchObject({ function: { name: canonicalName } });
  });
});
