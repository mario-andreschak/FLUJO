/**
 * Tests for the FlowBuilder Auto-Align layout helper
 * (src/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout.ts).
 *
 * Covers the pure geometry contract for issue #100: layered top-to-bottom
 * ranking of flow-control nodes, MCP nodes parked to the right of their process
 * node, non-destructive rewrites (only `position` changes), and termination in
 * the presence of bidirectional/looping edges.
 */
import { Edge } from '@xyflow/react';
import { computeAutoLayout } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout';
import { hasOverlaps } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/layoutGeometry';
import { FlowNode } from '@/frontend/types/flow/flow';

/** Shared invariant assertion (issue #373): no two padded node boxes intersect. */
function expectNoOverlaps(nodes: FlowNode[]) {
  expect(hasOverlaps(nodes)).toBe(false);
}

const node = (id: string, type: string, x = 0, y = 0): FlowNode =>
  ({
    id,
    type,
    position: { x, y },
    data: { label: id, type },
  } as FlowNode);

const flowEdge = (source: string, target: string, bidirectional = false): Edge =>
  ({
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: `${source}-bottom`,
    targetHandle: `${target}-top`,
    data: { edgeType: 'standard', bidirectional },
  } as Edge);

const mcpEdge = (processId: string, mcpId: string): Edge =>
  ({
    id: `${processId}:mcp->${mcpId}`,
    source: processId,
    sourceHandle: 'process-right-mcp',
    target: mcpId,
    targetHandle: 'mcp-left',
    data: { edgeType: 'mcp' },
  } as Edge);

