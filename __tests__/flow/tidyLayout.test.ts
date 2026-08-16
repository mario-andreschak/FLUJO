/**
 * Tests for the FlowBuilder "Tidy up" position-preserving de-overlap pass
 * (src/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/tidyLayout.ts),
 * introduced to fix issue #373: auto-align used to discard a clean, hand-
 * arranged layout. Tidy keeps every node roughly where the user put it and
 * only resolves actual collisions.
 */
import { Edge } from '@xyflow/react';
import { computeTidyLayout } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/tidyLayout';
import { hasOverlaps } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/layoutGeometry';
import { FlowNode } from '@/frontend/types/flow/flow';

const node = (id: string, type: string, x = 0, y = 0): FlowNode =>
  ({
    id,
    type,
    position: { x, y },
    data: { label: id, type },
  } as FlowNode);

const flowEdge = (source: string, target: string): Edge =>
  ({
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: `${source}-bottom`,
    targetHandle: `${target}-top`,
    data: { edgeType: 'standard' },
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

function expectNoOverlaps(nodes: FlowNode[]) {
  expect(hasOverlaps(nodes)).toBe(false);
}

describe('computeTidyLayout', () => {
  it('returns the nodes unchanged when there are 0 or 1 nodes', () => {
    expect(computeTidyLayout([], [])).toEqual([]);
    const single = [node('a', 'process', 5, 5)];
    expect(computeTidyLayout(single, [])).toBe(single);
  });

  it('is idempotent on an already non-overlapping (even off-grid) layout', () => {
    const nodes = [
      node('start', 'start', 13, 7),
      node('a', 'process', 13, 500),
      node('b', 'process', 900, 500),
      node('c', 'process', 13, 1000),
    ];
    const tidy = computeTidyLayout(nodes, []);
    for (const original of nodes) {
      const result = tidy.find(n => n.id === original.id)!;
      expect(result.position).toEqual(original.position);
    }
  });

  it('resolves a pile of nodes at the same coordinate into a non-overlapping arrangement', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 0, 0),
      node('c', 'process', 0, 0),
      node('d', 'process', 0, 0),
      node('e', 'process', 0, 0),
    ];
    const tidy = computeTidyLayout(nodes, []);
    expectNoOverlaps(tidy);
    // Displacement stays bounded — nothing flies off to infinity.
    for (const n of tidy) {
      expect(Math.abs(n.position.x)).toBeLessThan(5000);
      expect(Math.abs(n.position.y)).toBeLessThan(5000);
    }
  });

  it('preserves relative left-to-right and top-to-bottom ordering while resolving an overlap', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 50, 10), // overlaps `a`, but starts to the right/below
    ];
    const tidy = computeTidyLayout(nodes, []);
    expectNoOverlaps(tidy);
    const a = tidy.find(n => n.id === 'a')!;
    const b = tidy.find(n => n.id === 'b')!;
    expect(a.position.x).toBeLessThanOrEqual(b.position.x);
  });

  it('moves an MCP satellite by the same delta as its parent process node', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 0, 0), // forces `a` to move
      node('m1', 'mcp', 350, 0), // attached to `a`, offset by 350
    ];
    const edges = [mcpEdge('a', 'm1')];

    const tidy = computeTidyLayout(nodes, edges);
    const a = tidy.find(n => n.id === 'a')!;
    const m1 = tidy.find(n => n.id === 'm1')!;
    expect(m1.position.x - a.position.x).toBe(350);
    expect(m1.position.y - a.position.y).toBe(0);
    expectNoOverlaps(tidy);
  });

  it('never produces overlapping nodes for a process + 3 MCP + 2 sibling processes fixture', () => {
    const nodes = [
      node('start', 'start', 0, 0),
      node('p1', 'process', 0, 200),
      node('p2', 'process', 20, 210), // deliberately close to p1
      node('m1', 'mcp', 40, 200),
      node('m2', 'mcp', 45, 205),
      node('m3', 'mcp', 50, 210),
    ];
    const edges = [
      flowEdge('start', 'p1'),
      flowEdge('start', 'p2'),
      mcpEdge('p1', 'm1'),
      mcpEdge('p1', 'm2'),
      mcpEdge('p1', 'm3'),
    ];
    const tidy = computeTidyLayout(nodes, edges);
    expectNoOverlaps(tidy);
  });

  it('resolves overlaps between satellites attached to different clusters (cluster-vs-cluster)', () => {
    // Two process nodes, each with an MCP satellite, placed so the satellites
    // themselves collide even though the parents do not.
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 800, 0),
      node('m1', 'mcp', 300, 0), // attached to a
      node('m2', 'mcp', 320, 5), // attached to b, overlaps m1
    ];
    const edges = [mcpEdge('a', 'm1'), mcpEdge('b', 'm2')];

    const tidy = computeTidyLayout(nodes, edges);
    expectNoOverlaps(tidy);
    // Offsets to their respective parents are preserved even though the
    // clusters had to move apart.
    const a = tidy.find(n => n.id === 'a')!;
    const b = tidy.find(n => n.id === 'b')!;
    const m1 = tidy.find(n => n.id === 'm1')!;
    const m2 = tidy.find(n => n.id === 'm2')!;
    expect(m1.position.x - a.position.x).toBe(300);
    expect(m1.position.y - a.position.y).toBe(0);
    expect(m2.position.x - b.position.x).toBe(320 - 800);
    expect(m2.position.y - b.position.y).toBe(5);
  });

  it('resolves overlaps between satellites attached to the same parent (intra-cluster)', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('m1', 'mcp', 300, 0),
      node('m2', 'mcp', 305, 5), // deliberately overlaps m1
      node('m3', 'mcp', 310, 10), // deliberately overlaps m1 and m2
    ];
    const edges = [mcpEdge('a', 'm1'), mcpEdge('a', 'm2'), mcpEdge('a', 'm3')];

    const tidy = computeTidyLayout(nodes, edges);
    expectNoOverlaps(tidy);
  });

  it('running tidy twice on the same input is deterministic (byte-identical positions)', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 5, 5),
      node('c', 'process', 10, 10),
    ];
    const first = computeTidyLayout(nodes, []);
    const second = computeTidyLayout(nodes, []);
    expect(first.map(n => n.position)).toEqual(second.map(n => n.position));
  });

  it('only changes position — id, type and data are untouched, and a new array is returned', () => {
    const nodes = [
      node('a', 'process', 0, 0),
      node('b', 'process', 0, 0),
    ];
    const tidy = computeTidyLayout(nodes, []);
    for (const original of nodes) {
      const result = tidy.find(n => n.id === original.id)!;
      expect(result.id).toBe(original.id);
      expect(result.type).toBe(original.type);
      expect(result.data).toEqual(original.data);
    }
    expect(tidy).not.toBe(nodes);
  });
});
