import { NextRequest } from 'next/server';
import { Agent } from 'undici';
import OpenAI, { type ClientOptions } from 'openai';
import { parseRequestParameters } from '@/app/v1/chat/completions/requestParser';
import { createOpenAIClient } from '@/backend/services/model/openaiClient';
import {
  requireFunctionToolCalls,
  requireFunctionTools,
  UnsupportedOpenAIToolTypeError,
} from '@/shared/types/openai';

function streamedClient(payload: string, options: {
  leaveOpen?: boolean;
  onCancel?: (signal: AbortSignal | null | undefined) => void;
  logger?: ClientOptions['logger'];
} = {}) {
  const bytes = new TextEncoder().encode(payload);
  return new OpenAI({
    apiKey: 'fixture-only',
    maxRetries: 0,
    logger: options.logger,
    logLevel: 'error',
    fetch: async (_url, init) => {
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(bytes);
          } else if (!options.leaveOpen) {
            controller.close();
          }
        },
        cancel() {
          options.onCancel?.(init?.signal);
        },
      }, { highWaterMark: 0 }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
}

describe('OpenAI SDK 7 compatibility boundary', () => {
  it('preserves a final Responses reply without a trailing event separator', async () => {
    const reply = { type: 'response.completed', response: { id: 'final-reply', output: [] } };
    const client = streamedClient(`event: response.completed\ndata: ${JSON.stringify(reply)}`);
    const stream = await client.responses.create({ model: 'fixture', input: 'hello', stream: true });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([reply]);
  });

  it('keeps malformed provider payloads out of error diagnostics', async () => {
    const marker = 'private-conversation-fixture';
    const errorLog = jest.fn();
    const client = streamedClient(`data: {"private":"${marker}",INVALID}\n\n`, {
      logger: { error: errorLog, warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
    });
    const stream = await client.chat.completions.create({ model: 'fixture', messages: [], stream: true });
    await expect((async () => {
      for await (const event of stream) void event;
    })()).rejects.toThrow('Error reading response: malformed server-sent event JSON.');
    expect(errorLog).toHaveBeenCalled();
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(marker);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('INVALID');
  });

  it('aborts the provider request before cancelling a stopped reply body', async () => {
    const onCancel = jest.fn((signal: AbortSignal | null | undefined) => signal?.aborted);
    const client = streamedClient('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n', {
      leaveOpen: true,
      onCancel,
    });
    const stream = await client.chat.completions.create({ model: 'fixture', messages: [], stream: true });
    for await (const event of stream) {
      expect(event.choices[0].delta.content).toBe('first');
      break;
    }
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel.mock.results[0].value).toBe(true);
    expect(stream.controller.signal.aborted).toBe(true);
  });

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

    // Undici defaults both values to 300 seconds. With SDK retries enabled,
    // that silently capped a slow Ollama request at roughly 15 minutes despite
    // FLUJO's five-hour SDK timeout.
    const dispatcher = client.fetchOptions?.dispatcher as Agent;
    const optionsSymbol = Object.getOwnPropertySymbols(dispatcher)
      .find((symbol) => symbol.description === 'options');
    expect(optionsSymbol).toBeDefined();
    expect(Reflect.get(dispatcher, optionsSymbol!)).toMatchObject({
      headersTimeout: 5 * 60 * 60 * 1000,
      bodyTimeout: 5 * 60 * 60 * 1000,
    });
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

  it('extracts the stateful append-only turn contract from metadata', async () => {
    const request = new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'flow-test',
        messages: [{ role: 'user', content: 'only the new turn' }],
        metadata: { flujo: 'true', appendMessages: 'true' },
      }),
    });

    await expect(parseRequestParameters(request)).resolves.toMatchObject({
      appendMessages: true,
      messages: [{ role: 'user', content: 'only the new turn' }],
    });
  });
});
