/**
 * Requesty provider (issue 88).
 *
 * Requesty is an OpenAI-compatible router (baseUrl https://router.requesty.ai/v1)
 * driven by the standard OpenAiAdapter, plus two attribution headers it asks
 * clients to send: HTTP-Referer and X-Title.
 *
 * Fallback/routing policies are NOT a separate request parameter: a policy is
 * addressed exactly like a model, by setting the technical model name to
 * `policy/<policy-name>`. The router then applies that policy's fallback chain.
 * The tests below pin that pass-through behaviour so a policy-named model keeps
 * working end-to-end.
 */
import { OpenAiAdapter } from '@/backend/services/model/adapters/openaiAdapter';
import { getProviderDefaultHeaders } from '@/backend/services/model/openaiClient';
import type { Model } from '@/shared/types/model';

// Capture createOpenAIClient calls made by the adapter and return a stub client.
const mockCreateCalls: any[] = [];
const mockCompletionCalls: any[] = [];
jest.mock('@/backend/services/model/openaiClient', () => {
  const actual = jest.requireActual('@/backend/services/model/openaiClient');
  return {
    ...actual,
    createOpenAIClient: jest.fn((opts: any) => {
      mockCreateCalls.push(opts);
      return {
        chat: {
          completions: {
            create: jest.fn(async (params: any) => {
              mockCompletionCalls.push(params);
              return {
                choices: [{ message: { role: 'assistant', content: 'ok' } }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              };
            }),
          },
        },
      };
    }),
  };
});

const requestyModel = (name: string): Model =>
  ({
    id: 'test-requesty',
    name,
    displayName: 'Requesty test',
    provider: 'requesty',
    adapter: 'openai',
    baseUrl: 'https://router.requesty.ai/v1',
    ApiKey: 'k',
    temperature: '0.0',
  } as Model);

beforeEach(() => {
  mockCreateCalls.length = 0;
  mockCompletionCalls.length = 0;
});

describe('getProviderDefaultHeaders', () => {
  it('returns the Requesty attribution headers for provider "requesty"', () => {
    expect(getProviderDefaultHeaders('requesty')).toEqual({
      'HTTP-Referer': 'https://flujo.com.co',
      'X-Title': 'FLUJO',
    });
  });

  it('returns the same attribution headers for provider "openrouter" (issue 136)', () => {
    expect(getProviderDefaultHeaders('openrouter')).toEqual({
      'HTTP-Referer': 'https://flujo.com.co',
      'X-Title': 'FLUJO',
    });
  });

  it('returns undefined for every other provider (wire behaviour unchanged)', () => {
    for (const p of ['openai', 'ollama', 'xai', 'litellm', undefined]) {
      expect(getProviderDefaultHeaders(p)).toBeUndefined();
    }
  });
});

describe('OpenAiAdapter with a Requesty model', () => {
  it('builds the client with baseUrl + attribution headers', async () => {
    const adapter = new OpenAiAdapter();
    await adapter.createCompletion({
      model: requestyModel('nvidia/nemotron-3-ultra-550b-a55b'),
      apiKey: 'rqsty-sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    expect(mockCreateCalls).toHaveLength(1);
    expect(mockCreateCalls[0]).toMatchObject({
      apiKey: 'rqsty-sk-test',
      baseURL: 'https://router.requesty.ai/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://flujo.com.co',
        'X-Title': 'FLUJO',
      },
    });
  });

  it('attaches attribution headers for an OpenRouter model (issue 136)', async () => {
    const adapter = new OpenAiAdapter();
    await adapter.createCompletion({
      model: {
        ...requestyModel('anthropic/claude-3.5-sonnet'),
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      } as Model,
      apiKey: 'or-sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    expect(mockCreateCalls).toHaveLength(1);
    expect(mockCreateCalls[0]).toMatchObject({
      apiKey: 'or-sk-test',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://flujo.com.co',
        'X-Title': 'FLUJO',
      },
    });
  });

  it('does not attach attribution headers for non-attribution providers', async () => {
    const adapter = new OpenAiAdapter();
    await adapter.createCompletion({
      model: { ...requestyModel('gpt-4o'), provider: 'openai', baseUrl: 'https://api.openai.com/v1' } as Model,
      apiKey: 'sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    expect(mockCreateCalls).toHaveLength(1);
    expect(mockCreateCalls[0].defaultHeaders).toBeUndefined();
  });

  it('passes a fallback policy straight through as the model param (policy/<name>)', async () => {
    // A Requesty routing policy is used by naming it as the model — no extra
    // request field exists. FLUJO must not rewrite or validate it away.
    const adapter = new OpenAiAdapter();
    await adapter.createCompletion({
      model: requestyModel('policy/rate-limit-fallback'),
      apiKey: 'rqsty-sk-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    });

    expect(mockCompletionCalls).toHaveLength(1);
    expect(mockCompletionCalls[0].model).toBe('policy/rate-limit-fallback');
  });
});
