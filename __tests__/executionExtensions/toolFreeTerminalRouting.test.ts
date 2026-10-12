import { ProcessNode, FinishNode } from '@/backend/execution/flow/nodes';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { modelService } from '@/backend/services/model';
import { mcpService } from '@/backend/services/mcp';
import { registerExecutionExtension } from '@/backend/execution/extensions';
import { fixtureAdapter, fixtureRun, mintFixture } from './fixtureAdapter';
import type { ProcessNodeParams, ProcessNodeProperties, SharedState } from '@/backend/execution/flow/types';
import { FINAL_RESPONSE_ACTION } from '@/backend/execution/flow/types';
import { compileFlowSpec, flowToSpec, type FlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { flowUsesAdvancedFeatures } from '@/utils/shared/flowAuthoringProfile';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn(), loadServerConfigs: async () => [], listServerTools: async () => ({ tools: [] }), isMcpAppAccessEnabled: async () => false } }));
jest.mock('@/backend/services/runResources', () => ({ ...jest.requireActual('@/backend/services/runResources'), listRunResources: async () => [] }));
const mockCompletion = jest.fn(async (_input: unknown) => { throw new Error('Offline provider fixture must be configured'); });
jest.mock('@/backend/services/model/adapters', () => ({ ...jest.requireActual('@/backend/services/model/adapters'), getCompletionAdapter: () => ({ createCompletion: mockCompletion, createStreamCompletion: mockCompletion }) }));

const spec: FlowSpec = { name: 'Terminal', nodes: [
  { key: 'start', type: 'start' }, { key: 'process', type: 'process', model: 'model', terminalRouting: 'tool-free' }, { key: 'finish', type: 'finish' },
], edges: [{ from: 'start', to: 'process' }, { from: 'process', to: 'finish' }] };
const context = { models: [{ id: 'model', name: 'model' }], servers: [] };
let restore: (() => void) | undefined;
beforeEach(() => {
  jest.clearAllMocks();
  mockCompletion.mockReset().mockImplementation(async () => { throw new Error('Offline provider fixture must be configured'); });
  jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model', name: 'fixture', provider: 'openai', ApiKey: '' } as never);
});
afterEach(() => { restore?.(); restore = undefined; jest.restoreAllMocks(); });

function fixture(explicit = true) {
  const graph = compileFlowSpec(spec, context).flow!;
  const definition = graph.nodes.find(candidate => candidate.type === 'process')!;
  const finishDefinition = graph.nodes.find(candidate => candidate.type === 'finish')!;
  if (!explicit) delete definition.data.properties!.terminalRouting;
  const edge = graph.edges.find(candidate => candidate.source === definition.id)!;
  const params: ProcessNodeParams = { id: definition.id, label: 'Process', type: 'process', properties: definition.data.properties as ProcessNodeProperties, orderedOutgoingEdges: [edge.id] };
  const node = new ProcessNode();
  const finish = new FinishNode();
  finish.node_params = { id: finishDefinition.id, label: 'Finish', type: 'finish', properties: {} };
  node.node_params = params;
  node.successors.set(edge.id, finish);
  const run = fixtureRun();
  const authorizeHandoffs = jest.fn((_value: object, names: string[]) => { if (names.length) throw new Error('restricted_handoffs_denied'); });
  const adapter = fixtureAdapter({ authorizeHandoffs });
  restore = registerExecutionExtension(adapter);
  const shared = { trackingInfo: { executionId: run.runId, startTime: 1, nodeExecutionTracker: [] },
    messages: [{ id: 'request', role: 'user', content: 'Answer directly', timestamp: 1 }], flowId: graph.id,
    flowSnapshot: graph, conversationId: run.conversation, title: 'Fixture', createdAt: 1, updatedAt: 1,
    executionExtensionContext: mintFixture(adapter, run),
  } as unknown as SharedState;
  return { node, finish, params, shared, edge, authorizeHandoffs, graph };
}

