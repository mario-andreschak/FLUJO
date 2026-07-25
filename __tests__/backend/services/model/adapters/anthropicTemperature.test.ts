import { AnthropicAdapter, anthropicModelSupportsTemperature }
  from '@/backend/services/model/adapters/anthropicAdapter';
import { Model } from '@/shared/types/model';
import OpenAI from 'openai';

jest.mock('@/utils/logger', () => {
  const log = { verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { createLogger: () => log };
});
const mockLog = (jest.requireMock('@/utils/logger') as any).createLogger();

jest.mock('@anthropic-ai/sdk', () => {
  const create = jest.fn();
  const BadRequestError = class extends Error {
    status = 400;
    constructor(msg: string) { super(msg); }
  };
  const Anthropic = jest.fn().mockImplementation(() => ({ messages: { create } }));
  (Anthropic as any).BadRequestError = BadRequestError;
  return { __esModule: true, default: Anthropic, __create: create };
});

const anthropicCreate = (jest.requireMock('@anthropic-ai/sdk') as any).__create;

const GOOD_RESP = {
  id: 'a', model: 'test', content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
};
const BASE_MODEL: Model = { id: 'm', name: 'claude-3-5-sonnet-20241022', ApiKey: 'k' } as Model;
const NO_TEMP_MODEL: Model = { ...BASE_MODEL, name: 'claude-opus-4-7-20260501' };
const MSGS: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'hi' }];

describe('anthropicModelSupportsTemperature', () => {
  test('returns false for known no-temperature models', () => {
    expect(anthropicModelSupportsTemperature('claude-opus-4-7')).toBe(false);
    expect(anthropicModelSupportsTemperature('claude-opus-4-7-20260401')).toBe(false);
    expect(anthropicModelSupportsTemperature('claude-opus-4-8')).toBe(false);
    expect(anthropicModelSupportsTemperature('claude-fable-5')).toBe(false);
    expect(anthropicModelSupportsTemperature('claude-sonnet-5')).toBe(false);
  });
  test('returns true for standard models', () => {
    expect(anthropicModelSupportsTemperature('claude-3-5-sonnet-20241022')).toBe(true);
    expect(anthropicModelSupportsTemperature('claude-opus-4-6')).toBe(true);
  });
});

describe('AnthropicAdapter temperature behaviour', () => {
  beforeEach(() => { jest.clearAllMocks(); anthropicCreate.mockResolvedValue(GOOD_RESP); });

  test('includes temperature for standard models', async () => {
    await new AnthropicAdapter().createCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicCreate.mock.calls[0][0]).toHaveProperty('temperature', 0.7);
  });

  test('omits temperature for known no-temp models', async () => {
    await new AnthropicAdapter().createCompletion({
      model: NO_TEMP_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });
    expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  test('retries without temperature when Anthropic returns 400 "deprecated" error', async () => {
    const Anthropic = jest.requireMock('@anthropic-ai/sdk').default;
    const err = new Anthropic.BadRequestError('`temperature` is deprecated for this model.');
    anthropicCreate.mockRejectedValueOnce(err).mockResolvedValueOnce(GOOD_RESP);

    // Use a standard model (not on denylist) so temperature IS included on first call.
    const result = await new AnthropicAdapter().createCompletion({
      model: BASE_MODEL, apiKey: 'k', messages: MSGS, temperature: 0.7,
    });

    expect(anthropicCreate).toHaveBeenCalledTimes(2);
    // First call included temperature
    expect(anthropicCreate.mock.calls[0][0]).toHaveProperty('temperature');
    // Second call omitted it
    expect(anthropicCreate.mock.calls[1][0]).not.toHaveProperty('temperature');
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(result.completion).toBeDefined();
  });
});
