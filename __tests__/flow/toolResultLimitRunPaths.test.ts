/**
 * The tool result size limit (#1226) on the run paths it used to miss: a call a
 * person approved, a subflow that saves nothing, a run with no saved
 * conversation at all, and an AI step's own limit. Nodes, runFlow, the
 * approval decision, the OpenAI adapter and the run resource store are real;
 * a loopback provider plays the model and only the MCP layer is replaced.
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
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
let mockBaseUrl = '';
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'limit-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'limit-model', name: 'limit-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import {
  UNSAVED_RUN_STORE_PREFIX,
  sweepUnsavedRunStores,
  toolResultStoreFor,
} from '@/backend/execution/flow/stepToolResults';
import type { SharedState } from '@/backend/execution/flow/types';
import { saveItem } from '@/utils/storage/backend';
import {
  _clearRunResourceSettingsCache,
  listRunResourceStoreIds,
  listRunResources,
  readRunResource,
  updateToolResultLimitSettings,
  writeRunResource,
} from '@/backend/services/runResources';

jest.setTimeout(30_000);

const READ_TOOL = encodeToolName('srv', 'read_it');
/** 6,000 bytes: over a 1 KB step limit, far under half of any model's window. */
const BIG_RESULT = Array.from({ length: 120 }, (_, line) => `line ${line} ${'x'.repeat(40)}`).join('\n');
/** The first and last lines, as they appear inside the JSON text of the tool message. */
const HEAD = `line 0 ${'x'.repeat(10)}`;
const TAIL = `line 119 ${'x'.repeat(40)}`;
const RUN_LINK = /flujo:\/\/run\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/;

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function flowWith(id: string, stepProperties: Record<string, unknown>): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('process', 'process', { boundModel: 'limit-model', promptTemplate: 'Work.', ...stepProperties }),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it'] }),
    ],
    edges: [
      { id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'process', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

type WireMessage = { role: string; content?: unknown; tool_call_id?: string };
type WireRequest = { messages: WireMessage[]; tools?: Array<{ function: { name: string } }> };

const lastToolText = (request: WireRequest | undefined): string => {
  const tool = request?.messages.filter((message) => message.role === 'tool').at(-1);
  return typeof tool?.content === 'string' ? tool.content : JSON.stringify(tool?.content ?? '');
};

describe('tool result size limit on every run path (#1226)', () => {
  let server: Server;
  let requests: WireRequest[] = [];
  /** Read the moved result back with read_resource before answering. */
  let readBack = false;

  function answer(response: ServerResponse, body: WireRequest & { stream?: boolean }) {
    const turn = requests.length;
    const link = RUN_LINK.exec(lastToolText(body))?.[0];
    const offersRead = (body.tools ?? []).some((tool) => tool.function.name === 'read_resource');
    const call = turn === 1
      ? { name: READ_TOOL, arguments: '{}' }
      : readBack && turn === 2 && link && offersRead
        ? { name: 'read_resource', arguments: JSON.stringify({ uri: link, max_chars: 200 }) }
        : undefined;
    const toolCalls = call ? [{ id: `call_${turn}`, index: 0, type: 'function', function: call }] : undefined;
    const message = { role: 'assistant', content: call ? null : 'all done', refusal: null, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    const finishReason = call ? 'tool_calls' : 'stop';
    const completion = { id: 'c', object: 'chat.completion', created: 1, model: 'limit-fixture' };
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
    await saveItem(StorageKey.MODELS, [{ id: 'limit-model', name: 'limit-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    requests = [];
    readBack = false;
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: BIG_RESULT }] } });
    FlowExecutor.clearFlowCache();
    _clearRunResourceSettingsCache();
    await updateToolResultLimitSettings({ toolResultTruncationEnabled: false });
    jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async (input) => ({
      success: true,
      value: {
        availableTools: [{
          name: READ_TOOL, originalName: 'read_it', server: 'srv', nodeId: input.mcpNodes?.[0]?.id,
          description: 'read_it', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true },
        }],
      },
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    FlowExecutor.conversationStates.clear();
  });

  const start = (flow: Flow, extra: Record<string, unknown>) => runFlow({
    flowDefinition: flow, prompt: 'Please work.', source: 'api', mode: 'conversation', flujo: true, userTurn: true, ...extra,
  });
  const fullResultIn = async (store: string) => {
    const entries = (await listRunResources(store)).filter((entry) => entry.producedBy.source === 'tool-result');
    const texts = await Promise.all(entries.map(async (entry) => (await readRunResource(entry.uri))?.contents.contents[0]));
    return texts.some((content) => content && 'text' in content && String(content.text).includes(TAIL));
  };

  it('a call a person approved keeps its moved result in the chat and runs as part of the run', async () => {
    const conversationId = 'approved-big';
    const flow = flowWith(conversationId, { requireApprovalFor: ['read_it'], toolResultLimit: { mode: 'custom', maxBytes: 1024 } });
    const paused = await start(flow, { conversationId });
    expect(paused.status).toBe('awaiting_tool_approval');
    const state = FlowExecutor.conversationStates.get(conversationId)!;

    const decision = await applyApprovalDecision(state, 'call_1', 'approve');

    expect(decision.outcome).toBe('ready');
    const toolMessage = state.messages.filter((message) => message.role === 'tool').at(-1)!;
    expect(String(toolMessage.content)).toMatch(new RegExp(`flujo://run/${conversationId}/`));
    expect(String(toolMessage.content).length).toBeLessThan(BIG_RESULT.length);
    expect(await fullResultIn(conversationId)).toBe(true);
    // The same owner as a call that needed no approval, so Bash sessions it starts end with the run.
    expect(callToolMock.mock.calls[0][8]).toBe(`run:${state.logicalRunId}`);

    const resumed = await runFlow({ conversationId, source: 'api', mode: 'conversation', flujo: true });
    expect(resumed.status).toBe('completed');
    expect(lastToolText(requests.at(-1))).toMatch(new RegExp(`flujo://run/${conversationId}/`));
  });

  it('an AI step\'s own limit wins over the workspace setting, both ways', async () => {
    await updateToolResultLimitSettings({ toolResultTruncationEnabled: true, toolResultLimitMode: 'custom', toolResultMaxBytes: 1024 });

    const kept = await start(flowWith('step-off', { toolResultLimit: { mode: 'off' } }), { conversationId: 'step-off' });
    expect(kept.status).toBe('completed');
    expect(lastToolText(requests.at(-1))).toContain(TAIL);
    expect(lastToolText(requests.at(-1))).not.toMatch(RUN_LINK);

    requests = [];
    await updateToolResultLimitSettings({ toolResultTruncationEnabled: false });
    const moved = await start(flowWith('step-custom', { toolResultLimit: { mode: 'custom', maxBytes: 1024 } }), { conversationId: 'step-custom' });
    expect(moved.status).toBe('completed');
    expect(lastToolText(requests.at(-1))).toMatch(/flujo:\/\/run\/step-custom\//);
    expect(await fullResultIn('step-custom')).toBe(true);
  });

  it('a subflow that saves nothing keeps moved results in the chat that started it, where the model can read them', async () => {
    readBack = true;
    const parent = { conversationId: 'parent-chat', flowId: 'parent', messages: [], status: 'running' } as unknown as SharedState;
    FlowExecutor.conversationStates.set('parent-chat', parent);

    const child = await start(flowWith('child', { toolResultLimit: { mode: 'custom', maxBytes: 1024 } }), {
      mode: 'ephemeral', source: 'subflow', parentRunId: 'parent-chat', userTurn: false,
    });

    expect(child.status).toBe('completed');
    expect(RUN_LINK.exec(lastToolText(requests[1]))?.[1]).toBe('parent-chat');
    expect(await fullResultIn('parent-chat')).toBe(true);
    // The model read the moved result back with read_resource and got its first characters.
    expect(lastToolText(requests[2])).toContain(HEAD);
  });

  it('a run with no saved conversation above it keeps a store of its own and removes it when it ends', async () => {
    const run = await start(flowWith('alone', { toolResultLimit: { mode: 'custom', maxBytes: 1024 } }), { mode: 'ephemeral' });

    expect(run.status).toBe('completed');
    const store = RUN_LINK.exec(lastToolText(requests[1]))?.[1];
    expect(store).toBe(`${UNSAVED_RUN_STORE_PREFIX}${run.conversationId}`);
    for (let attempt = 0; attempt < 100 && (await listRunResourceStoreIds(store!)).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await listRunResourceStoreIds(store!)).toEqual([]);
  });

  it('the hourly sweep removes stores of runs that are gone and keeps those still running', async () => {
    const write = (store: string) => writeRunResource({
      conversationId: store, mimeType: 'text/plain', kind: 'text', data: { text: 'left behind' },
      producedBy: { source: 'tool-result', payloadRole: 'tool-message', toolCallId: 'call' },
    });
    await write(`${UNSAVED_RUN_STORE_PREFIX}gone-run`);
    await write(`${UNSAVED_RUN_STORE_PREFIX}live-run`);
    FlowExecutor.conversationStates.set('live-run', { conversationId: 'live-run', ephemeral: true } as unknown as SharedState);

    const swept = await sweepUnsavedRunStores();

    expect(swept.removed).toBe(1);
    expect(await listRunResourceStoreIds(UNSAVED_RUN_STORE_PREFIX)).toEqual([`${UNSAVED_RUN_STORE_PREFIX}live-run`]);
    await sweepUnsavedRunStores();
    FlowExecutor.conversationStates.delete('live-run');
    expect((await sweepUnsavedRunStores()).removed).toBe(1);
  });
});

describe('where a run keeps moved results', () => {
  const states = new Map<string, Partial<SharedState>>([
    ['chat', { conversationId: 'chat' }],
    ['saved-child', { conversationId: 'saved-child', parentConversationId: 'chat' }],
    ['lane', { conversationId: 'lane', ephemeral: true, parentConversationId: 'saved-child' }],
  ]);
  const at = (state: Partial<SharedState>) => toolResultStoreFor(state as SharedState, states as Map<string, SharedState>);

  it('a saved run keeps its own', () => {
    expect(at({ conversationId: 'chat' })).toBe('chat');
  });

  it('a run that saves nothing uses the nearest saved conversation above it', () => {
    expect(at({ conversationId: 'x', ephemeral: true, parentConversationId: 'lane' })).toBe('saved-child');
    expect(at({ conversationId: 'y', ephemeral: true, parentRunId: 'chat' })).toBe('chat');
  });

  it('a run with nothing saved above it, or a broken chain, gets a store of its own', () => {
    expect(at({ conversationId: 'z', ephemeral: true })).toBe(`${UNSAVED_RUN_STORE_PREFIX}z`);
    expect(at({ conversationId: 'z', ephemeral: true, parentConversationId: 'missing' })).toBe(`${UNSAVED_RUN_STORE_PREFIX}z`);
  });
});
