import { FlowService } from '@/backend/services/flow';
import type { Flow, FlowNode } from '@/shared/types/flow';

function node(
  id: string,
  type: string,
  properties: Record<string, unknown>,
  label = id,
): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, type, properties },
  } as FlowNode;
}

function flow(id: string, nodes: FlowNode[]): Flow {
  return { id, name: id, nodes, edges: [] };
}

describe('FlowService.migrateMcpServerReferences', () => {
  afterEach(() => jest.restoreAllMocks());

  it('migrates every matching boundServer and saves only affected flows', async () => {
    const service = new FlowService();
    const affected = flow('affected', [
      node('mcp', 'mcp', { boundServer: 'old', enabledTools: ['search'] }, 'Custom MCP label'),
      node('resource', 'resource', { scope: 'mcp', boundServer: 'old', uri: 'file:///notes' }),
      node('other', 'mcp', { boundServer: 'different' }),
    ]);
    const unaffected = flow('unaffected', [node('mcp-2', 'mcp', { boundServer: 'different' })]);
    jest.spyOn(service, 'loadFlows').mockResolvedValue([affected, unaffected]);
    const save = jest.spyOn(service, 'saveFlow').mockResolvedValue({ success: true });

    const result = await service.migrateMcpServerReferences('old', 'new');

    expect(result).toEqual({ success: true, migratedFlows: 1, migratedReferences: 2 });
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0];
    expect(saved.id).toBe('affected');
    expect(saved.nodes[0].data.properties).toEqual({
      boundServer: 'new',
      enabledTools: ['search'],
    });
    expect(saved.nodes[0].data.label).toBe('Custom MCP label');
    expect(saved.nodes[1].data.properties).toEqual({
      scope: 'mcp',
      boundServer: 'new',
      uri: 'file:///notes',
    });
    expect(saved.nodes[2].data.properties?.boundServer).toBe('different');

    // The load result may be the shared flow cache; migration must not mutate it
    // before saveFlow has durably persisted the cloned replacement.
    expect(affected.nodes[0].data.properties?.boundServer).toBe('old');
    expect(affected.nodes[1].data.properties?.boundServer).toBe('old');
  });

  it('reports failed flow saves without counting their references as migrated', async () => {
    const service = new FlowService();
    jest.spyOn(service, 'loadFlows').mockResolvedValue([
      flow('ok', [node('m1', 'mcp', { boundServer: 'old' })]),
      flow('failed', [
        node('m2', 'mcp', { boundServer: 'old' }),
        node('r2', 'resource', { boundServer: 'old' }),
      ]),
    ]);
    jest.spyOn(service, 'saveFlow')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'disk full' });

    const result = await service.migrateMcpServerReferences('old', 'new');

    expect(result).toEqual({
      success: false,
      error: 'Failed to migrate MCP server references in 1 flow(s)',
      migratedFlows: 1,
      migratedReferences: 1,
      failedFlowIds: ['failed'],
    });
  });

  it('is a no-op when the name did not change', async () => {
    const service = new FlowService();
    const load = jest.spyOn(service, 'loadFlows');
    const save = jest.spyOn(service, 'saveFlow');

    await expect(service.migrateMcpServerReferences('same', 'same')).resolves.toEqual({
      success: true,
      migratedFlows: 0,
      migratedReferences: 0,
    });
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
