/**
 * Auto-repair tests (forgiving flow generation + reusable repair).
 *
 * Covers both entry points of flowAutoRepair.ts:
 *   - repairFlowSpec: ORDER-based, used by generation on the compact FlowSpec.
 *   - autoRepairFlow: POSITION-based, used by the builder on a full Flow.
 * The invariants that matter: the result is runnable (validateFlow-clean), every injected
 * edge is a LEGAL connection, the input is never mutated, and an already-wired flow is a no-op.
 */
import { autoRepairFlow, repairFlowSpec } from '@/utils/shared/flowAutoRepair';
import { compileFlowSpec, FlowSpec, CompileContext } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { getConnectionError } from '@/utils/shared/connectionRules';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Edge } from '@xyflow/react';

const ctx: CompileContext = { models: [{ id: 'm1', name: 'gpt' }] };
const vctx = { models: [{ id: 'm1', name: 'gpt' }] };

function pnode(id: string, type: string, x: number, y: number): FlowNode {
  const properties = type === 'process' ? { boundModel: 'm1', promptTemplate: 'do it' } : {};
  return { id, type, position: { x, y }, data: { label: id, type, properties } } as FlowNode;
}

const isMcp = (e: Edge) => (e.data as { edgeType?: string } | undefined)?.edgeType === 'mcp';
const controlPairs = (flow: Flow) => flow.edges.filter((e) => !isMcp(e)).map((e) => `${e.source}->${e.target}`);
const edgeBetween = (flow: Flow, from: string, to: string) => flow.edges.find((e) => e.source === from && e.target === to);

// ---------------------------------------------------------------------------
// repairFlowSpec — generation path (order geometry)
// ---------------------------------------------------------------------------

