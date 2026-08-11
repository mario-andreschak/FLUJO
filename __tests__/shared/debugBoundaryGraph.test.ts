import type { DebugBoundary } from '@/backend/execution/flow/types';
import { debugBoundaryEdgeIds } from '@/utils/shared/debugBoundaryGraph';

const stateSnapshot = { messageCount: 1 };

function boundary(overrides: Partial<DebugBoundary>): DebugBoundary {
  return {
    index: 1,
    operation: 'node',
    phase: 'before',
    timestamp: '2026-08-11T00:00:00.000Z',
    stateSnapshot,
    ...overrides,
  };
}

const edges = [
  { id: 'control-a-b', source: 'process-a', target: 'process-b' },
  { id: 'tool-files', source: 'process-a', target: 'mcp-files' },
  { id: 'tool-web', source: 'mcp-web', target: 'process-a' },
  { id: 'other-tool', source: 'process-b', target: 'mcp-files' },
];

describe('debugBoundaryEdgeIds', () => {
  it('selects the exact authored handoff edge', () => {
    expect([...debugBoundaryEdgeIds(boundary({
      operation: 'handoff',
      edgeId: 'control-a-b',
    }), edges)]).toEqual(['control-a-b']);
  });

  it('keeps the traversed edge lit at the target node BEFORE boundary', () => {
    expect([...debugBoundaryEdgeIds(boundary({
      operation: 'node',
      nodeId: 'process-b',
      edgeId: 'control-a-b',
    }), edges)]).toEqual(['control-a-b']);
  });

  it('selects every MCP edge involved in a tool batch, in either direction', () => {
    expect([...debugBoundaryEdgeIds(boundary({
      operation: 'tool',
      nodeId: 'process-a',
      toolNodeIds: ['mcp-files', 'mcp-web'],
    }), edges)]).toEqual(['tool-files', 'tool-web']);
  });

  it('does not light another process node wired to the same MCP node', () => {
    expect([...debugBoundaryEdgeIds(boundary({
      operation: 'tool',
      nodeId: 'process-b',
      toolNodeIds: ['mcp-files'],
    }), edges)]).toEqual(['other-tool']);
  });
});
