/**
 * getStartNode / getStartNodeId tests (issue #174).
 *
 * The flow "start" node is identified by its TYPE (`type === 'start'`), never by
 * array position. Flows can be reordered in the builder, produced by the
 * generator, or imported/auto-repaired, so `nodes[0]` is not reliably the start
 * node. These tests pin that contract, plus graceful handling of missing/absent
 * flows and the `data.type` fallback shape.
 */
import { getStartNode, getStartNodeId } from '@/utils/shared/getStartNode';
import type { Flow, FlowNode } from '@/shared/types/flow';

function pnode(id: string, type: string): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type } } as FlowNode;
}

function flowOf(nodes: FlowNode[]): Flow {
  return { id: 'f1', name: 'f', nodes, edges: [] } as unknown as Flow;
}

describe('getStartNode / getStartNodeId', () => {
  it('finds the start node even when it is NOT at index 0 (reordered flow)', () => {
    const flow = flowOf([pnode('p1', 'process'), pnode('s1', 'start'), pnode('f1', 'finish')]);
    expect(getStartNode(flow)?.id).toBe('s1');
    expect(getStartNodeId(flow)).toBe('s1');
    // Explicitly NOT the array-position node.
    expect(getStartNodeId(flow)).not.toBe(flow.nodes[0].id);
  });

  it('finds the start node when it is at index 0 (baseline unchanged)', () => {
    const flow = flowOf([pnode('s1', 'start'), pnode('p1', 'process')]);
    expect(getStartNode(flow)?.id).toBe('s1');
    expect(getStartNodeId(flow)).toBe('s1');
  });

  it('returns undefined when there is no start node', () => {
    const flow = flowOf([pnode('p1', 'process'), pnode('f1', 'finish')]);
    expect(getStartNode(flow)).toBeUndefined();
    expect(getStartNodeId(flow)).toBeUndefined();
  });

  it('returns undefined (no throw) for null/undefined flow or missing nodes', () => {
    expect(getStartNode(undefined)).toBeUndefined();
    expect(getStartNode(null)).toBeUndefined();
    expect(getStartNodeId(undefined)).toBeUndefined();
    expect(getStartNode({ id: 'x', name: 'x' } as unknown as Flow)).toBeUndefined();
  });

  it('falls back to data.type when top-level type is absent', () => {
    const node = { id: 's1', position: { x: 0, y: 0 }, data: { label: 's1', type: 'start' } } as FlowNode;
    const flow = flowOf([pnode('p1', 'process'), node]);
    expect(getStartNode(flow)?.id).toBe('s1');
    expect(getStartNodeId(flow)).toBe('s1');
  });
});
