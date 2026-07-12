/**
 * Route test for POST /api/flow/generate (issue #14): the thin HTTP wrapper around the
 * generateFlow service — lock gate, body handling, and envelope passthrough. The
 * generation logic itself is covered by generateFlow.test.ts.
 */

const assertUnlockedMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...a),
}));

const generateFlowMock = jest.fn();
jest.mock('@/backend/services/flow/generateFlow', () => ({
  generateFlow: (...a: unknown[]) => generateFlowMock(...a),
}));

import { POST } from '@/app/api/flow/generate/route';

// The handler only calls request.json(); a minimal stub stands in for NextRequest.
const req = (body?: unknown, jsonThrows = false) =>
  ({
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  }) as any;

const draft = { id: 'f-new', name: 'generated_flow', nodes: [], edges: [] };
const validation = { issues: [], errorCount: 0, warningCount: 0, isRunnable: true };

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  generateFlowMock.mockResolvedValue({ success: true, flow: draft, validation, attempts: 1, installedServers: [] });
});

describe('POST /api/flow/generate', () => {
  it('returns the draft + validation + attempts + installedServers on success', async () => {
    const res = await POST(req({ description: 'build me a thing', modelId: 'm1' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ flow: draft, validation, attempts: 1, installedServers: [] });
    expect(generateFlowMock).toHaveBeenCalledWith({
      description: 'build me a thing',
      modelId: 'm1',
      maxRepairs: undefined,
      allowInstall: false,
    });
  });

  it('passes maxRepairs through', async () => {
    await POST(req({ description: 'x', modelId: 'm1', maxRepairs: 2 }));
    expect(generateFlowMock).toHaveBeenCalledWith(expect.objectContaining({ maxRepairs: 2 }));
  });

  it('passes allowInstall through only as an explicit boolean true', async () => {
    await POST(req({ description: 'x', modelId: 'm1', allowInstall: true }));
    expect(generateFlowMock).toHaveBeenCalledWith(expect.objectContaining({ allowInstall: true }));
    generateFlowMock.mockClear();
    generateFlowMock.mockResolvedValue({ success: true, flow: draft, validation, attempts: 1, installedServers: [] });
    await POST(req({ description: 'x', modelId: 'm1', allowInstall: 'yes' }));
    expect(generateFlowMock).toHaveBeenCalledWith(expect.objectContaining({ allowInstall: false }));
  });

  it('maps a service failure to its status code + error envelope', async () => {
    generateFlowMock.mockResolvedValue({ success: false, error: 'no usable spec', statusCode: 422 });
    const res = await POST(req({ description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'no usable spec' });
  });

  it('400s on an unparseable or non-object body without calling the service', async () => {
    const res = await POST(req(undefined, true));
    expect(res.status).toBe(400);
    expect(generateFlowMock).not.toHaveBeenCalled();
  });

  it('defers missing-field validation to the service (empty strings passed through)', async () => {
    generateFlowMock.mockResolvedValue({ success: false, error: 'A flow description is required', statusCode: 400 });
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(generateFlowMock).toHaveBeenCalledWith({ description: '', modelId: '', maxRepairs: undefined, allowInstall: false });
  });

  it('is gated by the encryption lock', async () => {
    const locked = new Response(JSON.stringify({ error: 'locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValue(locked);
    const res = await POST(req({ description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(423);
    expect(generateFlowMock).not.toHaveBeenCalled();
  });

  it('500s when the service throws unexpectedly', async () => {
    generateFlowMock.mockRejectedValue(new Error('boom'));
    const res = await POST(req({ description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
  });
});
