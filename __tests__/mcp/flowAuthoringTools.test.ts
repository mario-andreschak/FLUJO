/**
 * Tests for the flow-authoring tools on the built-in FLUJO MCP server (#14 follow-up):
 * list_flow_building_blocks / validate_flow_spec / create_flow. External agents author
 * the semantic FlowSpec; these tools compile, validate, and (create_flow only, gated on
 * zero errors) save — no raw ReactFlow JSON in the contract.
 */

const loadModelsMock = jest.fn();
jest.mock('@/backend/services/model', () => ({
  modelService: {
    loadModels: (...a: unknown[]) => loadModelsMock(...a),
  },
}));

const loadServerConfigsMock = jest.fn();
const getServerStatusMock = jest.fn();
const listServerToolsMock = jest.fn();
jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: (...a: unknown[]) => loadServerConfigsMock(...a),
    getServerStatus: (...a: unknown[]) => getServerStatusMock(...a),
    listServerTools: (...a: unknown[]) => listServerToolsMock(...a),
  },
}));

const loadFlowsMock = jest.fn();
const saveFlowMock = jest.fn();
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    loadFlows: (...a: unknown[]) => loadFlowsMock(...a),
    saveFlow: (...a: unknown[]) => saveFlowMock(...a),
  },
}));

import {
  AUTHORING_TOOL_NAMES,
  isAuthoringTool,
  authoringToolDefinitions,
  authoringCallTool,
} from '@/backend/services/mcp/flowAuthoringTools';
import { FLOWSPEC_DOC } from '@/utils/shared/flowSpecDoc';

const goodSpec = {
  name: 'agent_made_flow',
  nodes: [
    { key: 's', type: 'start' },
    { key: 'p', type: 'process', model: 'worker', prompt: 'do it' },
    { key: 'f', type: 'finish' },
  ],
  edges: [
    { from: 's', to: 'p' },
    { from: 'p', to: 'f' },
  ],
};

function textOf(result: { content: Array<{ type: string }> }): string {
  const first = result.content[0] as { type: string; text?: string };
  expect(first.type).toBe('text');
  return first.text!;
}

function payload(result: { content: Array<{ type: string }> }): any {
  return JSON.parse(textOf(result));
}

beforeEach(() => {
  jest.clearAllMocks();
  loadModelsMock.mockResolvedValue([
    { id: 'model-1', name: 'worker', displayName: 'Worker Model', description: 'the workhorse', ApiKey: 'enc' },
  ]);
  loadServerConfigsMock.mockResolvedValue([{ name: 'srv' }, { name: 'offline-srv' }]);
  getServerStatusMock.mockImplementation(async (name: string) => ({
    status: name === 'srv' ? 'connected' : 'error',
  }));
  listServerToolsMock.mockResolvedValue({ tools: [{ name: 'tool_a', description: 'does a' }] });
  loadFlowsMock.mockResolvedValue([
    { id: 'flow-1', name: 'Existing', description: 'already here', nodes: [{}, {}], edges: [] },
  ]);
  saveFlowMock.mockResolvedValue(undefined);
});

describe('tool definitions', () => {
  it('exposes exactly the three authoring tools, recognized by isAuthoringTool', () => {
    const defs = authoringToolDefinitions();
    expect(defs.map((t) => t.name)).toEqual([...AUTHORING_TOOL_NAMES]);
    for (const name of AUTHORING_TOOL_NAMES) expect(isAuthoringTool(name)).toBe(true);
    expect(isAuthoringTool('some_flow_tool')).toBe(false);
  });

  it('embeds the canonical FlowSpec documentation in the spec-taking tools', () => {
    const defs = authoringToolDefinitions();
    const create = defs.find((t) => t.name === 'create_flow')!;
    const validate = defs.find((t) => t.name === 'validate_flow_spec')!;
    expect(create.description).toContain(FLOWSPEC_DOC);
    expect(validate.description).toContain(FLOWSPEC_DOC);
    expect(create.inputSchema).toEqual(expect.objectContaining({ required: ['spec'] }));
  });
});