describe('computeAutoLayout', () => {
  it('returns the nodes unchanged when there are 0 or 1 flow nodes', () => {
    expect(computeAutoLayout([], [])).toEqual([]);

    const single = [node('start', 'start', 42, 99)];
    const result = computeAutoLayout(single, []);
    expect(result).toBe(single); // same reference, no work done
    expect(result[0].position).toEqual({ x: 42, y: 99 });
  });

  it('ranks a linear flow strictly top-to-bottom', () => {
    const nodes = [
      node('start', 'start', 500, 500),
      node('p1', 'process', 10, 10),
      node('finish', 'finish', -20, -20),
    ];
    const edges = [flowEdge('start', 'p1'), flowEdge('p1', 'finish')];

    const laid = computeAutoLayout(nodes, edges);
    const y = (id: string) => laid.find(n => n.id === id)!.position.y;

    expect(y('start')).toBeLessThan(y('p1'));
    expect(y('p1')).toBeLessThan(y('finish'));
    // Three distinct ranks.
    expect(new Set([y('start'), y('p1'), y('finish')]).size).toBe(3);
  });

  it('places sibling nodes in the same rank at the same depth but different x', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'process'),
      node('b', 'process'),
    ];
    const edges = [flowEdge('start', 'a'), flowEdge('start', 'b')];

    const laid = computeAutoLayout(nodes, edges);
    const a = laid.find(n => n.id === 'a')!;
    const b = laid.find(n => n.id === 'b')!;

    expect(a.position.y).toBe(b.position.y);
    expect(a.position.x).not.toBe(b.position.x);
  });

  it('parks an MCP node to the right of its process node', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('m1', 'mcp', -999, -999),
    ];
    const edges = [flowEdge('start', 'p1'), mcpEdge('p1', 'm1')];

    const laid = computeAutoLayout(nodes, edges);
    const p1 = laid.find(n => n.id === 'p1')!;
    const m1 = laid.find(n => n.id === 'm1')!;

    expect(m1.position.x).toBe(p1.position.x + 350);
    expect(m1.position.y).toBe(p1.position.y);
  });

  it('stacks multiple MCP nodes on the same process node', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('m1', 'mcp'),
      node('m2', 'mcp'),
    ];
    const edges = [flowEdge('start', 'p1'), mcpEdge('p1', 'm1'), mcpEdge('p1', 'm2')];

    const laid = computeAutoLayout(nodes, edges);
    const m1 = laid.find(n => n.id === 'm1')!;
    const m2 = laid.find(n => n.id === 'm2')!;

    expect(m1.position.x).toBe(m2.position.x); // both to the right
    expect(m1.position.y).not.toBe(m2.position.y); // stacked vertically
  });

  it('relocates an unattached MCP node out of the packed graph instead of leaving it at a stale position (B5)', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('m1', 'mcp', 123, 456),
    ];
    const edges = [flowEdge('start', 'p1')];

    const laid = computeAutoLayout(nodes, edges);
    // No longer glued to its old (potentially colliding) coordinates...
    expect(laid.find(n => n.id === 'm1')!.position).not.toEqual({ x: 123, y: 456 });
    // ...and does not overlap anything in the freshly packed graph.
    expectNoOverlaps(laid);
  });

  it('does not hang on a bidirectional / cyclic flow', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'process'),
      node('b', 'process'),
    ];
    // a <-> b bidirectional plus a back-edge b -> a create a cycle.
    const edges = [
      flowEdge('start', 'a'),
      flowEdge('a', 'b', true),
      flowEdge('b', 'a'),
    ];

    const laid = computeAutoLayout(nodes, edges);
    expect(laid).toHaveLength(3);
    // Start still ranks above the cycle members.
    const y = (id: string) => laid.find(n => n.id === id)!.position.y;
    expect(y('start')).toBeLessThan(y('a'));
  });

  it('only changes position — id, type, data and the edges array are untouched', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
    ];
    const edges = [flowEdge('start', 'p1')];
    const edgesSnapshot = JSON.parse(JSON.stringify(edges));

    const laid = computeAutoLayout(nodes, edges);

    for (const original of nodes) {
      const result = laid.find(n => n.id === original.id)!;
      expect(result.id).toBe(original.id);
      expect(result.type).toBe(original.type);
      expect(result.data).toEqual(original.data);
    }
    // New array + new node objects (undoable edit), original left intact.
    expect(laid).not.toBe(nodes);
    expect(edges).toEqual(edgesSnapshot);
  });

  it('supports a left-to-right direction option', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('finish', 'finish'),
    ];
    const edges = [flowEdge('start', 'p1'), flowEdge('p1', 'finish')];

    const laid = computeAutoLayout(nodes, edges, { direction: 'LR' });
    const x = (id: string) => laid.find(n => n.id === id)!.position.x;

    expect(x('start')).toBeLessThan(x('p1'));
    expect(x('p1')).toBeLessThan(x('finish'));
  });

  it('never produces overlapping nodes for a process + 3 MCP + 2 sibling processes fixture (the reported bug)', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('p2', 'process'),
      node('m1', 'mcp'),
      node('m2', 'mcp'),
      node('m3', 'mcp'),
    ];
    const edges = [
      flowEdge('start', 'p1'),
      flowEdge('start', 'p2'),
      mcpEdge('p1', 'm1'),
      mcpEdge('p1', 'm2'),
      mcpEdge('p1', 'm3'),
    ];

    const laid = computeAutoLayout(nodes, edges);
    expectNoOverlaps(laid);
  });

  it('never lets a sibling flow node intersect the first node\'s MCP satellite (B1)', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'process'),
      node('b', 'process'),
      node('m1', 'mcp'),
    ];
    const edges = [flowEdge('start', 'a'), flowEdge('start', 'b'), mcpEdge('a', 'm1')];

    const laid = computeAutoLayout(nodes, edges);
    expectNoOverlaps(laid);
  });

  it('stacks tall MCP nodes without overlapping each other or the next rank (B2)', () => {
    const tallMcp = (id: string): FlowNode => ({
      ...node(id, 'mcp'),
      measured: { width: 210, height: 200 },
    } as FlowNode);
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('p2', 'process'),
      tallMcp('m1'),
      tallMcp('m2'),
      tallMcp('m3'),
    ];
    const edges = [
      flowEdge('start', 'p1'),
      flowEdge('p1', 'p2'),
      mcpEdge('p1', 'm1'),
      mcpEdge('p1', 'm2'),
      mcpEdge('p1', 'm3'),
    ];

    const laid = computeAutoLayout(nodes, edges);
    expectNoOverlaps(laid);
    // The MCP stack must not intrude into p2's rank.
    const p1 = laid.find(n => n.id === 'p1')!;
    const p2 = laid.find(n => n.id === 'p2')!;
    const lastMcp = laid.find(n => n.id === 'm3')!;
    expect(lastMcp.position.y + 200).toBeLessThanOrEqual(p2.position.y);
    expect(p1.position.y).toBeLessThan(p2.position.y);
  });

  it('uses the per-type fallback size for unmeasured nodes (B3)', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('m1', 'mcp'), // no `measured` — must use the MCP fallback, not a bare 240x80 guess
    ];
    const edges = [flowEdge('start', 'p1'), mcpEdge('p1', 'm1')];

    const laid = computeAutoLayout(nodes, edges);
    const p1 = laid.find(n => n.id === 'p1')!;
    const m1 = laid.find(n => n.id === 'm1')!;
    // Offset must clear the MCP fallback width, not an undersized guess.
    expect(m1.position.x - p1.position.x).toBeGreaterThanOrEqual(350);
    expectNoOverlaps(laid);
  });

  it('running the layout twice on the same input is deterministic (byte-identical positions)', () => {
    const nodes = [
      node('start', 'start'),
      node('a', 'process'),
      node('b', 'process'),
      node('m1', 'mcp'),
    ];
    const edges = [flowEdge('start', 'a'), flowEdge('start', 'b'), mcpEdge('a', 'm1')];

    const first = computeAutoLayout(nodes, edges);
    const second = computeAutoLayout(nodes, edges);
    expect(first.map(n => n.position)).toEqual(second.map(n => n.position));
  });
});
