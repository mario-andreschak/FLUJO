/**
 * Route test for POST /api/bugs/enhance (issue #127): the thin HTTP wrapper around the
 * enhance service — lock gate, body handling, and envelope passthrough. The enhancement
 * logic itself is covered by enhance.test.ts.
 */

const assertUnlockedMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...a),
}));

const enhanceMock = jest.fn();
jest.mock('@/backend/services/bugReport/enhance', () => ({
  enhanceBugReport: (...a: unknown[]) => enhanceMock(...a),
}));

import { POST } from '@/app/api/bugs/enhance/route';

const req = (body?: unknown, jsonThrows = false) =>
  ({
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  }) as any;

const result = { title: 'T', body: 'B', labels: ['bug'], enhanced: true };

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  enhanceMock.mockResolvedValue({ success: true, statusCode: 200, result });
});

describe('POST /api/bugs/enhance', () => {
  it('returns the enhancement result on success', async () => {
    const res = await POST(req({ modelId: 'm1', title: 't', description: 'd', context: { appVersion: '3.21.0' } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(result);
    expect(enhanceMock).toHaveBeenCalledWith({
      modelId: 'm1',
      title: 't',
      description: 'd',
      context: { appVersion: '3.21.0' },
    });
  });

  it('400s on an unparseable/non-object body without calling the service', async () => {
    const res = await POST(req(undefined, true));
    expect(res.status).toBe(400);
    expect(enhanceMock).not.toHaveBeenCalled();
  });

  it('maps a service failure to its status code + error envelope', async () => {
    enhanceMock.mockResolvedValue({ success: false, statusCode: 404, error: 'Model not found' });
    const res = await POST(req({ modelId: 'ghost', description: 'd' }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Model not found' });
  });

  it('is gated by the encryption lock', async () => {
    const locked = new Response(JSON.stringify({ error: 'locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValue(locked);
    const res = await POST(req({ modelId: 'm1', description: 'd' }));
    expect(res.status).toBe(423);
    expect(enhanceMock).not.toHaveBeenCalled();
  });

  it('500s when the service throws unexpectedly', async () => {
    enhanceMock.mockRejectedValue(new Error('boom'));
    const res = await POST(req({ modelId: 'm1', description: 'd' }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
  });
});
