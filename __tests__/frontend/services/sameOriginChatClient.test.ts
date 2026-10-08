import { createSameOriginChatClient } from '@/frontend/services/chat/openaiClient';
import { LLM_REQUEST_TIMEOUT_MS } from '@/shared/config/timeouts';

describe('built-in same-origin chat with the installed OpenAI SDK', () => {
  const body = { model: 'flow-Approved inquiry', messages: [{ role: 'user' as const, content: 'hello' }] };
  const result = { id: 'completion-fixture', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] };
  const makeFetch = () => jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>().mockImplementation(async () => new Response(JSON.stringify(result), {
    status: 200, headers: { 'content-type': 'application/json' },
  }));

  test('sends the completion to its own origin without a placeholder bearer', async () => {
    const fetchMock = makeFetch();
    const client = createSameOriginChatClient('https://chat.example.test', fetchMock);
    expect(await client.chat.completions.create(body)).toMatchObject({ id: result.id });
    const [url, init] = fetchMock.mock.calls[0];
    const request = new Request(url, init);
    expect(request.url).toBe('https://chat.example.test/v1/chat/completions');
    expect(request.headers.has('authorization')).toBe(false);
    expect(await request.json()).toEqual(body);
    expect(client.maxRetries).toBe(0);
    expect(client.timeout).toBe(LLM_REQUEST_TIMEOUT_MS);
  });

  test('preserves an explicit request bearer and API key', async () => {
    const fetchMock = makeFetch();
    const client = createSameOriginChatClient('https://chat.example.test', fetchMock);
    await client.chat.completions.create(body, { headers: {
      Authorization: 'Bearer explicit-caller-credential', 'api-key': 'explicit-api-credential',
    } });
    const [url, init] = fetchMock.mock.calls[0];
    const request = new Request(url, init);
    expect(request.url).toBe('https://chat.example.test/v1/chat/completions');
    expect(request.headers.get('authorization')).toBe('Bearer explicit-caller-credential');
    expect(request.headers.get('api-key')).toBe('explicit-api-credential');
  });
});
