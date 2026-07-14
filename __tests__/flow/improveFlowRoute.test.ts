/**
 * Route test for POST /api/flow/improve (issue #99): the thin HTTP wrapper around the
 * improveFlow service — lock gate, body/shape validation, and envelope passthrough. The
 * improvement logic itself is covered by improveFlow.test.ts.
 */

const assertUnlockedMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...a),
}));

const improveFlowMock = jest.fn();
jest.mock('@/backend/services/flow/generateFlow', () => ({
  improveFlow: (...a: unknown[]) => improveFlowMock(...a),
}));

import { POST } from '@/app/api/flow/improve/route';

const req = (body?: unknown, jsonThrows = false) =>
  ({
    json: async () => {
      if (jsonThrows) throw new Error('bad json');
      return body;
    },
  }) as any;

const flow = { id: 'flow-1', name: 'my_flow', nodes: [], edges: [] };
const validation = { issues: [], errorCount: 0, warningCount: 0, isRunnable: true };
const flows = [{ flow, validation }];

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  improveFlowMock.mockResolvedValue({
    success: true,
    flow,
    validation,
    flows,
    rootFlowId: 'flow-1',
    attempts: 1,
    installedServers: [],
  });
});

describe('POST /api/flow/improve', () => {
  it('returns the revised flow + validation + attempts + installedServers on success', async () => {
    const res = await POST(req({ flow, description: 'add a step', modelId: 'm1' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      flow,
      validation,
      flows,
      rootFlowId: 'flow-1',
      attempts: 1,
      installedServers: [],
    });
    expect(improveFlowMock).toHaveBeenCalledWith({
      flow,
      description: 'add a step',
      modelId: 'm1',
      maxRepairs: undefined,
      allowInstall: false,
    });
  });

  it('passes maxRepairs through', async () => {
    await POST(req({ flow, description: 'x', modelId: 'm1', maxRepairs: 2 }));
    expect(improveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ maxRepairs: 2 }));
  });

  it('passes allowInstall through only as an explicit boolean true', async () => {
    await POST(req({ flow, description: 'x', modelId: 'm1', allowInstall: true }));
    expect(improveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ allowInstall: true }));
    improveFlowMock.mockClear();
    improveFlowMock.mockResolvedValue({ success: true, flow, validation, flows, rootFlowId: 'flow-1', attempts: 1, installedServers: [] });
    await POST(req({ flow, description: 'x', modelId: 'm1', allowInstall: 'yes' }));
    expect(improveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ allowInstall: false }));
  });

  it('400s on an unparseable or non-object body without calling the service', async () => {
    const res = await POST(req(undefined, true));
    expect(res.status).toBe(400);
    expect(improveFlowMock).not.toHaveBeenCalled();
  });

  it('400s when the flow is missing or malformed', async () => {
    expect((await POST(req({ description: 'x', modelId: 'm1' }))).status).toBe(400);
    expect((await POST(req({ flow: { id: 'x' }, description: 'x', modelId: 'm1' }))).status).toBe(400);
    expect(improveFlowMock).not.toHaveBeenCalled();
  });

  it('400s when the description or modelId is empty', async () => {
    expect((await POST(req({ flow, description: '   ', modelId: 'm1' }))).status).toBe(400);
    expect((await POST(req({ flow, description: 'x', modelId: '' }))).status).toBe(400);
    expect(improveFlowMock).not.toHaveBeenCalled();
  });

  it('maps a service failure to its status code + error envelope', async () => {
    improveFlowMock.mockResolvedValue({ success: false, error: 'no usable spec', statusCode: 422 });
    const res = await POST(req({ flow, description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toEqual({ error: 'no usable spec' });
  });

  it('is gated by the encryption lock', async () => {
    const locked = new Response(JSON.stringify({ error: 'locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValue(locked);
    const res = await POST(req({ flow, description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(423);
    expect(improveFlowMock).not.toHaveBeenCalled();
  });

  it('500s when the service throws unexpectedly', async () => {
    improveFlowMock.mockRejectedValue(new Error('boom'));
    const res = await POST(req({ flow, description: 'x', modelId: 'm1' }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
  });
});
