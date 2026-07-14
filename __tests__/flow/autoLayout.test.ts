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
import { FlowNode } from '@/frontend/types/flow/flow';

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

  it('leaves an unattached MCP node at its current position', () => {
    const nodes = [
      node('start', 'start'),
      node('p1', 'process'),
      node('m1', 'mcp', 123, 456),
    ];
    const edges = [flowEdge('start', 'p1')];

    const laid = computeAutoLayout(nodes, edges);
    expect(laid.find(n => n.id === 'm1')!.position).toEqual({ x: 123, y: 456 });
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
});
