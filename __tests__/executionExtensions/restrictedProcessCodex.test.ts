/** Real Process/ModelHandler/adapter composition; native CLI inventory is tested separately. */
import { ProcessNode } from '@/backend/execution/flow/nodes';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { CodexAdapter } from '@/backend/services/model/adapters/codexAdapter';
import { modelService } from '@/backend/services/model';
import type { SharedState } from '@/backend/execution/flow/types';
import type { BridgeTool } from '@/backend/services/model/adapters/codexToolBridge';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';

const mockCtor = jest.fn();
const mockStream = jest.fn();
const mockCleanup = jest.fn(async () => undefined);
const mockCallTool = jest.fn();
let mockBridgeTools: BridgeTool[] = [];
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@openai/codex-sdk', () => ({ Codex: class {
  constructor(options: unknown) { mockCtor(options); }
  startThread() { return { runStreamed: mockStream }; }
} }), { virtual: true });
jest.mock('@/backend/services/model/adapters/codexRestrictedProfile', () => ({
  ...jest.requireActual('@/backend/services/model/adapters/codexRestrictedProfile'),
  assertRestrictedCodexProfile: jest.fn(async () => 'checked-fixture-binary'),
  prepareRestrictedCodexRuntimeEnvironment: jest.fn(async () => ({
    home: 'fixture-private-home', workingDirectory: 'fixture-private-cwd',
    env: { CODEX_HOME: 'fixture-private-home' }, configOverrides: ['project_root_markers=[]'],
    modelCatalogPath: 'fixture-private-home/verified-models.json', cleanup: mockCleanup,
  })),
}));
jest.mock('@/backend/services/model/adapters/codexToolBridge', () => ({ startCodexToolBridge: async (tools: BridgeTool[]) => {
  mockBridgeTools = tools;
  return { url: 'http://127.0.0.1:1234/fixture-only', close: async () => undefined };
} }));
jest.mock('@/backend/services/model/adapters/codexContextUsage', () => ({ readCodexTokenSnapshot: jest.fn() }));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: jest.fn(async () => null) }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  callTool: (...args: unknown[]) => mockCallTool(...args), loadServerConfigs: jest.fn(async () => []),
  listServerTools: jest.fn(async () => ({ tools: [] })), isMcpAppAccessEnabled: async () => false,
} }));
jest.mock('@/backend/services/runResources', () => ({
  ...jest.requireActual('@/backend/services/runResources'), listRunResources: jest.fn(async () => []),
}));
jest.mock('@/backend/services/statistics', () => ({ ...jest.requireActual('@/backend/services/statistics'), recordStatisticsEvent: jest.fn() }));

describe('private Process tool offers reach the real restricted Codex adapter', () => {
  let restore: (() => void) | undefined;
  const profile = { verifiedCliVersion: '0.153.3', verifiedCliSha256: 'a'.repeat(64),
    verifiedModelCatalogPath: 'fixture-models.json', verifiedModelCatalogSha256: 'b'.repeat(64) };
  const params = { id: 'process', label: 'Process', type: 'process' as const, properties: { boundModel: 'model-1' } };
  beforeEach(() => {
    jest.clearAllMocks(); mockBridgeTools = [];
    jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model-1', name: 'gpt-6-sol',
      provider: 'codex', adapter: 'codex-cli', ApiKey: '', contextWindow: 100_000 } as never);
    jest.spyOn(modelService, 'resolveAndDecryptApiKey').mockResolvedValue('');
    mockCallTool.mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: '{"own":true}' }] } });
    mockStream.mockImplementation(async () => ({ events: (async function* () {
      yield { type: 'thread.started', thread_id: 'fixture-thread' };
      await mockBridgeTools[0].handler({});
      yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'approved result' } };
      yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
    })() }));
  });
  afterEach(() => { restore?.(); restore = undefined; jest.restoreAllMocks(); });
  function state(privateRun: boolean): SharedState {
    const run = fixtureRun();
    const adapter = fixtureAdapter({ codexProfile: () => profile });
    if (privateRun) restore = registerExecutionExtension(adapter);
    const graph = { id: 'shared-graph', name: 'Shared', nodes: [{ id: params.id, type: 'process',
      position: { x: 0, y: 0 }, data: { type: 'process', label: 'Process', properties: params.properties } }], edges: [] };
    return { trackingInfo: { executionId: run.runId, startTime: 1, nodeExecutionTracker: [] },
      messages: [{ id: 'request', role: 'user', content: 'Use the approved read tool.', timestamp: 1 }],
      flowId: graph.id, flowSnapshot: graph, conversationId: run.conversation,
      ...(privateRun ? { executionExtensionContext: mintFixture(adapter, run) } : {}),
      mcpContext: { availableTools: ['read', 'list', 'status'].map(tool => ({
        name: `fixture_${tool}`, originalName: tool, server: 'protected-fixture',
        inputSchema: { type: 'object', properties: {} },
      })) },
      title: 'Fixture', createdAt: 1, updatedAt: 1,
    } as unknown as SharedState;
  }

  test('offers only the three approved MCP tools, ignoring stale sticky resources, with no local executors', async () => {
    const shared = state(true);
    shared.armedSyntheticTools = ['read_resource', 'list_mcp_resources'];
    const adapterCall = jest.spyOn(CodexAdapter.prototype, 'createCompletion');
    const modelCall = jest.spyOn(ModelHandler, 'callModel');
    const node = new ProcessNode();
    const prepared = await node.prep(shared, params);
    expect(prepared.availableTools?.map(tool => tool.name).sort()).toEqual(['fixture_list', 'fixture_read', 'fixture_status']);
    const result = await node.execCore(prepared, params);
    expect(result.success).toBe(true);
    expect(modelCall).toHaveBeenCalledTimes(1);
    expect(adapterCall).toHaveBeenCalledTimes(1);
    expect(adapterCall.mock.calls[0][0].localToolExecutors).toBeUndefined();
    expect(mockBridgeTools).toHaveLength(3);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
    expect(mockCtor).toHaveBeenCalledTimes(1);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(result.messages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'tool', content: JSON.stringify({ content: [{ type: 'text', text: '{"own":true}' }] }),
    })]));
  });

  test('ordinary Process calls retain automatic and sticky resource tool arming', async () => {
    const shared = state(false);
    const prepared = await new ProcessNode().prep(shared, params);
    expect(prepared.availableTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['read_resource', 'list_mcp_resources']));
    expect(shared.armedSyntheticTools).toEqual(['list_mcp_resources', 'read_resource']);
  });

  test('a late synthetic resource offer still fails at the unchanged private adapter guard', async () => {
    const shared = state(true);
    const adapterCall = jest.spyOn(CodexAdapter.prototype, 'createCompletion');
    const node = new ProcessNode();
    const prepared = await node.prep(shared, params);
    // Reproduce the old late-arming defect after its initial approved-tool filter.
    prepared.availableTools!.push({ name: 'read_resource', inputSchema: { type: 'object', properties: {} } });
    await expect(node.execCore(prepared, params)).rejects.toThrow('execution_local_tools_forbidden');
    expect(adapterCall.mock.calls[0][0].localToolExecutors).toHaveProperty('read_resource');
    expect(mockCtor).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