describe('repairFlowSpec (generation, order-based)', () => {
  it('chains disconnected process nodes and injects start + finish', () => {
    const spec: FlowSpec = {
      name: 'pipeline',
      nodes: [
        { key: 'a', type: 'process', label: 'a', model: 'm1', prompt: 'Step 1.' },
        { key: 'b', type: 'process', label: 'b', model: 'm1', prompt: 'Step 2.' },
        { key: 'c', type: 'process', label: 'c', model: 'm1', prompt: 'Step 3.' },
      ],
      edges: [],
    };
    const { spec: repaired, changes } = repairFlowSpec(spec);
    const codes = changes.map((c) => c.code);
    expect(codes).toContain('auto-added-start');
    expect(codes).toContain('auto-added-finish');
    expect(codes).toContain('auto-connected');

    const compiled = compileFlowSpec(repaired, ctx);
    const flow = compiled.flow!;
    expect(flow).toBeTruthy();
    // Runnable: no blocking validation errors.
    expect(validateFlow(flow, vctx).errorCount).toBe(0);
    expect(flow.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(flow.nodes.some((n) => n.type === 'finish')).toBe(true);
    // Sequential chain a -> b -> c reconstructed from author order.
    const labelPairs = new Set(
      flow.edges
        .filter((e) => !isMcp(e))
        .map((e) => {
          const s = flow.nodes.find((n) => n.id === e.source)!;
          const t = flow.nodes.find((n) => n.id === e.target)!;
          return `${s.data.label}->${t.data.label}`;
        })
    );
    expect(labelPairs.has('a->b')).toBe(true);
    expect(labelPairs.has('b->c')).toBe(true);
  });

  it('is a no-op on an already-connected spec', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        { key: 'a', type: 'process', model: 'm1', prompt: 'x' },
        { key: 'f', type: 'finish' },
      ],
      edges: [
        { from: 's', to: 'a' },
        { from: 'a', to: 'f' },
      ],
    };
    const { changes } = repairFlowSpec(spec);
    expect(changes).toHaveLength(0);
  });

  it('recurses into inline subflow children', () => {
    const spec: FlowSpec = {
      nodes: [
        { key: 's', type: 'start' },
        {
          key: 'sub',
          type: 'subflow',
          subflowSpec: {
            nodes: [{ key: 'x', type: 'process', model: 'm1', prompt: 'child' }],
            edges: [],
          },
        },
      ],
      edges: [{ from: 's', to: 'sub' }],
    };
    const { spec: repaired } = repairFlowSpec(spec);
    const child = repaired.nodes.find((n) => n.key === 'sub')!.subflowSpec!;
    expect(child.nodes.some((n) => n.type === 'start')).toBe(true);
    expect(child.nodes.some((n) => n.type === 'finish')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// autoRepairFlow — builder path (position geometry)
// ---------------------------------------------------------------------------

describe('autoRepairFlow (builder, position-based)', () => {
  it('adds start/finish and connects a vertical stack sequentially', () => {
    const input: Flow = {
      id: 'f',
      name: 'stack',
      nodes: [pnode('p1', 'process', 250, 0), pnode('p2', 'process', 250, 200), pnode('p3', 'process', 250, 400)],
      edges: [],
    };
    const { flow, changes } = autoRepairFlow(input);
    expect(changes.map((c) => c.code)).toEqual(expect.arrayContaining(['auto-added-start', 'auto-added-finish', 'auto-connected']));
    expect(validateFlow(flow, vctx).errorCount).toBe(0);
    // p1 -> p2 -> p3 in the middle.
    expect(controlPairs(flow)).toEqual(expect.arrayContaining(['p1->p2', 'p2->p3']));
  });

  it('wires parallel subflows bidirectionally and skips through to the next node', () => {
    const input: Flow = {
      id: 'f',
      name: 'orchestrator',
      nodes: [
        pnode('P', 'process', 250, 0),
        pnode('S1', 'subflow', 0, 200),
        pnode('S2', 'subflow', 250, 200),
        pnode('S3', 'subflow', 500, 200),
        pnode('Q', 'process', 250, 400),
      ],
      edges: [],
    };
    const { flow } = autoRepairFlow(input);

    // Each parallel subflow gets a two-way handoff with the orchestrator.
    for (const s of ['S1', 'S2', 'S3']) {
      const e = edgeBetween(flow, 'P', s);
      expect(e).toBeDefined();
      expect((e!.data as { bidirectional?: boolean }).bidirectional).toBe(true);
    }
    // Skip-through: the row below attaches to the orchestrator, NOT through a subflow.
    expect(edgeBetween(flow, 'P', 'Q')).toBeDefined();
    for (const s of ['S1', 'S2', 'S3']) expect(edgeBetween(flow, s, 'Q')).toBeUndefined();

    // A subflow keeps exactly one outgoing path (its bidirectional back-edge) — no error.
    expect(validateFlow(flow, vctx).issues.some((i) => i.code === 'subflow-multiple-outgoing')).toBe(false);
  });

  it('every injected edge is a legal connection', () => {
    const input: Flow = {
      id: 'f',
      name: 'legal',
      nodes: [pnode('p1', 'process', 250, 0), pnode('p2', 'process', 250, 200)],
      edges: [],
    };
    const { flow } = autoRepairFlow(input);
    const byId = new Map(flow.nodes.map((n) => [n.id, n]));
    for (const e of flow.edges.filter((x) => !isMcp(x))) {
      const s = byId.get(e.source)!;
      const t = byId.get(e.target)!;
      expect(getConnectionError(s.type, e.sourceHandle, t.type, e.targetHandle)).toBeNull();
    }
  });

  it('never mutates the input flow', () => {
    const input: Flow = {
      id: 'f',
      name: 'immutable',
      nodes: [pnode('p1', 'process', 250, 0), pnode('p2', 'process', 250, 200)],
      edges: [],
    };
    const before = JSON.stringify(input);
    autoRepairFlow(input);
    expect(JSON.stringify(input)).toEqual(before);
  });

  it('is a no-op on an already-wired flow', () => {
    const start = { id: 's', type: 'start', position: { x: 250, y: 0 }, data: { label: 'Start', type: 'start', properties: {} } } as FlowNode;
    const finish = { id: 'f2', type: 'finish', position: { x: 250, y: 400 }, data: { label: 'Finish', type: 'finish', properties: {} } } as FlowNode;
    const p = pnode('p', 'process', 250, 200);
    const mk = (from: FlowNode, to: FlowNode): Edge =>
      ({
        id: `${from.id}:${from.type}-bottom->${to.id}:${to.type}-top`,
        source: from.id,
        sourceHandle: `${from.type}-bottom`,
        target: to.id,
        targetHandle: `${to.type}-top`,
        type: 'custom',
        data: { edgeType: 'standard' },
      } as Edge);
    const input: Flow = { id: 'f', name: 'wired', nodes: [start, p, finish], edges: [mk(start, p), mk(p, finish)] };
    const { changes } = autoRepairFlow(input);
    expect(changes).toHaveLength(0);
  });
});
