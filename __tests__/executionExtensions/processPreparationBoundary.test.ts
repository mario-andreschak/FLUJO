import { ProcessNode } from '@/backend/execution/flow/nodes';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { ResourceHandler } from '@/backend/execution/flow/handlers/ResourceHandler';
import { mcpService } from '@/backend/services/mcp';
import * as mcpConnection from '@/backend/services/mcp/connection';
import { protectedConfigFingerprint } from '@/backend/services/mcp/connection';
import { modelService } from '@/backend/services/model';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import type { ProcessNodeParams, SharedState } from '@/backend/execution/flow/types';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/backend/services/mcp/connection', () => ({
  ...jest.requireActual('@/backend/services/mcp/connection'),
  createTransport: jest.fn(() => { throw new Error('unexpected transport creation'); }),
}));

describe('protected Process preparation has no foreign MCP effects', () => {
  let restore: (() => void) | undefined;

  afterEach(() => {
    restore?.();
    restore = undefined;
    jest.restoreAllMocks();
  });

  function setup(promptTemplate = 'Safe prompt') {
    const adapter = fixtureAdapter();
    restore = registerExecutionExtension(adapter);
    const run = fixtureRun();
    const context = mintFixture(adapter, run);
    const flowSnapshot = {
      id: 'protected-flow', name: 'Protected',
      nodes: [{ id: 'process', type: 'process', position: { x: 0, y: 0 },
        data: { type: 'process', label: 'Process', properties: { boundModel: 'model-1', promptTemplate } } }],
      edges: [],
    };
    const state = {
      trackingInfo: { executionId: run.runId, startTime: 1, nodeExecutionTracker: [] },
      messages: [], flowId: flowSnapshot.id, flowSnapshot,
      conversationId: run.conversation, executionExtensionContext: context,
      title: 'Protected', createdAt: 1, updatedAt: 1,
    } as unknown as SharedState;
    const params = (properties: Record<string, unknown> = {}): ProcessNodeParams => ({
      id: 'process', label: 'Process', type: 'process',
      properties: { boundModel: 'model-1', ...properties },
    } as ProcessNodeParams);
    return { state, params, run };
  }

  function watchMcpEffects() {
    return [
      jest.spyOn(mcpService, 'getServerStatus'),
      jest.spyOn(mcpService, 'setNodeRoots'),
      jest.spyOn(mcpService, 'connectServer'),
      jest.spyOn(mcpService, 'listServerTools'),
      jest.spyOn(mcpService, 'readResource'),
      jest.spyOn(mcpService, 'subscribeToResource'),
    ];
  }

  test('owned state without live context is refused before prompt preparation', async () => {
    const { state, params } = setup();
    state.executionExtensionOwned = true;
    delete state.executionExtensionContext;
    const render = jest.spyOn(promptRenderer, 'renderPrompt');
    const discovery = jest.spyOn(ToolHandler, 'processMCPNodes');

    await expect(new ProcessNode().prep(state, params()))
      .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    expect(render).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
  });

  test('foreign bound server is denied before tool discovery or prompt rendering', async () => {
    const { state, params } = setup();
    const effects = watchMcpEffects();
    const tools = jest.spyOn(ToolHandler, 'processMCPNodes');
    const render = jest.spyOn(promptRenderer, 'renderPrompt');

    await expect(new ProcessNode().prep(state, params({ mcpNodes: [
      { id: 'allowed', properties: { boundServer: 'protected-fixture', enabledTools: [] } },
      { id: 'foreign', properties: { boundServer: 'ordinary-server', enabledTools: [] } },
    ] }))).rejects.toMatchObject({ code: 'execution_mcp_server_forbidden' });

    expect(render).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test.each([
    ['explicit', 'mcp'],
    ['legacy', undefined],
  ])('%s external resource node is denied before any resource read or subscription', async (_kind, scope) => {
    const { state, params } = setup();
    const effects = watchMcpEffects();
    const resources = jest.spyOn(ResourceHandler, 'processResourceNodes');
    const render = jest.spyOn(promptRenderer, 'renderPrompt');

    await expect(new ProcessNode().prep(state, params({ resourceNodes: [
      { id: 'external', role: 'consume', properties: { scope, boundServer: 'ordinary-server', uri: 'file:///private' } },
    ] }))).rejects.toMatchObject({ code: 'execution_external_resource_forbidden' });

    expect(render).not.toHaveBeenCalled();
    expect(resources).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test('prompt resource pill is denied before the renderer connects', async () => {
    const { state, params } = setup('Before ${resource:ordinary-server__file:///private} after');
    const effects = watchMcpEffects();
    const model = jest.spyOn(modelService, 'getModel');

    await expect(new ProcessNode().prep(state, params())).rejects.toMatchObject({
      code: 'execution_resource_binding_forbidden',
    });

    expect(model).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test('allowed protected discovery suppresses node-root rebinding while ordinary discovery keeps it', async () => {
    const bound = [{ id: 'shared-node', properties: {
      boundServer: 'protected-fixture', enabledTools: [], enabledResources: [], roots: ['C:/workspace'],
    } }] as never;
    const roots = jest.spyOn(mcpService, 'setNodeRoots').mockImplementation(() => undefined);
    jest.spyOn(mcpService, 'loadServerConfigs').mockResolvedValue([]);
    jest.spyOn(mcpService, 'connectServer').mockResolvedValue({ success: true } as never);
    jest.spyOn(mcpService, 'listServerTools').mockResolvedValue({ tools: [] } as never);

    const { state, params } = setup();
    const prepared = await new ProcessNode().prep(state, params({ mcpNodes: bound }));
    expect(prepared.nodeId).toBe('process');
    expect(roots).not.toHaveBeenCalled();

    const ordinary = await ToolHandler.processMCPNodes({ mcpNodes: bound });
    expect(ordinary.success).toBe(true);
    expect(roots).toHaveBeenCalledWith('protected-fixture', 'shared-node', ['C:/workspace']);
  });

  test('uses the admitted bindings after an awaited render mutates node parameters', async () => {
    const { state, params } = setup();
    const admitted = [{ id: 'shared-node', properties: {
      boundServer: 'protected-fixture', enabledTools: [], enabledResources: [],
    } }];
    const input = params({ mcpNodes: admitted });
    const resources = jest.spyOn(ResourceHandler, 'processResourceNodes');
    const discovery = jest.spyOn(ToolHandler, 'processMCPNodes').mockResolvedValue({
      success: true, value: { availableTools: [] },
    } as never);
    jest.spyOn(promptRenderer, 'renderPrompt').mockImplementation(async () => {
      input.properties.mcpNodes = [{ id: 'shared-node', properties: {
        boundServer: 'ordinary-server', enabledTools: [],
      } }] as never;
      input.properties.resourceNodes = [{ id: 'external', role: 'consume', properties: {
        scope: 'mcp', boundServer: 'ordinary-server', uri: 'file:///private',
      } }] as never;
      return 'Safe prompt';
    });

    const prepared = await new ProcessNode().prep(state, input);
    expect(resources).not.toHaveBeenCalled();
    expect(discovery).toHaveBeenCalledWith(expect.objectContaining({
      mcpNodes: admitted,
      executionExtensionContext: state.executionExtensionContext,
    }));
    expect(prepared.mcpNodesForDispatch).toEqual(admitted);
    expect(prepared.mcpNodesForDispatch).not.toBe(input.properties.mcpNodes);
  });

  test('revocation during prompt rendering stops MCP discovery before connection', async () => {
    const { state, params, run } = setup();
    const effects = watchMcpEffects();
    const discovery = jest.spyOn(ToolHandler, 'processMCPNodes');
    jest.spyOn(promptRenderer, 'renderPrompt').mockImplementation(async () => {
      run.revoked = true;
      return 'Safe prompt';
    });

    await expect(new ProcessNode().prep(state, params({ mcpNodes: [
      { id: 'allowed', properties: { boundServer: 'protected-fixture', enabledTools: [], enabledResources: [] } },
    ] }))).rejects.toMatchObject({ code: 'fixture_authorization_denied' });
    expect(discovery).toHaveBeenCalledTimes(1);
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test('protected prompt leaves mutable cross-run KV references literal', async () => {
    const { state, params } = setup('Use ${kv:other-run} literally');
    const prepared = await new ProcessNode().prep(state, params());
    expect(prepared.currentPrompt).toContain('${kv:other-run}');
  });

  test('selected MCP Skills are denied before their loader can connect', async () => {
    const { state, params } = setup();
    state.mcpSkillSelections = [{ serverName: 'ordinary-server', skillUri: 'mcp://skill', manifestDigest: 'digest' }] as never;
    const load = jest.spyOn(mcpService, 'loadVerifiedSkill');
    const render = jest.spyOn(promptRenderer, 'renderPrompt');
    const effects = watchMcpEffects();

    await expect(new ProcessNode().prep(state, params())).rejects.toMatchObject({
      code: 'execution_mcp_skills_forbidden',
    });
    expect(render).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  });

  test('a shared-state alias cannot retarget an admitted server during config loading', async () => {
    const { state, params } = setup();
    jest.spyOn(mcpService, 'loadServerConfigs').mockImplementation(async () => {
      try {
        state.currentMCPNodes![0].properties.boundServer = 'ordinary-server';
      } catch { /* frozen protected bindings reject mutation */ }
      return [];
    });
    const connect = jest.spyOn(mcpService, 'connectServer').mockResolvedValue({ success: true } as never);
    jest.spyOn(mcpService, 'listServerTools').mockResolvedValue({ tools: [] } as never);

    await new ProcessNode().prep(state, params({ mcpNodes: [{ id: 'allowed', properties: {
      boundServer: 'protected-fixture', enabledTools: [], enabledResources: [],
    } }] }));
    expect(state.currentMCPNodes?.[0].properties.boundServer).toBe('protected-fixture');
    expect(connect).toHaveBeenCalledWith('protected-fixture', state.executionExtensionContext);
    expect(connect.mock.calls.every(([name]) => (typeof name === 'string' ? name : name.name) !== 'ordinary-server')).toBe(true);
  });

  test('direct protected execCore requires bindings admitted during prep', async () => {
    const { state, params } = setup();
    const prepared = await new ProcessNode().prep(state, params());
    const { mcpNodesForDispatch: _admitted, ...missingAdmission } = prepared;
    await expect(new ProcessNode().execCore(missingAdmission, params({ mcpNodes: [{
      id: 'foreign', properties: { boundServer: 'ordinary-server', enabledTools: [] },
    }] }))).rejects.toMatchObject({ code: 'execution_mcp_admission_required' });
  });

  test('handoff descriptions do not query a successor\'s foreign MCP server', async () => {
    const { state, params } = setup();
    state.flowSnapshot!.nodes.push({ id: 'target', type: 'process', position: { x: 0, y: 0 },
      data: { type: 'process', label: 'Target', properties: {
        boundModel: 'model-1', mcpNodes: [{ id: 'foreign', properties: {
          boundServer: 'ordinary-server', enabledTools: [],
        } }],
      } },
    } as never);
    const target = new ProcessNode();
    target.setParams({}, { id: 'target', label: 'Target', type: 'process', properties: { boundModel: 'model-1' } });
    const node = new ProcessNode();
    node.addSuccessor(target, 'to-target');
    const input = params();
    input.orderedOutgoingEdges = ['to-target'];
    const status = jest.spyOn(mcpService, 'getServerStatus');

    const prepared = await node.prep(state, input);
    expect(prepared.availableTools?.some(tool => tool.name.startsWith('handoff_to_'))).toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  test('protected tool listing rejects a client for an older websocket recipient', async () => {
    const { state } = setup();
    const oldConfig = { name: 'protected-fixture', transport: 'websocket', websocketUrl: 'wss://old.example/mcp' };
    const currentConfig = { ...oldConfig, websocketUrl: 'wss://current.example/mcp' };
    jest.spyOn(mcpService, 'loadServerConfigs').mockResolvedValue([currentConfig as never]);
    jest.spyOn(mcpService, 'getClient').mockReturnValue({
      __flujoProtectedConfigFingerprint: protectedConfigFingerprint(oldConfig as never),
    } as never);
    const reconnect = jest.spyOn(mcpService, 'forceReconnect');

    await expect(mcpService.listServerTools('protected-fixture', 'model', state.executionExtensionContext))
      .rejects.toMatchObject({ code: 'execution_mcp_client_identity_changed' });
    expect(reconnect).not.toHaveBeenCalled();
  });

  test('host inventory cannot list a protected server without a run context', async () => {
    setup();
    const client = jest.spyOn(mcpService, 'getClient');
    await expect(mcpService.listServerTools('protected-fixture', 'all'))
      .rejects.toMatchObject({ code: 'trusted_execution_context_required' });
    expect(client).not.toHaveBeenCalled();
  });

  test('revocation while loading protected connection config stops before transport creation', async () => {
    const { state, run } = setup();
    const transport = mcpConnection.createTransport as jest.Mock;
    transport.mockClear();
    jest.spyOn(mcpService, 'loadServerConfigs').mockImplementation(async () => {
      run.revoked = true;
      return [{ name: 'protected-fixture', transport: 'websocket', websocketUrl: 'wss://current.example/mcp' } as never];
    });

    const result = await mcpService.connectServer('protected-fixture', state.executionExtensionContext);
    expect(result).toMatchObject({ success: false, error: 'fixture_authorization_denied' });
    expect(transport).not.toHaveBeenCalled();
  });

  test('protected dispatch rejects an old recipient before readiness or tool requests', async () => {
    const { state } = setup();
    const oldConfig = { name: 'protected-fixture', transport: 'websocket', websocketUrl: 'wss://old.example/mcp' };
    const currentConfig = { ...oldConfig, websocketUrl: 'wss://current.example/mcp' };
    const client = { __flujoProtectedConfigFingerprint: protectedConfigFingerprint(oldConfig as never),
      listTools: jest.fn(), callTool: jest.fn() };
    const release = jest.fn();
    jest.spyOn(mcpService, 'loadServerConfigs').mockResolvedValue([currentConfig as never]);
    jest.spyOn(mcpService, 'isServerDisabled').mockResolvedValue(false);
    jest.spyOn(mcpService, 'getClient').mockReturnValue(client as never);
    jest.spyOn(mcpService, 'acquireServerLease').mockResolvedValue({ success: true,
      lease: { client, isStale: () => false, release } } as never);

    const result = await mcpService.callTool('protected-fixture', 'echo', {}, undefined, undefined,
      undefined, undefined, 'model', undefined, undefined, state.executionExtensionContext);
    expect(result).toMatchObject({ success: false, error: 'execution_mcp_client_identity_changed' });
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('protected MCP presets cannot read shared globals before a tool call', async () => {
    const { state, params } = setup();
    jest.spyOn(mcpService, 'loadServerConfigs').mockResolvedValue([]);
    jest.spyOn(mcpService, 'connectServer').mockResolvedValue({ success: true } as never);
    jest.spyOn(mcpService, 'listServerTools').mockResolvedValue({ tools: [{
      name: 'echo', inputSchema: { type: 'object', properties: {} },
    }] } as never);

    await expect(new ProcessNode().prep(state, params({ mcpNodes: [{ id: 'allowed', properties: {
      boundServer: 'protected-fixture', enabledTools: ['echo'], enabledResources: [],
      toolParameterPresets: { echo: { message: '${global:SECRET}' } },
    } }] }))).rejects.toMatchObject({ code: 'execution_tool_presets_forbidden' });
  });
});
