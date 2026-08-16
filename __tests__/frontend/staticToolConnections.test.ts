import type { Edge } from '@xyflow/react';
import type { FlowNode } from '@/frontend/types/flow/flow';
import { reconcileStaticToolConnections } from '@/frontend/components/Flow/FlowManager/FlowBuilder/utils/staticToolConnections';

const node = (id: string, type: string, properties: Record<string, unknown> = {}): FlowNode => ({
  id,
  type,
  position: { x: type === 'static' ? 100 : 450, y: 100 },
  data: { label: id, type, properties },
} as FlowNode);

const makeMcp = jest.fn((serverName: string, position: { x: number; y: number }) => ({
  ...node(`mcp-${serverName}`, 'mcp'),
  position,
}));

describe('reconcileStaticToolConnections', () => {
  beforeEach(() => makeMcp.mockClear());

  it('creates one MCP attachment per server and merges multiple real tools', () => {
    const stat = node('static', 'static');
    const result = reconcileStaticToolConnections({
      staticNodeId: stat.id,
      entries: [
        { kind: 'toolCall', executionMode: 'real', serverName: 'files', toolName: 'read_file' },
        { kind: 'toolCall', executionMode: 'real', serverName: 'files', toolName: 'write_file' },
        { kind: 'toolCall', executionMode: 'mock', serverName: 'files', toolName: 'delete_file' },
      ],
      nodes: [stat],
      edges: [],
      createMcpNode: makeMcp,
    });

    expect(makeMcp).toHaveBeenCalledTimes(1);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[1].data.properties).toMatchObject({
      boundServer: 'files',
      enabledTools: ['read_file', 'write_file'],
    });
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      source: 'static',
      sourceHandle: 'static-right-mcp',
      target: 'mcp-files',
      targetHandle: 'mcp-left',
      data: { edgeType: 'mcp' },
    });
  });

  it('reuses a connected server node, preserves enabled tools, and removes obsolete orphan attachments', () => {
    const stat = node('static', 'static');
    const files = node('files', 'mcp', { boundServer: 'files', enabledTools: ['list_files'] });
    const old = node('old', 'mcp', { boundServer: 'old', enabledTools: ['old_tool'] });
    const edges: Edge[] = [
      { id: 'files-edge', source: 'static', sourceHandle: 'static-right-mcp', target: 'files', targetHandle: 'mcp-left', data: { edgeType: 'mcp' } },
      { id: 'old-edge', source: 'static', sourceHandle: 'static-right-mcp', target: 'old', targetHandle: 'mcp-left', data: { edgeType: 'mcp' } },
    ];

    const result = reconcileStaticToolConnections({
      staticNodeId: stat.id,
      entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'files', toolName: 'read_file' }],
      nodes: [stat, files, old],
      edges,
      createMcpNode: makeMcp,
    });

    expect(makeMcp).not.toHaveBeenCalled();
    expect(result.nodes.map((candidate) => candidate.id)).toEqual(['static', 'files']);
    expect(result.nodes[1].data.properties?.enabledTools).toEqual(['list_files', 'read_file']);
    expect(result.edges.map((edge) => edge.id)).toEqual(['files-edge']);
  });
});
