const getFlowMock = jest.fn();
const saveFlowMock = jest.fn();
jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: (...args: unknown[]) => getFlowMock(...args),
    saveFlow: (...args: unknown[]) => saveFlowMock(...args),
  },
}));

import {
  buildFlowGeneratorSnapshot,
  buildVendoredFlowGenerator,
  ensureVendoredFlowGenerator,
  FLOW_GENERATOR_ID,
  FLOW_GENERATOR_ROLE,
  restoreVendoredFlowGenerator,
} from '@/backend/services/flow/systemFlows';

beforeEach(() => {
  jest.clearAllMocks();
  saveFlowMock.mockResolvedValue({ success: true });
});

describe('vendored Flow Generator', () => {
  it('builds an editable flow with a stable role and only guided authoring tools', () => {
    const flow = buildVendoredFlowGenerator();
    expect(flow.id).toBe(FLOW_GENERATOR_ID);
    const designer = flow.nodes.find((node) => node.type === 'process')!;
    expect(designer.data.properties).toEqual(expect.objectContaining({
      systemRole: FLOW_GENERATOR_ROLE,
      maxTurns: 16,
    }));
    const mcp = flow.nodes.find((node) => node.type === 'mcp')!;
    expect(mcp.data.properties?.enabledTools).toEqual([
      'list_flow_building_blocks',
      'get_flow_authoring_guide',
      'draft_flow',
    ]);
    expect(designer.data.properties?.boundModel).toBeUndefined();
    expect(flow.permissionRules).toEqual([
      { action: 'list_flow_building_blocks', resource: '*', effect: 'allow' },
      { action: 'get_flow_authoring_guide', resource: '*', effect: 'allow' },
      { action: 'draft_flow', resource: '*', effect: 'allow' },
    ]);
  });

  it('seeds only when missing and never overwrites an edited flow', async () => {
    const edited = { ...buildVendoredFlowGenerator(), description: 'my edited generator' };
    getFlowMock.mockResolvedValueOnce(edited);
    expect(await ensureVendoredFlowGenerator()).toBe(edited);
    expect(saveFlowMock).not.toHaveBeenCalled();

    getFlowMock.mockResolvedValueOnce(null);
    const seeded = await ensureVendoredFlowGenerator();
    expect(seeded.id).toBe(FLOW_GENERATOR_ID);
    expect(saveFlowMock).toHaveBeenCalledTimes(1);
  });

  it('restores only through the explicit restore operation', async () => {
    await restoreVendoredFlowGenerator();
    expect(saveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW_GENERATOR_ID }));
  });

  it('clones the latest edited flow and patches the selected model only in the snapshot', async () => {
    const source = buildVendoredFlowGenerator();
    getFlowMock.mockResolvedValue(source);
    const snapshot = await buildFlowGeneratorSnapshot('conversation-1', 'model-9');
    expect(snapshot.id).toBe('quickchat-flow-generator-conversation-1');
    expect(snapshot.nodes.find((node) => node.type === 'process')?.data.properties?.boundModel)
      .toBe('model-9');
    expect(source.nodes.find((node) => node.type === 'process')?.data.properties?.boundModel)
      .toBeUndefined();
  });
});
