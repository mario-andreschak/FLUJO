/**
 * Tests for the FlowBuilder canvas edge helpers
 * (src/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/edgeUtils.ts).
 *
 * Covers the connection-uniqueness rules: one MCP edge per Process/MCP node
 * pair regardless of side or handle, one flow-control edge per direction, and
 * handle-aware edge ids so parallel edges never collide.
 */
import { Connection, Edge } from '@xyflow/react';
import {
  validateConnection,
  createEdgeFromConnection,
  getReplacedEdgeIds,
  canConvertToBidirectional,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/edgeUtils';
import { validTargetTypesFor } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/connectionRules';
import { FlowNode } from '@/frontend/types/flow/flow';

const node = (id: string, type: string): FlowNode =>
  ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: id, type },
  } as FlowNode);

const nodes = [node('start', 'start'), node('p1', 'process'), node('p2', 'process'), node('m1', 'mcp')];

const connect = (
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string
): Connection => ({ source, sourceHandle, target, targetHandle });

describe('createEdgeFromConnection', () => {
  it('gives edges between the same pair via different handles distinct ids', () => {
    const left = createEdgeFromConnection(connect('p1', 'process-left-mcp', 'm1', 'mcp-right'), nodes);
    const right = createEdgeFromConnection(connect('p1', 'process-right-mcp', 'm1', 'mcp-left'), nodes);
    expect(left.id).not.toBe(right.id);
  });

  it('types MCP-handle connections as mcp edges and others as standard', () => {
    const mcp = createEdgeFromConnection(connect('p1', 'process-left-mcp', 'm1', 'mcp-right'), nodes);
    expect(mcp.type).toBe('mcpEdge');
    expect((mcp.data as any).edgeType).toBe('mcp');

    const std = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    expect(std.type).toBe('custom');
    expect((std.data as any).edgeType).toBe('standard');
  });

  it('omits condition by default (byte-identical to the compiler for a plain edge)', () => {
    const std = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    expect(std.data).toEqual({ edgeType: 'standard' });
  });

  it('carries a Tier 2b condition into data when supplied (kept in sync with controlEdge)', () => {
    const cond = { kind: 'contains' as const, value: 'FAIL' };
    const std = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes, cond);
    expect(std.data).toEqual({ edgeType: 'standard', condition: cond });
  });
});

describe('getReplacedEdgeIds', () => {
  it('replaces an existing MCP edge between the same pair drawn from the other side', () => {
    const existing = createEdgeFromConnection(connect('p1', 'process-left-mcp', 'm1', 'mcp-right'), nodes);
    // Re-connect the same pair from the node's other side, reversed direction.
    const redrawn = createEdgeFromConnection(connect('m1', 'mcp-left', 'p1', 'process-right-mcp'), nodes);
    expect(getReplacedEdgeIds(redrawn, [existing])).toEqual([existing.id]);
  });

  it('replaces a same-direction flow-control duplicate', () => {
    const existing = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    const duplicate = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    expect(getReplacedEdgeIds(duplicate, [existing])).toEqual([existing.id]);
  });

  it('keeps the opposite-direction flow-control edge (A->B and B->A are distinct)', () => {
    const forward = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    const backward = createEdgeFromConnection(connect('p2', 'process-bottom', 'p1', 'process-top'), nodes);
    expect(getReplacedEdgeIds(backward, [forward])).toEqual([]);
  });

  it('does not replace edges of other node pairs', () => {
    const other = createEdgeFromConnection(connect('p2', 'process-left-mcp', 'm1', 'mcp-right'), nodes);
    const incoming = createEdgeFromConnection(connect('p1', 'process-left-mcp', 'm1', 'mcp-left'), nodes);
    expect(getReplacedEdgeIds(incoming, [other])).toEqual([]);
  });

  it('does not let an MCP edge replace a flow-control edge between the same pair', () => {
    const std: Edge = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    const mcp = createEdgeFromConnection(connect('p1', 'process-left-mcp', 'm1', 'mcp-right'), nodes);
    expect(getReplacedEdgeIds(mcp, [std])).toEqual([]);
  });
});

describe('validateConnection', () => {
  it('rejects connections into a Start node and out of a Finish node', () => {
    const withFinish = [...nodes, node('f1', 'finish')];
    expect(validateConnection(connect('p1', 'process-bottom', 'start', 'start-top'), withFinish)).toBe(false);
    expect(validateConnection(connect('f1', 'finish-bottom', 'p1', 'process-top'), withFinish)).toBe(false);
  });

  it('rejects an MCP node connecting to anything but a Process node', () => {
    const withFinish = [...nodes, node('f1', 'finish')];
    expect(validateConnection(connect('m1', 'mcp-left', 'p1', 'process-right-mcp'), nodes)).toBe(true);
    expect(validateConnection(connect('m1', 'mcp-left', 'f1', 'finish-top'), withFinish)).toBe(false);
  });

  it('rejects an MCP handle used for flow control between two Process nodes', () => {
    expect(validateConnection(connect('p1', 'process-left-mcp', 'p2', 'process-top'), nodes)).toBe(false);
  });
});

