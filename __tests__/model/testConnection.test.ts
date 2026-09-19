/**
 * Tests for the direct (flow-engine-free) model connectivity test that powers
 * the "Test" button on the Models page.
 *
 * testModelConnection runs the request through the OpenAI SDK client AND through
 * axios, then summarizes. The key behaviour under test is the diagnosis: in
 * particular, distinguishing the keep-alive "Premature close" transport bug
 * (SDK fails, axios succeeds) from genuine provider errors (both fail with the
 * same HTTP status).
 */

// Mock the hardened client factory so we can drive the SDK attempt's outcome.
const sdkCreate = jest.fn();
const responsesCreate = jest.fn();
jest.mock('@/backend/services/model/openaiClient', () => ({
  ...jest.requireActual('@/backend/services/model/openaiClient'),
  createOpenAIClient: jest.fn(() => ({
    chat: { completions: { create: sdkCreate } },
    responses: { create: responsesCreate },
  })),
}));

jest.mock('@/backend/services/model/testToolConnection', () => ({ testModelToolConnection: jest.fn() }));

// Mock axios so we can drive the cross-check attempt's outcome.
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn(), get: jest.fn() },
}));

import axios from 'axios';
import { testModelConnection } from '@/backend/services/model/testConnection';
import { testModelToolConnection } from '@/backend/services/model/testToolConnection';
const toolTest = jest.mocked(testModelToolConnection);

const axiosPost = (axios as unknown as { post: jest.Mock }).post;
const axiosGet = (axios as unknown as { get: jest.Mock }).get;

const okCompletion = { choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 3 } };
const okAxios = { status: 200, data: okCompletion, headers: {} };

