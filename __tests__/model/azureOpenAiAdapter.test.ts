import type OpenAI from 'openai';
import { AzureOpenAiAdapter } from '@/backend/services/model/adapters/azureOpenAiAdapter';
import type { Model } from '@/shared/types/model';

const mockCreateAzureOpenAIClient = jest.fn();

jest.mock('@/backend/services/model/openaiClient', () => {
  const actual = jest.requireActual('@/backend/services/model/openaiClient');
  return {
    ...actual,
    createAzureOpenAIClient: (...args: unknown[]) => mockCreateAzureOpenAIClient(...args),
  };
});

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

describe('AzureOpenAiAdapter', () => {
  afterEach(() => jest.clearAllMocks());

  it('constructs a deployment-aware Azure client and reuses Chat Completions normalization', async () => {
    const completion = {
      id: 'azure-completion',
      object: 'chat.completion',
      created: 1,
      model: 'production-gpt',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: { role: 'assistant', content: 'hello', refusal: null },
      }],
    } as OpenAI.Chat.Completions.ChatCompletion;
    const create = jest.fn().mockResolvedValue(completion);
    mockCreateAzureOpenAIClient.mockReturnValue({
      chat: { completions: { create } },
    });
    const model: Model = {
      id: 'azure-model',
      name: 'production-gpt',
      displayName: 'Production GPT',
      ApiKey: 'stored-encrypted-key',
      provider: 'azure',
      adapter: 'azure',
      baseUrl: 'https://team.openai.azure.com',
      azureApiVersion: '2024-10-21',
    };
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hello' }];

    const result = await new AzureOpenAiAdapter().createCompletion({
      model,
      apiKey: 'decrypted-key',
      messages,
      temperature: 0.2,
      maxTokens: 123,
    });

    expect(mockCreateAzureOpenAIClient).toHaveBeenCalledWith({
      apiKey: 'decrypted-key',
      endpoint: 'https://team.openai.azure.com',
      deployment: 'production-gpt',
      apiVersion: '2024-10-21',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'production-gpt',
      messages,
      temperature: 0.2,
      max_tokens: 123,
    }), undefined);
    expect(result.completion).toBe(completion);
  });
});