describe('validateConnection — subflow single outgoing path', () => {
  const withSubflow = [...nodes, node('s1', 'subflow'), node('f1', 'finish')];
  const bidi = (e: Edge): Edge => ({ ...e, data: { ...e.data, bidirectional: true } });

  it('allows the first outgoing edge from a subflow', () => {
    expect(validateConnection(connect('s1', 'subflow-bottom', 'p1', 'process-top'), withSubflow, [])).toBe(true);
  });

  it('rejects a second outgoing edge from a subflow', () => {
    const existing = createEdgeFromConnection(connect('s1', 'subflow-bottom', 'p1', 'process-top'), withSubflow);
    expect(validateConnection(connect('s1', 'subflow-bottom', 'p2', 'process-top'), withSubflow, [existing])).toBe(false);
  });

  it('rejects an outgoing edge when a bidirectional edge already points at the subflow', () => {
    const back = bidi(createEdgeFromConnection(connect('p1', 'process-bottom', 's1', 'subflow-top'), withSubflow));
    expect(validateConnection(connect('s1', 'subflow-bottom', 'f1', 'finish-top'), withSubflow, [back])).toBe(false);
  });

  it('still allows re-drawing the existing outgoing edge (replacement, not addition)', () => {
    const existing = createEdgeFromConnection(connect('s1', 'subflow-bottom', 'p1', 'process-top'), withSubflow);
    expect(validateConnection(connect('s1', 'subflow-bottom', 'p1', 'process-top'), withSubflow, [existing])).toBe(true);
  });

  it('does not restrict Process nodes with multiple outgoing edges', () => {
    const existing = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), withSubflow);
    expect(validateConnection(connect('p1', 'process-bottom', 'f1', 'finish-top'), withSubflow, [existing])).toBe(true);
  });
});

describe('canConvertToBidirectional', () => {
  it('allows upgrading an edge between two Process nodes', () => {
    const edge = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    expect(canConvertToBidirectional(edge, nodes)).toBe(true);
  });

  it('allows upgrading an edge between Process and Subflow nodes', () => {
    const withSubflow = [...nodes, node('s1', 'subflow')];
    const edge = createEdgeFromConnection(connect('p1', 'process-bottom', 's1', 'subflow-top'), withSubflow);
    expect(canConvertToBidirectional(edge, withSubflow)).toBe(true);
  });

  it('rejects upgrading an edge out of a Start node (nothing may hand back to Start)', () => {
    const edge = createEdgeFromConnection(connect('start', 'start-bottom', 'p1', 'process-top'), nodes);
    expect(canConvertToBidirectional(edge, nodes)).toBe(false);
  });

  it('rejects upgrading an edge into a Finish node (Finish never hands off)', () => {
    const withFinish = [...nodes, node('f1', 'finish')];
    const edge = createEdgeFromConnection(connect('p1', 'process-bottom', 'f1', 'finish-top'), withFinish);
    expect(canConvertToBidirectional(edge, withFinish)).toBe(false);
  });

  it('rejects when an endpoint node no longer exists', () => {
    const edge = createEdgeFromConnection(connect('p1', 'process-bottom', 'p2', 'process-top'), nodes);
    expect(canConvertToBidirectional(edge, nodes.filter(n => n.id !== 'p2'))).toBe(false);
  });

  it('rejects upgrading an edge into a subflow that already has an outgoing edge', () => {
    const withSubflow = [...nodes, node('s1', 'subflow')];
    const intoSubflow = createEdgeFromConnection(connect('p1', 'process-bottom', 's1', 'subflow-top'), withSubflow);
    const onward = createEdgeFromConnection(connect('s1', 'subflow-bottom', 'p2', 'process-top'), withSubflow);
    expect(canConvertToBidirectional(intoSubflow, withSubflow, [intoSubflow, onward])).toBe(false);
    // Without the onward edge the same upgrade is fine (call-and-return shape).
    expect(canConvertToBidirectional(intoSubflow, withSubflow, [intoSubflow])).toBe(true);
  });
});

describe('validTargetTypesFor', () => {
  it('agrees with validateConnection for every source/handle combination', () => {
    expect(validTargetTypesFor('mcp', 'mcp-bottom')).toEqual(['process']);
    expect(validTargetTypesFor('process', 'process-left-mcp')).toEqual(['mcp']);
    // `signal` is a real intermediate flow-control target reachable from any
    // plain control-flow source; it is appended last by the `all` filter order
    // (process, finish, mcp, subflow, resource, signal).
    expect(validTargetTypesFor('process', 'process-bottom')).toEqual(['process', 'finish', 'subflow', 'signal']);
    expect(validTargetTypesFor('start', 'start-bottom')).toEqual(['process', 'finish', 'subflow', 'signal']);
    expect(validTargetTypesFor('subflow', 'subflow-bottom')).toEqual(['process', 'finish', 'subflow', 'signal']);
    expect(validTargetTypesFor('finish', 'finish-top')).toEqual([]);
  });
});