describe('list_flow_building_blocks', () => {
  it('returns the structured models / servers / flows catalog', async () => {
    const blocks = payload(await authoringCallTool('list_flow_building_blocks', {}));
    expect(blocks.models).toEqual([
      { id: 'model-1', name: 'worker', displayName: 'Worker Model', description: 'the workhorse' },
    ]);
    expect(blocks.servers).toEqual([
      { name: 'srv', connected: true, tools: [{ name: 'tool_a', description: 'does a' }] },
      { name: 'offline-srv', connected: false },
    ]);
    expect(blocks.flows).toEqual([
      { id: 'flow-1', name: 'Existing', description: 'already here', nodeCount: 2 },
    ]);
  });

  it('never includes key material', async () => {
    const text = textOf(await authoringCallTool('list_flow_building_blocks', {}));
    expect(text).not.toContain('enc');
    expect(text).not.toContain('ApiKey');
  });
});

describe('validate_flow_spec', () => {
  it('returns a clean validation without saving', async () => {
    const result = await authoringCallTool('validate_flow_spec', { spec: goodSpec });
    expect(result.isError).toBeUndefined();
    const body = payload(result);
    expect(body.validation.errorCount).toBe(0);
    expect(body.flowName).toBe('agent_made_flow');
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('surfaces issues for a broken spec (still not an unknown-tool error)', async () => {
    const broken = { ...goodSpec, nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, model: 'ghost' } : n)) };
    const body = payload(await authoringCallTool('validate_flow_spec', { spec: broken }));
    expect(body.validation.errorCount).toBeGreaterThan(0);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('tolerates the spec arriving as a JSON string', async () => {
    const body = payload(await authoringCallTool('validate_flow_spec', { spec: JSON.stringify(goodSpec) }));
    expect(body.validation.errorCount).toBe(0);
  });

  it('errors helpfully when spec is missing or unparseable', async () => {
    const missing = await authoringCallTool('validate_flow_spec', {});
    expect(missing.isError).toBe(true);
    const garbled = await authoringCallTool('validate_flow_spec', { spec: '{not json' });
    expect(garbled.isError).toBe(true);
  });
});

describe('create_flow', () => {
  it('saves a clean spec and reports how to call it', async () => {
    const result = await authoringCallTool('create_flow', { spec: goodSpec });
    expect(result.isError).toBeUndefined();
    const body = payload(result);
    expect(body.saved).toBe(true);
    expect(saveFlowMock).toHaveBeenCalledTimes(1);
    expect(body.note).toContain('flow-agent_made_flow');
  });

  it('does NOT save on validation errors and flags the result as an error for the agent loop', async () => {
    const broken = { ...goodSpec, nodes: goodSpec.nodes.map((n) => (n.key === 'p' ? { ...n, model: 'ghost' } : n)) };
    const result = await authoringCallTool('create_flow', { spec: broken });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body.saved).toBe(false);
    expect(body.validation.errorCount).toBeGreaterThan(0);
    expect(saveFlowMock).not.toHaveBeenCalled();
  });

  it('a spec with no usable nodes returns the compile issues', async () => {
    const result = await authoringCallTool('create_flow', { spec: { nodes: [], edges: [] } });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body.issues).toContainEqual(expect.objectContaining({ code: 'no-usable-nodes' }));
    expect(saveFlowMock).not.toHaveBeenCalled();
  });
});

describe('dispatch', () => {
  it('unknown authoring tool name is an error result, not a throw', async () => {
    const result = await authoringCallTool('paint_a_picture', {});
    expect(result.isError).toBe(true);
  });

  it('a service failure is caught and reported as an error result', async () => {
    loadModelsMock.mockRejectedValue(new Error('storage down'));
    const result = await authoringCallTool('list_flow_building_blocks', {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('storage down');
  });
});
