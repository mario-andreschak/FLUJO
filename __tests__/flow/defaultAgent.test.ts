const getFlowMock = jest.fn();
const saveFlowMock = jest.fn();

jest.mock('@/backend/services/flow/index', () => ({
  flowService: {
    getFlow: (...args: unknown[]) => getFlowMock(...args),
    saveFlow: (...args: unknown[]) => saveFlowMock(...args),
  },
}));

import {
  buildDefaultFlujoAgent,
  DEFAULT_FLUJO_AGENT_ID,
  DEFAULT_FLUJO_AGENT_SERVERS,
  DEFAULT_FLUJO_AGENT_TOOLS,
  DEFAULT_FLUJO_AGENT_VERSION,
  ensureDefaultFlujoAgent,
} from '@/backend/services/flow/defaultAgent';

beforeEach(() => {
  jest.clearAllMocks();
  saveFlowMock.mockResolvedValue({ success: true });
});

describe('default FLUJO Agent', () => {
  it('builds the prompt-free Start -> Process -> Finish agent with all shipped servers', () => {
    const flow = buildDefaultFlujoAgent();

    expect(flow).toMatchObject({
      id: DEFAULT_FLUJO_AGENT_ID,
      name: 'FLUJO',
      favorite: true,
    });

    const start = flow.nodes.find((node) => node.type === 'start');
    const process = flow.nodes.find((node) => node.type === 'process');
    const finish = flow.nodes.find((node) => node.type === 'finish');
    const mcpNodes = flow.nodes.filter((node) => node.type === 'mcp');

    expect(flow.nodes.filter((node) => node.type === 'start')).toHaveLength(1);
    expect(flow.nodes.filter((node) => node.type === 'process')).toHaveLength(1);
    expect(flow.nodes.filter((node) => node.type === 'finish')).toHaveLength(1);
    expect(start?.data.label).toBe('Start Node');
    expect(process?.data.label).toBe('Process Node');
    expect(finish?.data.label).toBe('Finish Node');
    expect(start?.data.properties?.promptTemplate).toBe('');
    expect(process?.data.properties).toMatchObject({
      promptTemplate: '',
      inputMode: 'full-history',
      defaultAgentVersion: DEFAULT_FLUJO_AGENT_VERSION,
    });
    expect(process?.data.properties).not.toHaveProperty('boundModel');

    expect(mcpNodes.map((node) => node.data.properties?.boundServer)).toEqual(
      DEFAULT_FLUJO_AGENT_SERVERS,
    );
    expect(Object.fromEntries(mcpNodes.map((node) => [
      node.data.properties?.boundServer,
      node.data.properties?.enabledTools,
    ]))).toEqual(DEFAULT_FLUJO_AGENT_TOOLS);
    expect(mcpNodes.every((node) =>
      flow.edges.some((edge) =>
        edge.source === process?.id
        && edge.target === node.id
        && edge.data?.edgeType === 'mcp'
      )
    )).toBe(true);

    expect(flow.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: start?.id,
        target: process?.id,
        data: expect.objectContaining({ edgeType: 'standard' }),
      }),
      expect.objectContaining({
        source: process?.id,
        target: finish?.id,
        data: expect.objectContaining({ edgeType: 'standard' }),
      }),
    ]));
  });

  it('seeds only when missing and never overwrites an edited default agent', async () => {
    const edited = { ...buildDefaultFlujoAgent(), description: 'User edited' };
    getFlowMock.mockResolvedValueOnce(edited);

    expect(await ensureDefaultFlujoAgent()).toBe(edited);
    expect(saveFlowMock).not.toHaveBeenCalled();

    getFlowMock.mockResolvedValueOnce(null);
    const seeded = await ensureDefaultFlujoAgent();
    expect(seeded.id).toBe(DEFAULT_FLUJO_AGENT_ID);
    expect(saveFlowMock).toHaveBeenCalledTimes(1);
  });

  it('upgrades the prior toolless default without replacing other agent fields', async () => {
    const legacy = buildDefaultFlujoAgent();
    const process = legacy.nodes.find((node) => node.type === 'process')!;
    process.data.properties = {
      ...process.data.properties,
      promptTemplate: 'Keep my prompt',
    };
    delete process.data.properties.defaultAgentVersion;
    for (const node of legacy.nodes.filter((candidate) => candidate.type === 'mcp')) {
      node.data.properties = { ...node.data.properties, enabledTools: [] };
    }
    getFlowMock.mockResolvedValueOnce(legacy);

    const upgraded = await ensureDefaultFlujoAgent();

    expect(upgraded.nodes.find((node) => node.type === 'process')?.data.properties)
      .toMatchObject({
        promptTemplate: 'Keep my prompt',
        defaultAgentVersion: DEFAULT_FLUJO_AGENT_VERSION,
      });
    expect(Object.fromEntries(upgraded.nodes
      .filter((node) => node.type === 'mcp')
      .map((node) => [
        node.data.properties?.boundServer,
        node.data.properties?.enabledTools,
      ])))
      .toEqual(DEFAULT_FLUJO_AGENT_TOOLS);
    expect(saveFlowMock).toHaveBeenCalledWith(upgraded);
  });
});
