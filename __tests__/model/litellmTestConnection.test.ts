/**
 * Tests for testModelConnection() with a LiteLLM provider.
 *
 * LiteLLM uses adapter:'openai', so the connection test exercises the
 * SDK+axios cross-check path (not the native adapter path). We verify that
 * LiteLLM-specific scenarios are diagnosed correctly.
 */

// Mock the hardened client factory.
const sdkCreate = jest.fn();
jest.mock('@/backend/services/model/openaiClient', () => ({
  createOpenAIClient: jest.fn(() => ({
    chat: { completions: { create: sdkCreate } },
  })),
}));

// Mock axios.
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

import axios from 'axios';
import { testModelConnection } from '@/backend/services/model/testConnection';

const axiosPost = (axios as unknown as { post: jest.Mock }).post;

const okCompletion = { choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 5 } };
const okAxios = { status: 200, data: okCompletion, headers: {} };

const litellmParams = {
  modelName: 'azure/gpt-4o',
  baseUrl: 'http://localhost:4000/v1',
  apiKey: 'sk-litellm-master-key',
  provider: 'litellm',
  adapter: 'openai' as const,
};

beforeEach(() => {
  sdkCreate.mockReset();
  axiosPost.mockReset();
});

describe('testModelConnection (litellm)', () => {
  it('reports success when both SDK and axios reach the LiteLLM proxy', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    const result = await testModelConnection(litellmParams);

    expect(result.ok).toBe(true);
    expect(result.sdk.ok).toBe(true);
    expect(result.axios.ok).toBe(true);
    expect(result.sdk.content).toBe('pong');
    expect(result.provider).toBe('litellm');
    expect(result.diagnosis).toMatch(/both/i);
  });

  it('sends the request to the LiteLLM proxy base URL', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    await testModelConnection(litellmParams);

    // The axios cross-check should hit {baseUrl}/chat/completions.
    const calledUrl = axiosPost.mock.calls[0][0];
    expect(calledUrl).toBe('http://localhost:4000/v1/chat/completions');
  });

  it('passes Bearer auth with the LiteLLM master/virtual key', async () => {
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    await testModelConnection(litellmParams);

    const axiosHeaders = axiosPost.mock.calls[0][2]?.headers;
    expect(axiosHeaders?.Authorization).toBe('Bearer sk-litellm-master-key');
  });

  it('diagnoses auth failure when the LiteLLM key is invalid', async () => {
    sdkCreate.mockRejectedValue(new Error('auth error'));
    axiosPost.mockResolvedValue({
      status: 401,
      data: { error: { message: 'invalid api key', code: 401 } },
      headers: {},
    });

    const result = await testModelConnection(litellmParams);

    expect(result.ok).toBe(false);
    expect(result.diagnosis).toMatch(/auth|key/i);
  });

  it('diagnoses connection failure when the proxy is down', async () => {
    sdkCreate.mockRejectedValue(new Error('ECONNREFUSED'));
    axiosPost.mockRejectedValue(
      Object.assign(new Error('ECONNREFUSED'), {
        response: undefined,
        code: 'ECONNREFUSED',
      }),
    );

    const result = await testModelConnection(litellmParams);

    expect(result.ok).toBe(false);
    expect(result.sdk.ok).toBe(false);
    expect(result.axios.ok).toBe(false);
    expect(result.diagnosis).toMatch(/base URL|connectivity|failed/i);
  });

  it('diagnoses transport bug when SDK fails but axios succeeds against LiteLLM', async () => {
    sdkCreate.mockRejectedValue(new Error('Premature close'));
    axiosPost.mockResolvedValue(okAxios);

    const result = await testModelConnection(litellmParams);

    expect(result.ok).toBe(false);
    expect(result.sdk.ok).toBe(false);
    expect(result.axios.ok).toBe(true);
    expect(result.diagnosis).toMatch(/premature close|keep-alive|transport/i);
  });

  it('handles a LiteLLM proxy 404 for an unknown model', async () => {
    sdkCreate.mockRejectedValue(new Error('404'));
    axiosPost.mockResolvedValue({
      status: 404,
      data: { error: { message: 'model not found' } },
      headers: {},
    });

    const result = await testModelConnection(litellmParams);

    expect(result.ok).toBe(false);
    expect(result.diagnosis).toMatch(/404|model name/i);
  });

  it('uses the OpenAI-compatible path (not native adapter) for litellm', async () => {
    // When adapter is 'openai', testModelConnection should NOT branch into
    // the native adapter path. It should run the SDK+axios cross-check.
    sdkCreate.mockResolvedValue(okCompletion);
    axiosPost.mockResolvedValue(okAxios);

    const result = await testModelConnection(litellmParams);

    // Both transports should have real durations (not the n/a stub from native path).
    expect(result.sdk.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.axios.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.axios.content).not.toMatch(/n\/a/);
  });
});
