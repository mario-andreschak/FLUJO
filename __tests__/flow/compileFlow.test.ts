/**
 * Tests for the deterministic FlowSpec authoring surface (#14 follow-up):
 * the compileSpec service (compile + validate + gated save) and its HTTP wrapper
 * POST /api/flow/compile. This is the no-LLM sibling of generateFlow — external
 * agents author FlowSpec directly instead of raw ReactFlow JSON.
 */

const assertUnlockedMock = jest.fn();
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...a),
}));

const loadModelsMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: (...a: unknown[]) => loadModelsMock(...a),
  },
}));

const loadServerConfigsMock = jest.fn();
const getServerStatusMock = jest.fn();
const listServerToolsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
  },
}));

const loadFlowsMock = jest.fn();
const saveFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: (...a: unknown[]) => loadFlowsMock(...a),
    saveFlow: (...a: unknown[]) => saveFlowMock(...a),
  },
}));

import { compileSpec } from '@/backend/services/flow/compileFlow';
import { POST } from '@/app/api/flow/compile/route';

const req = (body?: unknown) => ({ json: async () => body }) as any;

const goodSpec = {
  name: 'wired_flow',
  nodes: [
    { key: 's', type: 'start', prompt: 'sys' },
    { key: 'p', type: 'process', model: 'model-abc', prompt: 'work', servers: [{ name: 'srv', tools: ['tool_a'] }] },
    { key: 'f', type: 'finish' },
  ],
  edges: [
    { from: 's', to: 'p' },
    { from: 'p', to: 'f' },
  ],
};

const brokenSpec = {
  ...goodSpec,
  nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, model: 'ghost-model' } : n)),
};

beforeEach(() => {
  jest.clearAllMocks();
  assertUnlockedMock.mockResolvedValue(null);
  loadModelsMock.mockResolvedValue([{ id: 'model-abc', name: 'worker', ApiKey: 'enc' }]);
  loadServerConfigsMock.mockResolvedValue([{ name: 'srv' }]);
  getServerStatusMock.mockResolvedValue({ status: 'connected' });
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'tool_a', description: 'does a' }] });
  loadFlowsMock.mockResolvedValue([]);
  saveFlowMock.mockResolvedValue(undefined);
});