const run = () =>
  testModelConnection({ modelName: 'test/model', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x' });

beforeEach(() => {
  sdkCreate.mockReset();
  responsesCreate.mockReset();
  toolTest.mockReset().mockResolvedValue({ ok: true, durationMs: 1, content: 'Tool round-trip passed' });
  axiosPost.mockReset();
  axiosGet.mockReset();
});

describe('testModelConnection', () => {
  it('reports success when both transports reach the provider', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    const result = await run();

    expect(result.ok).toBe(true);
    expect(result.sdk.ok).toBe(true);
    expect(result.axios.ok).toBe(true);
    expect(result.sdk.content).toBe('pong');
    expect(result.diagnosis).toMatch(/both/i);
    expect(result.tool?.ok).toBe(true);
    expect(toolTest).toHaveBeenCalledWith(expect.objectContaining({ name: 'test/model' }), 'sk-x');
  });

  it('reports a failed tool round-trip even when text connectivity works', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);
    toolTest.mockResolvedValue({ ok: false, durationMs: 1, error: { message: 'Missing tool call' } });
    const result = await run();
    expect(result.sdk.ok).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.tool?.error?.message).toBe('Missing tool call');
    expect(result.diagnosis).toMatch(/tool round-trip failed/);
  });

  it.each(['requesty', 'openrouter'] as const)('uses Responses for SDK, axios, and tools on saved %s models', async (provider) => {
    const response = { id: 'response-1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }] };
    responsesCreate.mockResolvedValue(response);
    axiosPost.mockResolvedValue({ status: 200, data: response, headers: {} });
    const baseUrl = provider === 'requesty' ? 'https://router.requesty.ai/v1' : 'https://openrouter.ai/api/v1';
    const result = await testModelConnection({ modelName: 'test/model', provider, adapter: 'openai', baseUrl, apiKey: 'sk-x' });
    expect(result.ok).toBe(true);
    expect(result.sdk.content).toBe('pong');
    expect(result.axios.content).toBe('pong');
    expect(result.adapterRoute).toMatchObject({ adapterId: 'openai-responses', endpoint: '/responses' });
    expect(responsesCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'test/model', input: expect.any(Array), store: false }));
    expect(axiosPost).toHaveBeenCalledWith(`${baseUrl}/responses`, expect.objectContaining({ input: expect.any(Array), store: false }), expect.any(Object));
    expect(sdkCreate).not.toHaveBeenCalled();
    expect(toolTest).toHaveBeenCalledWith(expect.objectContaining({ adapter: 'openai-responses', provider }), 'sk-x');
  });

  it('omits temperature from both OpenAI-compatible test requests', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    await run();

    expect(sdkCreate.mock.calls[0][0]).not.toHaveProperty('temperature');
    expect(axiosPost.mock.calls[0][1]).not.toHaveProperty('temperature');
  });

  it('flags the keep-alive / Premature close bug when the SDK fails but axios succeeds', async () => {
    sdkCreate.mockRejectedValue(new Error('Premature close'));
    axiosPost.mockResolvedValue(okAxios);

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.sdk.ok).toBe(false);
    expect(result.axios.ok).toBe(true);
    expect(result.diagnosis).toMatch(/premature close/i);
    expect(result.diagnosis).toMatch(/keep-alive|connection-reuse/i);
    expect(result.tool).toMatchObject({ ok: false, skipped: true });
    expect(toolTest).not.toHaveBeenCalled();
  });

  it('detects the OpenRouter 200-with-error-body case', async () => {
    sdkCreate.mockResolvedValue({ error: { message: 'Provider returned error', code: 429 } });
    axiosPost.mockResolvedValue(okAxios);

    const result = await run();

    expect(result.sdk.ok).toBe(false);
    expect(result.sdk.error?.message).toMatch(/provider returned error/i);
  });

  it('summarizes a shared 429 rate limit as a provider limit', async () => {
    sdkCreate.mockRejectedValue(new Error('connection blip'));
    axiosPost.mockResolvedValue({
      status: 429,
      data: { error: { message: 'rate limited', code: 429 } },
      headers: { 'retry-after': '30' },
    });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.diagnosis).toMatch(/429|rate-limited|rate limit/i);
  });

  it('summarizes a shared auth failure', async () => {
    sdkCreate.mockRejectedValue(new Error('connection blip'));
    axiosPost.mockResolvedValue({
      status: 401,
      data: { error: { message: 'invalid key' } },
      headers: {},
    });

    const result = await run();

    expect(result.ok).toBe(false);
    expect(result.diagnosis).toMatch(/auth|key/i);
  });

  it('validates OpenRouter video models without starting a billable generation', async () => {
    axiosGet
      .mockResolvedValueOnce({ status: 200, data: { data: { label: 'test' } }, headers: {} })
      .mockResolvedValueOnce({
        status: 200,
        data: { data: [{ id: 'kwaivgi/kling-v3.0-std' }] },
        headers: {},
      });

    const result = await testModelConnection({
      modelName: 'kwaivgi/kling-v3.0-std',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-x',
      provider: 'openrouter',
      adapter: 'openai',
      model: {
        id: 'kling',
        name: 'kwaivgi/kling-v3.0-std',
        ApiKey: 'encrypted',
        baseUrl: 'https://openrouter.ai/api/v1',
        provider: 'openrouter',
        adapter: 'openai',
        outputModalities: ['video'],
      },
    });

    expect(result.ok).toBe(true);
    expect(axiosGet).toHaveBeenNthCalledWith(
      1,
      'https://openrouter.ai/api/v1/key',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-x' }),
      }),
    );
    expect(axiosGet).toHaveBeenNthCalledWith(
      2,
      'https://openrouter.ai/api/v1/videos/models',
      expect.any(Object),
    );
    expect(sdkCreate).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
    expect(result.diagnosis).toMatch(/no billable generation/i);
    expect(result.tool).toMatchObject({ ok: false, skipped: true });
    expect(toolTest).not.toHaveBeenCalled();
  });

  it('reports an invalid OpenRouter media API key without attempting model generation', async () => {
    axiosGet.mockResolvedValueOnce({
      status: 401,
      data: { error: { message: 'Invalid API key' } },
      headers: {},
    });

    const result = await testModelConnection({
      modelName: 'x-ai/grok-imagine-video',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'bad-key',
      provider: 'openrouter',
      adapter: 'openai',
      model: {
        id: 'grok-video',
        name: 'x-ai/grok-imagine-video',
        ApiKey: 'encrypted',
        provider: 'openrouter',
        adapter: 'openai',
        outputModalities: ['video'],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.sdk.status).toBe(401);
    expect(result.diagnosis).toMatch(/invalid api key/i);
    expect(axiosGet).toHaveBeenCalledTimes(1);
    expect(sdkCreate).not.toHaveBeenCalled();
    expect(axiosPost).not.toHaveBeenCalled();
  });
});
