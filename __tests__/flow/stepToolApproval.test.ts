/**
 * A flow step can require a person's approval for its tools.
 *
 * The run-wide switch asks for every call or none. A step rule asks for the tools
 * that matter and holds regardless of who started the run. The real-run cases execute
 * nodes, runFlow and the adapter against a loopback provider that asks for tools. Only
 * the MCP layer is replaced, and its callTool is what must not fire before a decision.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';

const callToolMock = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    callTool: (...args: unknown[]) => callToolMock(...args),
    loadServerConfigs: async () => [],
    getClient: () => ({}),
    getClientGeneration: () => 0,
    getToolSchemaHash: () => undefined,
  };
  // Other probes, such as resource listings, have nothing to report in this fixture.
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
let mockBaseUrl = '';
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'approval-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'approval-model', name: 'approval-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { saveItem } from '@/utils/storage/backend';
import { flowRequiresStepApproval } from '@/utils/shared/flowApproval';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';

jest.setTimeout(30_000);

const READ_TOOL = encodeToolName('srv', 'read_it');
const WRITE_TOOL = encodeToolName('srv', 'write_it');
const SILENT_TOOL = encodeToolName('srv', 'silent_it');

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function flowWith(id: string, stepProperties: Record<string, unknown>): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('process', 'process', { boundModel: 'approval-model', promptTemplate: 'Work.', ...stepProperties }),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it', 'write_it', 'silent_it'] }),
    ],
    edges: [
      { id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'process', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

describe('real runs', () => {
  let server: Server;
  let requests: Array<{ tools?: unknown[] }> = [];
  let plannedCalls: string[] = [];

  function answer(response: ServerResponse, body: Record<string, unknown>) {
    const firstTurn = requests.length === 1;
    const toolCalls = firstTurn
      ? plannedCalls.map((name, index) => ({ id: `call_${index}`, index, type: 'function', function: { name, arguments: '{}' } }))
      : undefined;
    const message = { role: 'assistant', content: firstTurn ? null : 'all done', refusal: null, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    const finishReason = firstTurn ? 'tool_calls' : 'stop';
    const completion = { id: 'c', object: 'chat.completion', created: 1, model: 'approval-fixture' };
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
        choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: message.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
        choices: [{ index: 0, finish_reason: finishReason, delta: {} }] })}\n\ndata: [DONE]\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ...completion, choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message }] }));
    }
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        answer(response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await saveItem(StorageKey.MODELS, [{ id: 'approval-model', name: 'approval-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    plannedCalls = [READ_TOOL, WRITE_TOOL];
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'done' }] } });
    FlowExecutor.clearFlowCache();
    jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async (input) => {
      const tool = (name: string, annotations?: Record<string, unknown>) => ({
        name: encodeToolName('srv', name),
        originalName: name,
        server: 'srv',
        nodeId: input.mcpNodes?.[0]?.id,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        ...(annotations ? { annotations } : {}),
      });
      return { success: true, value: { availableTools: [tool('read_it', { readOnlyHint: true }), tool('write_it', { readOnlyHint: false }), tool('silent_it')] } };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    FlowExecutor.conversationStates.clear();
  });

  const start = (conversationId: string, stepProperties: Record<string, unknown>, extra: Record<string, unknown> = {}) => runFlow({
    conversationId,
    flowDefinition: flowWith(conversationId, stepProperties),
    prompt: 'Please work.',
    source: 'api',
    mode: 'conversation',
    flujo: true,
    userTurn: true,
    ...extra,
  });
  const calledTools = () => callToolMock.mock.calls.filter((call) => call[0] === 'srv').map((call) => call[1]);

  it('holds only the named tool and runs the rest without a click', async () => {
    const result = await start('step-named', { requireApprovalFor: ['write_it'] });

    expect(result.status).toBe('awaiting_tool_approval');
    expect(calledTools()).toEqual(['read_it']);
    expect(result.pendingToolCalls?.map((call) => call.function.name)).toEqual([WRITE_TOOL]);
  });

  it('runs the held tool after approval and then continues', async () => {
    const conversationId = 'step-approved';
    await start(conversationId, { requireApprovalFor: ['write_it'] });
    const state = FlowExecutor.conversationStates.get(conversationId)!;

    const decision = await applyApprovalDecision(state, 'call_1', 'approve');
    expect(decision.outcome).toBe('ready');
    expect(calledTools()).toEqual(['read_it', 'write_it']);

    const resumed = await runFlow({ conversationId, source: 'api', mode: 'conversation', flujo: true });
    expect(resumed.status).toBe('completed');
    expect(resumed.outputText).toBe('all done');
  });

  it('does not run the held tool after a rejection', async () => {
    const conversationId = 'step-rejected';
    await start(conversationId, { requireApprovalFor: ['write_it'] });
    const state = FlowExecutor.conversationStates.get(conversationId)!;

    await applyApprovalDecision(state, 'call_1', 'reject');
    const resumed = await runFlow({ conversationId, source: 'api', mode: 'conversation', flujo: true });

    expect(calledTools()).toEqual(['read_it']);
    expect(resumed.status).toBe('completed');
  });

  it('holds changing tools and tools without a hint, not read-only ones', async () => {
    plannedCalls = [READ_TOOL, WRITE_TOOL, SILENT_TOOL];

    const result = await start('step-writes', { requireApprovalForWrites: true });

    expect(result.status).toBe('awaiting_tool_approval');
    expect(calledTools()).toEqual(['read_it']);
    expect(result.pendingToolCalls?.map((call) => call.function.name)).toEqual([WRITE_TOOL, SILENT_TOOL]);
  });

  it('does not stop when the step rule does not cover the call', async () => {
    plannedCalls = [READ_TOOL];

    const result = await start('step-free', { requireApprovalForWrites: true });

    expect(result.status).toBe('completed');
    expect(calledTools()).toEqual(['read_it']);
  });

  it('runs everything unasked without a rule, as before', async () => {
    const result = await start('step-none', {});

    expect(result.status).toBe('completed');
    expect(calledTools().sort()).toEqual(['read_it', 'write_it']);
  });

  it('holds everything when the run asks for approval, as before', async () => {
    const result = await start('step-run-wide', { requireApprovalFor: ['write_it'] }, { requireApproval: true });

    expect(result.status).toBe('awaiting_tool_approval');
    expect(calledTools()).toEqual([]);
    expect(result.pendingToolCalls).toHaveLength(2);
  });

  it('fails without running anything when the run has no approver', async () => {
    const result = await start('step-fail', { requireApprovalFor: ['write_it'] }, { onApprovalRequired: 'fail' });

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ type: 'approval_required', name: WRITE_TOOL });
    expect(calledTools()).toEqual([]);
  });

  it('fails a transient run instead of skipping the rule, because it cannot come back', async () => {
    const result = await start('step-ephemeral', { requireApprovalFor: ['write_it'] }, { mode: 'ephemeral' });

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ type: 'approval_required' });
    expect(calledTools()).toEqual([]);
  });

  it('also holds the call when the client handles its own tools', async () => {
    const result = await start('step-client', { requireApprovalFor: ['write_it'] }, { flujo: false });

    expect(result.status).toBe('awaiting_tool_approval');
    expect(calledTools()).toEqual(['read_it']);
  });
});

describe('models that run their own tool loop', () => {
  // generateCompletion is private, but it is the handoff to the adapter this test observes.
  const spyOnGenerate = () => jest
    .spyOn(ModelHandler as unknown as { generateCompletion: (...args: unknown[]) => Promise<unknown> }, 'generateCompletion')
    .mockResolvedValue({
      success: true,
      value: { content: 'ok', fullResponse: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } },
    });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const gateFrom = async (requireToolApproval: boolean) => {
    const generate = spyOnGenerate();
    await ModelHandler.callModel({
      modelId: 'approval-model',
      prompt: 'Work.',
      messages: [{ role: 'user', content: 'Please work.' }],
      nodeName: 'Step',
      nodeId: 'process',
      conversationId: 'adapter-gate',
      requireToolApproval,
      onApprovalRequired: 'fail',
      toolNameMap: {
        [READ_TOOL]: { server: 'srv', tool: 'read_it' },
        [WRITE_TOOL]: { server: 'srv', tool: 'write_it', requiresApproval: true },
      },
    } as never);
    const options = generate.mock.calls[0]?.[4] as { requestToolApproval?: (call: { id: string; name: string; args: Record<string, unknown> }) => Promise<boolean> } | undefined;
    return options?.requestToolApproval;
  };

  it('lets an uncovered tool through and asks for a covered one', async () => {
    const gate = await gateFrom(false);
    expect(gate).toBeDefined();
    await expect(gate!({ id: 'a', name: READ_TOOL, args: {} })).resolves.toBe(true);
    await expect(gate!({ id: 'b', name: WRITE_TOOL, args: {} })).rejects.toThrow('requires approval');
  });

  it('also asks when the adapter uses its own spelling of the name', async () => {
    const gate = await gateFrom(false);
    await expect(gate!({ id: 'b', name: 'srv__write_it', args: {} })).rejects.toThrow('requires approval');
    await expect(gate!({ id: 'a', name: 'srv__read_it', args: {} })).resolves.toBe(true);
  });

  it('asks for everything when the run asks', async () => {
    const gate = await gateFrom(true);
    await expect(gate!({ id: 'a', name: READ_TOOL, args: {} })).rejects.toThrow('requires approval');
  });

  it('adds no gate when nothing asks for one', async () => {
    const generate = spyOnGenerate();
    await ModelHandler.callModel({
      modelId: 'approval-model',
      prompt: 'Work.',
      messages: [{ role: 'user', content: 'Please work.' }],
      nodeName: 'Step',
      nodeId: 'process',
      conversationId: 'adapter-gate',
      toolNameMap: { [READ_TOOL]: { server: 'srv', tool: 'read_it' } },
    } as never);
    const options = generate.mock.calls[0]?.[4] as { requestToolApproval?: unknown } | undefined;
    expect(options?.requestToolApproval).toBeUndefined();
  });
});

describe('authoring', () => {
  const context = {
    models: [{ id: 'm1', name: 'Model', displayName: 'Model' }],
    servers: [{ name: 'srv' }],
    serverTools: { srv: ['read_it', 'write_it'] },
  };
  const spec = (extra: Record<string, unknown>) => ({
    name: 'Approval',
    nodes: [
      { key: 'start', type: 'start' },
      { key: 'step', type: 'process', model: 'm1', prompt: 'Work.', servers: [{ name: 'srv', tools: ['read_it', 'write_it'] }], ...extra },
      { key: 'finish', type: 'finish' },
    ],
    edges: [{ from: 'start', to: 'step' }, { from: 'step', to: 'finish' }],
  });
  const stepProperties = (compiled: ReturnType<typeof compileFlowSpec>) =>
    compiled.flow!.nodes.find((candidate) => candidate.type === 'process')!.data.properties as Record<string, unknown>;

  it('carries the rules through the compiler and back', () => {
    const compiled = compileFlowSpec(spec({ requireApprovalFor: ['write_it'], requireApprovalForWrites: true }) as never, context as never);

    expect(stepProperties(compiled)).toMatchObject({ requireApprovalFor: ['write_it'], requireApprovalForWrites: true });
    const back = flowToSpec(compiled.flow!);
    expect(back.nodes?.find((candidate) => candidate.type === 'process')).toMatchObject({
      requireApprovalFor: ['write_it'],
      requireApprovalForWrites: true,
    });
  });

  it('adds nothing to a flow that does not use them', () => {
    const properties = stepProperties(compileFlowSpec(spec({}) as never, context as never));

    expect(properties.requireApprovalFor).toBeUndefined();
    expect(properties.requireApprovalForWrites).toBeUndefined();
  });

  it.each([
    ['requireApprovalFor', 'write_it', 'invalid-require-approval-for'],
    ['requireApprovalForWrites', 'yes', 'invalid-require-approval-for-writes'],
  ])('stops the compile on a malformed %s rather than dropping the rule', (field, value, code) => {
    const compiled = compileFlowSpec(spec({ [field]: value }) as never, context as never);

    expect(compiled.issues.map((issue) => issue.code)).toContain(code);
    expect(compiled.errorCount).toBeGreaterThan(0);
  });

  it('warns when a named tool is not offered in that step', () => {
    const flow = flowWith('unknown-tool', { requireApprovalFor: ['write_it', 'not_there'] });

    const issues = validateFlow(flow as never).issues.filter((issue) => issue.code === 'require-approval-unknown-tool');

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('not_there');
  });

  it('finds flows that use a rule', () => {
    expect(flowRequiresStepApproval(flowWith('a', { requireApprovalFor: ['write_it'] }))).toBe(true);
    expect(flowRequiresStepApproval(flowWith('b', { requireApprovalForWrites: true }))).toBe(true);
    expect(flowRequiresStepApproval(flowWith('c', { requireApprovalFor: [] }))).toBe(false);
    expect(flowRequiresStepApproval(flowWith('d', {}))).toBe(false);
    expect(flowRequiresStepApproval(null)).toBe(false);
  });
});
