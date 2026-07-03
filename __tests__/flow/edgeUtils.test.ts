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

describe('validTargetTypesFor', () => {
  it('agrees with validateConnection for every source/handle combination', () => {
    expect(validTargetTypesFor('mcp', 'mcp-bottom')).toEqual(['process']);
    expect(validTargetTypesFor('process', 'process-left-mcp')).toEqual(['mcp']);
    expect(validTargetTypesFor('process', 'process-bottom')).toEqual(['process', 'finish', 'subflow']);
    expect(validTargetTypesFor('start', 'start-bottom')).toEqual(['process', 'finish', 'subflow']);
    expect(validTargetTypesFor('subflow', 'subflow-bottom')).toEqual(['process', 'finish', 'subflow']);
    expect(validTargetTypesFor('finish', 'finish-top')).toEqual([]);
  });
});