test('explicit authored policy round-trips through compiled immutable snapshots and is Advanced', () => {
  const compiled = compileFlowSpec(spec, context);
  expect(compiled.errorCount).toBe(0);
  const snapshot = JSON.parse(JSON.stringify(compiled.flow));
  expect(flowToSpec(snapshot).nodes.find(node => node.type === 'process')?.terminalRouting).toBe('tool-free');
  expect(flowUsesAdvancedFeatures(snapshot)).toBe(true);
  expect(validateFlow(snapshot, context).issues.filter(issue => issue.severity === 'error')).toEqual([]);
  const invalid = compileFlowSpec({ ...spec, nodes: spec.nodes.map(node => node.type === 'process' ? { ...node, terminalRouting: 'guess' as never } : node) }, context);
  expect(invalid.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid-terminal-routing', severity: 'error' })]));
});

test('selects no handoffs before restricted authorization/preparation and reaches real Finish', async () => {
  const { node, finish, params, shared, edge, authorizeHandoffs } = fixture();
  const prepareTools = jest.spyOn(ToolHandler, 'prepareTools');
  const call = jest.spyOn(ModelHandler, 'callModel').mockImplementation(async input => ({ success: true, value: { content: 'terminal answer', messages: input.messages, toolCalls: [], fullResponse: {} } }) as never);
  const prepared = await node.prep(shared, params);
  expect(prepared.availableTools).toEqual([]);
  expect(authorizeHandoffs).toHaveBeenCalledWith(expect.anything(), []);
  const result = await node.execCore(prepared, params);
  expect(call.mock.calls[0][0].tools).toBeUndefined();
  expect(prepareTools).not.toHaveBeenCalled();
  await expect(call.mock.calls[0][0].beforeToolDispatch!()).rejects.toThrow('denies tool dispatch');
  expect(await node.post(prepared, result, shared, params)).toBe(edge.id);
  const finishPrepared = await finish.prep(shared, finish.node_params);
  expect(await finish.post(finishPrepared, await finish.execCore(finishPrepared), shared)).toBe(FINAL_RESPONSE_ACTION);
});

test('absence retains existing synthetic handoffs and restricted adapter denial', async () => {
  const { node, params, shared, authorizeHandoffs } = fixture(false);
  await expect(node.prep(shared, params)).rejects.toThrow('restricted_handoffs_denied');
  expect(authorizeHandoffs.mock.calls[0][1]).toHaveLength(1);
});

test.each(['mcp', 'question', 'todo', 'sticky', 'cached-mcp', 'persona', 'resource'])('denies %s capability before handoff authorization or MCP preparation', async kind => {
  const { node, params, shared, authorizeHandoffs } = fixture();
  if (kind === 'mcp') params.properties!.mcpNodes = [{ id: 'mcp', properties: { boundServer: 'server' } }];
  if (kind === 'question') params.properties!.allowQuestion = true;
  if (kind === 'todo') params.properties!.enableTodoTool = true;
  if (kind === 'sticky') shared.armedSyntheticTools = ['read_resource'];
  if (kind === 'cached-mcp') shared.mcpContext = { server: 'server', availableTools: [{ name: 'server_read', server: 'server', inputSchema: { type: 'object', properties: {} } }] };
  if (kind === 'persona') params.properties!.personaTools = ['memory_search' as never];
  if (kind === 'resource') params.properties!.resourceNodes = [{ id: 'resource', properties: {} } as never];
  const processMCP = jest.spyOn(ToolHandler, 'processMCPNodes');
  await expect(node.prep(shared, params)).rejects.toThrow('cannot authorize executable tools');
  expect(processMCP).not.toHaveBeenCalled();
  expect(authorizeHandoffs).not.toHaveBeenCalled();
});

test.each(['conditioned', 'nonterminal', 'unknown-policy'])('fails closed for %s route policy', async kind => {
  const { node, params, shared, finish, authorizeHandoffs } = fixture();
  if (kind === 'conditioned') params.edgeConditions = { [params.orderedOutgoingEdges![0]]: { kind: 'always' } as never };
  if (kind === 'nonterminal') finish.node_params.type = 'process' as never;
  if (kind === 'unknown-policy') params.properties.terminalRouting = 'guess' as never;
  await expect(node.prep(shared, params)).rejects.toThrow(kind === 'unknown-policy' ? 'Invalid terminalRouting' : 'sole unconditioned Finish');
  expect(authorizeHandoffs).not.toHaveBeenCalled();
});

test('rejects ambiguous bare successors before authorization, and validator flags them', async () => {
  const { node, params, shared, finish, authorizeHandoffs, graph } = fixture();
  node.successors.set('second', finish);
  params.orderedOutgoingEdges!.push('second');
  graph.edges.push({ ...graph.edges[1], id: 'second' });
  await expect(node.prep(shared, params)).rejects.toThrow('sole unconditioned Finish');
  expect(authorizeHandoffs).not.toHaveBeenCalled();
  expect(validateFlow(graph, context).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'tool-free-terminal-route-invalid' })]));
});

