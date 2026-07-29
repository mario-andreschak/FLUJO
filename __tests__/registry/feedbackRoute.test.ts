import type { NextRequest } from 'next/server';

const submitFeedbackMock = jest.fn();
jest.mock('@/backend/utils/packageRegistryClient', () => ({
  submitFeedback: (...args: unknown[]) => submitFeedbackMock(...args),
}));

import { POST } from '@/app/api/registry/feedback/route';

function request(
  body: unknown,
  headers: Record<string, string> = { host: 'localhost:4200' },
) {
  return new Request('http://localhost:4200/api/registry/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => jest.clearAllMocks());

describe('POST /api/registry/feedback', () => {
  it('forwards validated feedback as opaque values', async () => {
    submitFeedbackMock.mockResolvedValue({
      status: 201,
      body: { accepted: true },
    });
    const notice = `Nice app'); DROP TABLE feedback; --`;

    const response = await POST(request({ notice, rating: 5 }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ accepted: true });
    expect(submitFeedbackMock).toHaveBeenCalledWith(notice, 5);
  });

  it.each([
    [{ notice: '', rating: 5 }],
    [{ notice: 'hello', rating: 3 }],
    [{ notice: 'hello', rating: 5, unexpected: true }],
    [{ notice: 'x'.repeat(256), rating: 1 }],
  ])('rejects invalid feedback %#', async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });

  it('preserves the registry rate-limit response', async () => {
    submitFeedbackMock.mockResolvedValue({ status: 429, body: {} });

    const response = await POST(request({ notice: 'More docs, please.', rating: 1 }));

    expect(response.status).toBe(429);
  });

  it('reports an unavailable registry as a temporary service failure', async () => {
    submitFeedbackMock.mockResolvedValue({ status: 502, body: {} });

    const response = await POST(request({ notice: 'More docs, please.', rating: 1 }));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'The feedback service is temporarily unavailable.',
    });
  });

  it('rejects cross-origin submissions before forwarding', async () => {
    const response = await POST(
      request(
        { notice: 'hello', rating: 5 },
        { host: 'localhost:4200', origin: 'https://evil.example.com' },
      ),
    );

    expect(response.status).toBe(403);
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });
});
