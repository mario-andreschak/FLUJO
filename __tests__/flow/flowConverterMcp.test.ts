import { FlowConverter } from '@/backend/execution/flow/FlowConverter';
import { BaseNode } from '@/backend/execution/flow/pocketflow';
import type { Flow as ReactFlow } from '@/frontend/types/flow/flow';

function buildFlow(): ReactFlow {
  return {
    id: 'flow-mcp',
    name: 'mcp flow',
    nodes: [
      {
        id: 'start', type: 'start', position: { x: 0, y: 0 },
        data: { label: 'start', type: 'start', properties: { promptTemplate: '' } },
      },
      {
        id: 'proc', type: 'process', position: { x: 0, y: 100 },
        data: {
          label: 'proc', type: 'process',
          properties: {
            boundModel: 'model',
            mcpNodes: [{ id: 'stale', properties: { boundServer: 'old' } }],
          },
        },
      },
      {
        id: 'mcp', type: 'mcp', position: { x: 200, y: 100 },
        data: {
          label: 'mcp', type: 'mcp',
          properties: { boundServer: 'current', enabledTools: ['get_me'] },
        },
      },
      {
        id: 'finish', type: 'finish', position: { x: 0, y: 200 },
        data: { label: 'finish', type: 'finish', properties: {} },
      },
    ],
    edges: [
      { id: 'start->proc', source: 'start', target: 'proc', data: { edgeType: 'standard' } },
      { id: 'proc->finish', source: 'proc', target: 'finish', data: { edgeType: 'standard' } },
      { id: 'proc->mcp:1', source: 'proc', target: 'mcp', data: { edgeType: 'mcp' } },
      { id: 'proc->mcp:2', source: 'proc', target: 'mcp', data: { edgeType: 'mcp' } },
    ],
  } as unknown as ReactFlow;
}

function processNode(flow: unknown): BaseNode {
  const start = (flow as { start: BaseNode }).start;
  const successors = start.successors instanceof Map ? [...start.successors.values()] : [];
  return successors[0] as BaseNode;
}

describe('FlowConverter MCP attachment derivation', () => {
  it('rebuilds and deduplicates mcpNodes without mutating the source flow', () => {
    const source = buildFlow();

    const first = processNode(FlowConverter.convert(source));
    const second = processNode(FlowConverter.convert(source));

    const expected = [{
      id: 'mcp',
      properties: expect.objectContaining({ boundServer: 'current' }),
    }];
    expect(first.node_params.properties.mcpNodes).toEqual(expected);
    expect(second.node_params.properties.mcpNodes).toEqual(expected);
    expect((source.nodes.find(({ id }) => id === 'proc')!.data.properties as { mcpNodes: unknown[] }).mcpNodes)
      .toEqual([{ id: 'stale', properties: { boundServer: 'old' } }]);
  });

  it('derives MCP references for static real-tool consumers too', () => {
    const source = buildFlow();
    source.nodes.splice(2, 0, {
      id: 'static', type: 'static', position: { x: 0, y: 150 },
      data: {
        label: 'static', type: 'static',
        properties: {
          entries: [{ kind: 'toolCall', executionMode: 'real', serverName: 'current', toolName: 'get_me', argumentsJson: '{}', result: '' }],
          mcpNodes: [{ id: 'stale', properties: { boundServer: 'old' } }],
        },
      },
    } as any);
    source.edges.push({ id: 'static->mcp', source: 'static', target: 'mcp', data: { edgeType: 'mcp' } } as any);
    source.edges = source.edges.map((edge) => edge.id === 'proc->finish'
      ? { ...edge, target: 'static' }
      : edge);
    source.edges.push({ id: 'static->finish', source: 'static', target: 'finish', data: { edgeType: 'standard' } } as any);

    const converted = FlowConverter.convert(source);
    const proc = processNode(converted);
    const stat = [...proc.successors.values()][0] as BaseNode;

    expect(stat.node_params.type).toBe('static');
    expect(stat.node_params.properties.mcpNodes).toEqual([{
      id: 'mcp',
      properties: expect.objectContaining({ boundServer: 'current', enabledTools: ['get_me'] }),
    }]);
    expect((source.nodes.find(({ id }) => id === 'static')!.data.properties as any).mcpNodes)
      .toEqual([{ id: 'stale', properties: { boundServer: 'old' } }]);
  });
});
