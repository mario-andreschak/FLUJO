/**
 * @jest-environment node
 *
 * Node env so the NDJSON streaming Response (a web ReadableStream) can be drained
 * with a reader. The route is thin glue over the Ollama client, so the client is
 * mocked and we assert the translation: progress → stdout, error → stderr, and a
 * terminal result whose success reflects whether the stream errored.
 */
import type { NextRequest } from 'next/server';
import type { CommandStreamEvent } from '@/shared/types/streaming';

jest.mock('@/backend/services/ollama', () => ({
  pull: jest.fn(),
  // Keep formatting trivial and deterministic for the assertions below.
  formatPullProgress: (p: { status?: string }) => p.status ?? 'pulling',
}));

import { POST } from '@/app/api/local-models/pull/route';
import * as ollama from '@/backend/services/ollama';

function postRequest(body: unknown): NextRequest {
  return new Request('http://localhost:4200/api/local-models/pull', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as NextRequest;
}

async function drain(res: Response): Promise<CommandStreamEvent[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CommandStreamEvent);
}

describe('POST /api/local-models/pull', () => {
  beforeEach(() => jest.clearAllMocks());

  it('streams progress as stdout then a success result', async () => {
    (ollama.pull as jest.Mock).mockImplementation(
      async (_model: string, onProgress: (p: unknown) => void) => {
        onProgress({ status: 'pulling manifest' });
        onProgress({ status: 'downloading', total: 100, completed: 100 });
        onProgress({ status: 'success' });
      }
    );

    const events = await drain(await POST(postRequest({ model: 'llama3.2:3b' })));

    expect(events[0]).toEqual({ type: 'status', phase: 'running', message: expect.any(String) });
    expect(events.filter((e) => e.type === 'stdout')).toHaveLength(3);
    expect(events[events.length - 1]).toEqual({
      type: 'result',
      success: true,
      commandOutput: 'Pulled llama3.2:3b',
    });
    expect(ollama.pull).toHaveBeenCalledWith('llama3.2:3b', expect.any(Function), expect.anything());
  });

  it('rejects an invalid model name with 400 and never calls pull', async () => {
    const res = await POST(postRequest({ model: 'bad name with spaces!' }));
    expect(res.status).toBe(400);
    expect(ollama.pull).not.toHaveBeenCalled();
  });

  it('surfaces an in-stream error as stderr and a failed result', async () => {
    (ollama.pull as jest.Mock).mockImplementation(
      async (_model: string, onProgress: (p: unknown) => void) => {
        onProgress({ error: 'pull model manifest: file does not exist' });
      }
    );

    const events = await drain(await POST(postRequest({ model: 'nope' })));

    expect(events).toContainEqual({
      type: 'stderr',
      data: 'pull model manifest: file does not exist',
    });
    const last = events[events.length - 1];
    expect(last.type).toBe('result');
    expect((last as { success: boolean }).success).toBe(false);
  });
});
