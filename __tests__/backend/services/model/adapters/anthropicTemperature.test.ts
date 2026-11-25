import { AnthropicAdapter, anthropicClientOptions } from '@/backend/services/model/adapters/anthropicAdapter';
import { Model } from '@/shared/types/model';
import OpenAI from 'openai';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const retrieve = jest.fn();
  const stream = jest.fn();
  const Anthropic = jest.fn().mockImplementation(() => ({
    messages: { create, stream },
    models: { retrieve },
  }));
  return { __esModule: true, default: Anthropic, __create: create, __retrieve: retrieve, __stream: stream };
});

const sdk = jest.requireMock('@anthropic-ai/sdk') as {
  default: jest.Mock; __create: jest.Mock; __retrieve: jest.Mock; __stream: jest.Mock;
};

const GOOD_RESP = {
  id: 'a', model: 'test', content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
};
const MSGS: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];
// Models that used to accept a temperature on API version 2023-06-01, and ones
// that never did. On 2026-10-21 every one of them refuses it.
const MODEL_NAMES = ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-8', 'claude-opus-5-5'];

describe('Anthropic Messages requests never carry a temperature (API 2026-10-21)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sdk.__create.mockResolvedValue(GOOD_RESP);
    sdk.__stream.mockReturnValue({ finalMessage: jest.fn().mockResolvedValue(GOOD_RESP) });
  });

  test.each(MODEL_NAMES)('%s: a caller temperature is dropped on both request paths', async name => {
    const model = { id: 'm', name, ApiKey: 'k', provider: 'anthropic', adapter: 'anthropic' } as Model;
    await new AnthropicAdapter().createCompletion({ model, apiKey: 'k', messages: MSGS, temperature: 0.2 });
    await new AnthropicAdapter().createStreamCompletion({ model, apiKey: 'k', messages: MSGS, temperature: 0.2 });
    for (const body of [sdk.__create.mock.calls[0][0], sdk.__stream.mock.calls[0][0]]) {
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
    }
  });

  test('no longer asks the Models API whether a model takes a temperature', async () => {
    const model = { id: 'm', name: 'claude-sonnet-4-6', ApiKey: 'k' } as Model;
    await new AnthropicAdapter().createCompletion({ model, apiKey: 'k', messages: MSGS, temperature: 0.7 });
    expect(sdk.__retrieve).not.toHaveBeenCalled();
    expect(sdk.__create).toHaveBeenCalledTimes(1);
  });
});

describe('anthropicClientOptions: one credential per client (SDK 1.x)', () => {
  test('an API key goes out in X-Api-Key, never as a bearer token', () => {
    expect(anthropicClientOptions({ provider: 'anthropic', apiKey: 'key-1', baseUrl: 'https://gateway.example' })).toEqual({
      apiKey: 'key-1',
      defaultHeaders: { 'X-Api-Key': 'key-1', Authorization: null },
      baseURL: 'https://gateway.example',
    });
  });

  test('OpenRouter gets its key as the only credential, a bearer token', () => {
    const options = anthropicClientOptions({ provider: 'openrouter', apiKey: 'or-key' });
    expect(options).toEqual({ authToken: 'or-key' });
    expect(options).not.toHaveProperty('apiKey');
  });
});