describe('compileSpec service', () => {
  it('compiles + validates without saving by default', async () => {
    const result = await compileSpec(goodSpec);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.validation.errorCount).toBe(0);
    expect(result.saved).toBe(false);
    expect(result.flow.nodes.map((n) => n.type).sort()).toEqual(['finish', 'mcp', 'process', 'start']);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('save: true persists when validation is clean', async () => {
    const result = await compileSpec(goodSpec, { save: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.saved).toBe(true);
    expect(saveFlowMock).toHaveBeenCalledTimes(1);
    expect(saveFlowMock).toHaveBeenCalledWith(result.flow);
  });

  it('save: true does NOT persist when validation has errors', async () => {
    const result = await compileSpec(brokenSpec, { save: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.validation.errorCount).toBeGreaterThan(0);
    expect(result.saved).toBe(false);
    expect(saveFlowMock).not.toHaveBeenCalled();
    // The agent-facing loop needs the actionable issue list.
    expect(result.validation.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['model-unresolved', 'process-model-missing'])
    );
  });

  it('rejects a non-object spec with 400', async () => {
    for (const bad of [null, 'a string', 42, ['array']]) {
      const result = await compileSpec(bad as unknown);
      expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 400 }));
    }
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('422s with issues when the spec produces no usable flow', async () => {
    const result = await compileSpec({ nodes: [], edges: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.statusCode).toBe(422);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'no-usable-nodes' }));
  });

  it('each compile mints a fresh flow id — saving is always a create, never an overwrite', async () => {
    const a = await compileSpec(goodSpec);
    const b = await compileSpec(goodSpec);
    if (!a.success || !b.success) throw new Error('expected success');
    expect(a.flow.id).not.toBe(b.flow.id);
  });

  describe('updateFlowId (replace an existing flow in place)', () => {
    it('keeps the target id and lets the flow keep its own name (no dedup rename)', async () => {
      loadFlowsMock.mockResolvedValue([{ id: 'flow-1', name: 'wired_flow', nodes: [], edges: [] }]);
      const result = await compileSpec(goodSpec, { save: true, updateFlowId: 'flow-1' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.flow.id).toBe('flow-1');
      expect(result.flow.name).toBe('wired_flow'); // not wired_flow_2
      expect(result.saved).toBe(true);
      expect(saveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'flow-1' }));
    });

    it('still dedupes against OTHER flows\' names', async () => {
      loadFlowsMock.mockResolvedValue([
        { id: 'flow-1', name: 'wired_flow', nodes: [], edges: [] },
        { id: 'flow-2', name: 'taken', nodes: [], edges: [] },
      ]);
      const result = await compileSpec({ ...goodSpec, name: 'taken' }, { updateFlowId: 'flow-1' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.flow.name).toBe('taken_2');
    });

    it('404s for an unknown target id without compiling or saving', async () => {
      const result = await compileSpec(goodSpec, { save: true, updateFlowId: 'ghost' });
      expect(result).toEqual(expect.objectContaining({ success: false, statusCode: 404 }));
      expect(saveFlowMock).not.toHaveBeenCalled();
    });

    it('does NOT save (existing flow untouched) when validation has errors', async () => {
      loadFlowsMock.mockResolvedValue([{ id: 'flow-1', name: 'wired_flow', nodes: [], edges: [] }]);
      const result = await compileSpec(brokenSpec, { save: true, updateFlowId: 'flow-1' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.saved).toBe(false);
      expect(saveFlowMock).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/flow/compile', () => {
  it('200 with { flow, validation, saved: false } for compile-only', async () => {
    const res = await POST(req({ spec: goodSpec }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(false);
    expect(body.validation.errorCount).toBe(0);
    expect(body.flow.name).toBe('wired_flow');
  });

  it('201 when saved', async () => {
    const res = await POST(req({ spec: goodSpec, save: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.saved).toBe(true);
  });

  it('200 (not 201) when save was requested but errors block it', async () => {
    const res = await POST(req({ spec: brokenSpec, save: true }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(false);
    expect(body.validation.errorCount).toBeGreaterThan(0);
  });

  it('400 on a missing spec', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  it('is gated by the encryption lock', async () => {
    assertUnlockedMock.mockResolvedValue(new Response(JSON.stringify({ error: 'locked' }), { status: 423 }));
    const res = await POST(req({ spec: goodSpec }));
    expect(res.status).toBe(423);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Multi-level (nested subflowSpec) bundles — issue #94
// ---------------------------------------------------------------------------

const nestedSpec = {
  name: 'parent',
  nodes: [
    { key: 's', type: 'start' },
    {
      key: 'sub',
      type: 'subflow',
      label: 'child',
      subflowSpec: {
        name: 'child',
        nodes: [
          { key: 'cs', type: 'start' },
          { key: 'cp', type: 'process', model: 'model-abc', prompt: 'x', servers: [{ name: 'srv', tools: ['tool_a'] }] },
          { key: 'cf', type: 'finish' },
        ],
        edges: [
          { from: 'cs', to: 'cp' },
          { from: 'cp', to: 'cf' },
        ],
      },
    },
    { key: 'f', type: 'finish' },
  ],
  edges: [
    { from: 's', to: 'sub' },
    { from: 'sub', to: 'f' },
  ],
};

describe('compileSpec — nested bundle (#94)', () => {
  it('returns the whole bundle and saves descendants-first when clean', async () => {
    const result = await compileSpec(nestedSpec, { save: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.flows).toHaveLength(2);
    expect(result.saved).toBe(true);
    expect(saveFlowMock).toHaveBeenCalledTimes(2);
    // Child saved first, root second (dependency order).
    const firstSaved = saveFlowMock.mock.calls[0][0];
    const secondSaved = saveFlowMock.mock.calls[1][0];
    expect(firstSaved.name).toBe('child');
    expect(secondSaved.name).toBe('parent');
    // The parent's subflow node points at the (already-saved) child id.
    const sub = result.flow.nodes.find((n) => n.type === 'subflow')!;
    expect(sub.data.properties!.subflowId).toBe(firstSaved.id);
  });

  it('saves NOTHING when a nested child has validation errors', async () => {
    const broken = {
      ...nestedSpec,
      nodes: nestedSpec.nodes.map((n: any) =>
        n.key === 'sub'
          ? {
              ...n,
              subflowSpec: {
                ...n.subflowSpec,
                nodes: n.subflowSpec.nodes.map((cn: any) => (cn.key === 'cp' ? { ...cn, model: 'ghost-model' } : cn)),
              },
            }
          : n
      ),
    };
    const result = await compileSpec(broken, { save: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.validation.errorCount).toBeGreaterThan(0);
    // The error lives in the CHILD flow, yet it still blocks the whole save.
    expect(result.validation.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['process-model-missing'])
    );
    expect(result.saved).toBe(false);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });
});
