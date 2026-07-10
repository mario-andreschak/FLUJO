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
jest.mock('@/backend/services/model/openaiClient', () => ({
  ...jest.requireActual('@/backend/services/model/openaiClient'),
  createOpenAIClient: jest.fn(() => ({
    chat: { completions: { create: sdkCreate } },
  })),
}));

// Mock axios so we can drive the cross-check attempt's outcome.
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

import axios from 'axios';
import { testModelConnection } from '@/backend/services/model/testConnection';

const axiosPost = (axios as unknown as { post: jest.Mock }).post;

const okCompletion = { choices: [{ message: { content: 'pong' } }], usage: { total_tokens: 3 } };
const okAxios = { status: 200, data: okCompletion, headers: {} };

const run = () =>
  testModelConnection({ modelName: 'test/model', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-x' });

beforeEach(() => {
  sdkCreate.mockReset();
  axiosPost.mockReset();
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
});
