import { NextRequest } from 'next/server';
import { Agent } from 'undici';
import { parseRequestParameters } from '@/app/v1/chat/completions/requestParser';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import {
  requireFunctionToolCalls,
  requireFunctionTools,
  UnsupportedOpenAIToolTypeError,
} from '@/shared/types/openai';

describe('OpenAI SDK 7 compatibility boundary', () => {
  it('keeps the hardened Undici transport and client options', () => {
    const client = createOpenAIClient({
      apiKey: 'test-key',
      baseURL: 'http://localhost:11434/v1',
      maxRetries: 3,
      timeout: 1_234,
      defaultHeaders: { 'X-Test': 'flujo' },
    });

    expect(client.baseURL).toBe('http://localhost:11434/v1');
    expect(client.maxRetries).toBe(3);
    expect(client.timeout).toBe(1_234);
    expect(client.fetchOptions?.dispatcher).toBeInstanceOf(Agent);
  });

  it('accepts function tools and function tool calls', () => {
    expect(requireFunctionTools([{
      type: 'function',
      function: { name: 'lookup' },
    }])).toHaveLength(1);
    expect(requireFunctionToolCalls([{
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup', arguments: '{}' },
    }])).toHaveLength(1);
  });

  it('rejects SDK custom tools instead of silently dropping them', () => {
    expect(() => requireFunctionTools([{
      type: 'custom',
      custom: { name: 'raw_input' },
    }])).toThrow(UnsupportedOpenAIToolTypeError);

    expect(() => requireFunctionToolCalls([{
      id: 'call-2',
      type: 'custom',
      custom: { name: 'raw_input', input: 'hello' },
    }])).toThrow('FLUJO supports function tools only');
  });

  it('rejects custom tools at the public OpenAI-compatible request boundary', async () => {
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'model-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'custom', custom: { name: 'raw_input' } }],
      }),
    });

    await expect(parseRequestParameters(request)).rejects.toMatchObject({
      name: 'UnsupportedOpenAIToolTypeError',
      code: 'unsupported_tool_type',
    });
  });

  it('extracts the UI-only compact tool payload response flag from metadata', async () => {
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'flow-test',
        messages: [{ role: 'user', content: 'hello' }],
        metadata: { flujo: 'true', compactToolPayloads: 'true' },
      }),
    });

    await expect(parseRequestParameters(request)).resolves.toMatchObject({
      flujo: true,
      compactToolPayloads: true,
    });
  });
});
