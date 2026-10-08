import { FlowConverter } from '@/backend/execution/flow/FlowConverter';
import { BaseNode } from '@/backend/execution/flow/pocketflow';
import { personaCoreAppNodeId } from '@/backend/services/enduringAgents/personaCoreAppIdentity';
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

function mcpNodes(node: BaseNode): unknown {
  return (node.node_params.properties as { mcpNodes?: unknown }).mcpNodes;
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
    expect(mcpNodes(first)).toEqual(expected);
    expect(mcpNodes(second)).toEqual(expected);
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
    expect(mcpNodes(stat)).toEqual([{
      id: 'mcp',
      properties: expect.objectContaining({ boundServer: 'current', enabledTools: ['get_me'] }),
    }]);
    expect((source.nodes.find(({ id }) => id === 'static')!.data.properties as any).mcpNodes)
      .toEqual([{ id: 'stale', properties: { boundServer: 'old' } }]);
  });

  it('preserves only exact runtime-authorized Persona App bindings', () => {
    const source = buildFlow();
    const personalComputerId = personaCoreAppNodeId('personal-computer');
    const currentAppId = personaCoreAppNodeId('current');
    const browserId = personaCoreAppNodeId('browser');
    const sourceMcpNodes = [
      {
        id: personalComputerId,
        properties: {
          boundServer: 'personal-computer',
          enabledTools: ['sandbox_exec', 'sandbox_exec', '', 42],
          enabledResources: ['ui://computer/dashboard', 'ui://computer/dashboard', 42],
          roots: ['C:\\should-not-survive'],
          toolParameterPresets: { sandbox_exec: { cwd: 'C:\\should-not-survive' } },
          toolTimeout: -1,
          env: { SECRET: 'should-not-survive' },
        },
      },
      // The graph-authored `current` attachment below must replace this broader
      // projected policy for the same server.
      {
        id: currentAppId,
        properties: { boundServer: 'current', enabledTools: ['too_broad'] },
      },
      // A deterministic-looking id is insufficient: both id and server must
      // match the out-of-band binding manifest.
      {
        id: browserId,
        properties: { boundServer: 'wrong-server', enabledTools: ['forged'] },
      },
      { id: 'stale', properties: { boundServer: 'old', enabledTools: ['old_tool'] } },
    ];
    (source.nodes.find(({ id }) => id === 'proc')!.data.properties as any).mcpNodes = sourceMcpNodes;

    const defaultConverted = processNode(FlowConverter.convert(source));
    expect(mcpNodes(defaultConverted)).toEqual([{
      id: 'mcp',
      properties: expect.objectContaining({ boundServer: 'current', enabledTools: ['get_me'] }),
    }]);

    const trustedInlineMcpBindings = new Map([
      [personalComputerId, 'personal-computer'],
      [currentAppId, 'current'],
      [browserId, 'browser'],
    ]);
    const converted = processNode(FlowConverter.convert(source, { trustedInlineMcpBindings }));

    expect(mcpNodes(converted)).toEqual([
      {
        id: personalComputerId,
        properties: {
          boundServer: 'personal-computer',
          enabledTools: ['sandbox_exec'],
          enabledResources: ['ui://computer/dashboard'],
        },
      },
      {
        id: 'mcp',
        properties: expect.objectContaining({ boundServer: 'current', enabledTools: ['get_me'] }),
      },
    ]);
    expect((source.nodes.find(({ id }) => id === 'proc')!.data.properties as any).mcpNodes)
      .toEqual(sourceMcpNodes);
  });
});