test('rejects late advertised and model-invented tool calls', async () => {
  const { node, params, shared } = fixture();
  const prepared = await node.prep(shared, params);
  prepared.availableTools!.push({ name: 'handoff_to_finish', inputSchema: { type: 'object', properties: {} } });
  await expect(node.execCore(prepared, params)).resolves.toMatchObject({ success: false, error: 'Tool-free terminal routing cannot prepare executable tools' });
  prepared.availableTools = [];
  jest.spyOn(ModelHandler, 'callModel').mockResolvedValue({ success: true, value: { content: '', messages: [], fullResponse: {}, toolCalls: [{ id: 'invented', name: 'handoff_to_finish', args: {} }] } } as never);
  await expect(node.execCore(prepared, params)).resolves.toMatchObject({ success: false, error: 'Tool-free terminal routing denies model tool calls' });
});

test.each(['claude-cli', 'codex-cli', 'antigravity-cli'])('leaves native %s profile responsibility with its adapter', async adapter => {
  const { node, params, shared, authorizeHandoffs } = fixture();
  jest.spyOn(modelService, 'getModel').mockResolvedValue({ id: 'model', name: 'fixture', provider: 'openai', adapter, ApiKey: '' } as never);
  expect((await node.prep(shared, params)).availableTools).toEqual([]);
  expect(authorizeHandoffs).toHaveBeenCalledWith(expect.anything(), []);
});

test('real Process/ModelHandler rejects provider-invented handoffs and actual tool dispatch', async () => {
  const { node, params, shared } = fixture();
  shared.ephemeral = true;
  jest.spyOn(modelService, 'resolveAndDecryptApiKey').mockResolvedValue('fixture-key');
  const call = jest.spyOn(ModelHandler, 'callModel'); // call through actual handler
  mockCompletion.mockResolvedValue({ completion: {
    id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: 'invented', type: 'function', function: { name: 'handoff_to_finish', arguments: '{}' } }] }, logprobs: null }],
  } } as never);
  const prepared = await node.prep(shared, params);
  const result = await node.execCore(prepared, params);
  expect(result).toMatchObject({ success: false, error: 'Tool-free terminal routing denies model tool calls' });
  expect(mockCompletion).toHaveBeenCalledTimes(1);
  expect((mockCompletion.mock.calls[0][0] as { tools?: unknown }).tools).toBeUndefined();
  const hook = call.mock.calls[0][0].beforeToolDispatch!;
  for (const name of ['handoff_to_finish', 'todo', 'mcp_fixture_read']) {
    const dispatch = await ModelHandler.processToolCalls({ toolCalls: [{ id: 'attempt', type: 'function', function: { name, arguments: '{}' } }],
      messages: [], beforeToolDispatch: hook } as never);
    expect(dispatch.success).toBe(false);
  }
  expect(mcpService.callTool).not.toHaveBeenCalled();
});

test('real Process/ModelHandler completes a tool-free terminal answer through actual Finish', async () => {
  const { node, finish, params, shared, edge, authorizeHandoffs } = fixture();
  shared.ephemeral = true;
  jest.spyOn(modelService, 'resolveAndDecryptApiKey').mockResolvedValue('offline-fixture-key');
  const callModel = jest.spyOn(ModelHandler, 'callModel'); // observe actual handler
  const prepareTools = jest.spyOn(ToolHandler, 'prepareTools');
  const processMCP = jest.spyOn(ToolHandler, 'processMCPNodes');
  const dispatch = jest.spyOn(ModelHandler, 'processToolCalls');
  mockCompletion.mockResolvedValue({ completion: {
    id: 'terminal-fixture', object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null,
      message: { role: 'assistant', content: 'terminal answer', refusal: null } }],
  } } as never);

  const prepared = await node.prep(shared, params);
  expect(prepared.availableTools).toEqual([]);
  expect(authorizeHandoffs).toHaveBeenCalledWith(expect.anything(), []);
  const result = await node.execCore(prepared, params);
  expect(result).toMatchObject({ success: true, content: 'terminal answer' });
  expect(await node.post(prepared, result, shared, params)).toBe(edge.id);
  const finishPrepared = await finish.prep(shared, finish.node_params);
  const finishResult = await finish.execCore(finishPrepared, finish.node_params);
  expect(await finish.post(finishPrepared, finishResult, shared, finish.node_params)).toBe(FINAL_RESPONSE_ACTION);
  expect(shared.lastResponse).toBe('terminal answer');
  expect(shared.messages.filter(message => message.role === 'assistant' && message.content === 'terminal answer')).toHaveLength(1);

  expect(callModel).toHaveBeenCalledTimes(1);
  expect(callModel.mock.calls[0][0].tools).toBeUndefined();
  expect(mockCompletion).toHaveBeenCalledTimes(1);
  expect((mockCompletion.mock.calls[0][0] as { tools?: unknown }).tools).toBeUndefined();
  expect(prepareTools).not.toHaveBeenCalled();
  expect(processMCP).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(mcpService.callTool).not.toHaveBeenCalled();
});
