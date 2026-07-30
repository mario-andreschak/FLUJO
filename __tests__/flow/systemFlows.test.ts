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
  it('builds editable architect and compiler stages with advanced authoring tools', () => {
    const flow = buildVendoredFlowGenerator();
    expect(flow.id).toBe(FLOW_GENERATOR_ID);
    const stages = flow.nodes.filter((node) => node.type === 'process');
    expect(stages).toHaveLength(2);
    expect(stages.map((stage) => stage.data.properties)).toEqual([
      expect.objectContaining({
        systemRole: FLOW_GENERATOR_ROLE,
        systemStage: 'architect',
        systemFlowVersion: 3,
        maxTurns: 12,
      }),
      expect.objectContaining({
        systemRole: FLOW_GENERATOR_ROLE,
        systemStage: 'compiler',
        systemFlowVersion: 3,
        maxTurns: 16,
      }),
    ]);
    const enabledTools = flow.nodes
      .filter((node) => node.type === 'mcp')
      .flatMap((node) => node.data.properties?.enabledTools ?? []);
    expect(enabledTools).toEqual(expect.arrayContaining([
      'list_flow_building_blocks',
      'get_flow_authoring_guide',
      'draft_generated_flow',
      'search_mcp_marketplace',
    ]));
    expect(enabledTools).not.toEqual(expect.arrayContaining([
      'install_mcp_server',
      'install_best_mcp_server',
    ]));
    expect(stages.every((stage) => stage.data.properties?.boundModel === undefined)).toBe(true);
    expect(flow.permissionRules?.map((rule) => rule.action)).toEqual(expect.arrayContaining([
      'list_flow_building_blocks',
      'get_flow_authoring_guide',
      'draft_generated_flow',
      'search_mcp_marketplace',
    ]));
    expect(flow.permissionRules?.map((rule) => rule.action)).not.toEqual(
      expect.arrayContaining(['install_mcp_server', 'install_best_mcp_server'])
    );
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

  it.each([1, 2])('upgrades incomplete v%s through the versioned save path', async (version) => {
    const legacy = buildVendoredFlowGenerator();
    for (const stage of legacy.nodes.filter((node) => node.type === 'process')) {
      stage.data.properties = {
        ...(stage.data.properties ?? {}),
        systemFlowVersion: version,
      };
    }
    getFlowMock.mockResolvedValueOnce(legacy);

    const upgraded = await ensureVendoredFlowGenerator();

    expect(upgraded.nodes.filter((node) => node.type === 'process'))
      .toHaveLength(2);
    expect(saveFlowMock).toHaveBeenCalledWith(expect.objectContaining({
      id: FLOW_GENERATOR_ID,
    }));
  });

  it('restores only through the explicit restore operation', async () => {
    await restoreVendoredFlowGenerator();
    expect(saveFlowMock).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW_GENERATOR_ID }));
  });

  it('clones the latest edited flow, binds both stages, and strips install tools by default', async () => {
    const source = buildVendoredFlowGenerator();
    getFlowMock.mockResolvedValue(source);
    const snapshot = await buildFlowGeneratorSnapshot('conversation-1', 'model-9');
    expect(snapshot.id).toBe('quickchat-flow-generator-conversation-1');
    expect(snapshot.nodes
      .filter((node) => node.type === 'process')
      .every((node) => node.data.properties?.boundModel === 'model-9')).toBe(true);
    expect(source.nodes
      .filter((node) => node.type === 'process')
      .every((node) => node.data.properties?.boundModel === undefined)).toBe(true);
    expect(snapshot.nodes
      .filter((node) => node.type === 'mcp')
      .flatMap((node) => node.data.properties?.enabledTools ?? []))
      .not.toEqual(expect.arrayContaining(['install_mcp_server', 'install_best_mcp_server']));
    expect(snapshot.permissionRules?.map((rule) => rule.action))
      .not.toEqual(expect.arrayContaining(['install_mcp_server', 'install_best_mcp_server']));
    expect(snapshot.nodes.find((node) => node.type === 'start')
      ?.data.properties?.promptTemplate).toContain('NOT opted in');
  });

  it('retains install tools only for an explicitly opted-in session snapshot', async () => {
    getFlowMock.mockResolvedValue(buildVendoredFlowGenerator());
    const snapshot = await buildFlowGeneratorSnapshot(
      'conversation-install',
      'model-9',
      { allowInstall: true },
    );
    const enabled = snapshot.nodes
      .filter((node) => node.type === 'mcp')
      .flatMap((node) => node.data.properties?.enabledTools ?? []);
    expect(enabled).toEqual(expect.arrayContaining([
      'install_mcp_server',
      'install_best_mcp_server',
    ]));
    expect(snapshot.nodes.find((node) => node.type === 'start')
      ?.data.properties?.promptTemplate).toContain('explicitly opted in');
  });
});
