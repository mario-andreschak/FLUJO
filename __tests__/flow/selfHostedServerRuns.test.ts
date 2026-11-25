/**
 * Issue #1367: flows that run on a self-hosted OpenAI-compatible server (vLLM
 * serving Qwen), saved under the provider "openai" with its own address.
 *
 * 1. The system message stays first; Qwen's template refuses it anywhere else.
 * 2. Token counts are asked for, and a call the server does not count is
 *    "not reported" rather than 0.
 * 3. A message sent after a model handed off to a Finish step reaches a model
 *    again. Before the fix the conversation stayed on the Finish step, so the
 *    next message was stored, no model was called and the run said "completed".
 *
 * These are real runs: converter, nodes, runFlow and the OpenAI-compatible
 * adapter against a loopback server, which records what reaches it.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';

const mockFlows = new Map<string, Flow>();
let mockBaseUrl = '';
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockFlows.get(id) ?? null,
    loadFlows: async () => [...mockFlows.values()],
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'finish-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'finish-model', name: 'finish-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { saveItem } from '@/utils/storage/backend';
import { nodeAfterFinishStep } from '@/backend/execution/flow/finishReentry';

jest.setTimeout(30_000);

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

/** Start -> Process -> Finish, the flow from the issue. */
function finishFlow(id: string): Flow {
  const definition = {
    id,
    name: id,
    nodes: [
      node('start', 'start', { promptTemplate: 'You are a worker.' }),
      node('process', 'process', { boundModel: 'finish-model', promptTemplate: 'Do the task, then finish.' }),
      node('end', 'finish'),
    ],
    edges: [
      { id: 'start-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'process-end', source: 'process', target: 'end', data: { edgeType: 'standard' } },
    ],
  } as unknown as Flow;
  mockFlows.set(id, definition);
  return definition;
}

type WireBody = {
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  messages?: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
};

/** What the scripted model does with the next request. */
let script: Array<'handoff' | 'text'> = [];
/** Off: the server sends no token counts at all, like many self-hosted servers. */
let serverCountsTokens = true;
const USAGE = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };

function answer(response: ServerResponse, body: WireBody, requestNumber: number) {
  const step = script.shift() ?? 'text';
  const handoff = body.tools?.find(tool => tool.function.name.startsWith('handoff_to_'));
  const toolCalls = step === 'handoff' && handoff
    ? [{ id: `call_${requestNumber}`, type: 'function', function: { name: handoff.function.name, arguments: '{}' } }]
    : undefined;
  const message = toolCalls
    ? { role: 'assistant', content: 'Done, finishing.', refusal: null, tool_calls: toolCalls }
    : { role: 'assistant', content: `answer ${requestNumber}`, refusal: null };
  const finishReason = toolCalls ? 'tool_calls' : 'stop';
  if (body.stream) {
    const delta = toolCalls
      ? { ...message, tool_calls: toolCalls.map((call, index) => ({ index, ...call })) }
      : message;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: `c${requestNumber}`, object: 'chat.completion.chunk', created: 1,
      model: 'finish-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
    // vLLM sends usage in a last chunk with no choices, and only when asked.
    if (serverCountsTokens && body.stream_options?.include_usage) {
      response.write(`data: ${JSON.stringify({ id: `c${requestNumber}`, object: 'chat.completion.chunk', created: 1,
        model: 'finish-fixture', choices: [], usage: USAGE })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: `c${requestNumber}`, object: 'chat.completion', created: 1, model: 'finish-fixture',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(serverCountsTokens ? { usage: USAGE } : {}) }));
}

let server: Server;
const requests: WireBody[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
      requests.push(body);
      answer(response, body, requests.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  await saveItem(StorageKey.MODELS, [{ id: 'finish-model', name: 'finish-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  script = [];
  serverCountsTokens = true;
  FlowExecutor.clearFlowCache();
});

const turn = (conversationId: string, prompt: string, extra: Record<string, unknown> = {}) => runFlow({
  conversationId, flowId: conversationId, prompt, source: 'api', mode: 'conversation', userTurn: true, ...extra,
});
const wireText = (body: WireBody) => (body.messages ?? []).map(message =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');

describe('a self-hosted server saved as "openai"', () => {
  it('gets the system message first', async () => {
    const conversationId = 'self-hosted-order';
    finishFlow(conversationId);
    await turn(conversationId, 'First task');

    const roles = (requests[0].messages ?? []).map(message => message.role);
    expect(roles[0]).toBe('system');
    expect(roles.lastIndexOf('system')).toBeLessThan(roles.indexOf('user'));
  });

  it('is asked for token counts and its counts are kept', async () => {
    const conversationId = 'self-hosted-usage';
    finishFlow(conversationId);
    await turn(conversationId, 'First task');

    expect(requests[0].stream_options).toEqual({ include_usage: true });
    const state = FlowExecutor.conversationStates.get(conversationId);
    expect(state?.usage).toEqual(expect.objectContaining({ promptTokens: 10, completionTokens: 2, totalTokens: 12 }));
    expect(state?.usage?.unreportedCalls).toBeUndefined();
  });

  it('counts a call without token counts as not reported instead of 0', async () => {
    const conversationId = 'self-hosted-no-usage';
    finishFlow(conversationId);
    serverCountsTokens = false;
    await turn(conversationId, 'First task');

    const state = FlowExecutor.conversationStates.get(conversationId);
    expect(state?.usage).toEqual(expect.objectContaining({ totalTokens: 0, unreportedCalls: 1 }));
    expect(state?.usage?.byNode.process).toEqual(expect.objectContaining({ unreportedCalls: 1 }));
    const reply = state?.messages.findLast(message => message.role === 'assistant');
    expect(reply).toEqual(expect.objectContaining({ usageNotReported: true }));
    expect(reply).not.toHaveProperty('usage');

    // The display-only mark never reaches the server on the next call.
    script = ['text'];
    await turn(conversationId, 'Second task', { prompt: undefined, messages: state!.messages
      .filter(message => message.role !== 'system')
      .concat([{ role: 'user', content: 'Second task', id: 'u2', timestamp: Date.now() }]) });
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].messages)).not.toContain('usageNotReported');
  });
});

describe('a message after a Finish step', () => {
  it('reaches the model again after the model handed off to Finish', async () => {
    const conversationId = 'finish-follow-up';
    finishFlow(conversationId);
    script = ['handoff'];

    const first = await turn(conversationId, 'First task');
    expect(first.status).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(FlowExecutor.conversationStates.get(conversationId)?.currentNodeId).toBe('end');

    script = ['text'];
    const second = await turn(conversationId, 'Second task');

    expect(requests).toHaveLength(2);
    expect(second.status).toBe('completed');
    expect(second.outputText).toBe('answer 2');
    expect(wireText(requests[1])).toContain('Second task');
  });

  it('reaches the model again when the caller sends the whole history', async () => {
    const conversationId = 'finish-full-history';
    finishFlow(conversationId);
    script = ['handoff'];
    await turn(conversationId, 'First task');
    expect(requests).toHaveLength(1);

    script = ['text'];
    const second = await turn(conversationId, 'Second task', {
      prompt: undefined,
      messages: [
        { role: 'user', content: 'First task' },
        { role: 'assistant', content: 'Done, finishing.' },
        { role: 'user', content: 'Second task' },
      ],
    });

    expect(requests).toHaveLength(2);
    expect(second.outputText).toBe('answer 2');
    expect(wireText(requests[1])).toContain('First task');
    expect(wireText(requests[1])).toContain('Second task');
  });

  it('starts at the step that last answered, then can finish again', async () => {
    const conversationId = 'finish-again';
    finishFlow(conversationId);
    script = ['handoff'];
    await turn(conversationId, 'First task');

    const realStep = FlowExecutor.executeStep;
    const entered: Array<string | undefined> = [];
    const executeStep = jest.spyOn(FlowExecutor, 'executeStep').mockImplementation(async (state, emit) => {
      entered.push(state.currentNodeId);
      return realStep.call(FlowExecutor, state, emit);
    });
    script = ['handoff'];
    const second = await turn(conversationId, 'Second task', { prompt: undefined, messages: [
      { role: 'user', content: 'First task' },
      { role: 'assistant', content: 'Done, finishing.' },
      { role: 'user', content: 'Second task' },
    ] });
    executeStep.mockRestore();

    expect(entered[0]).toBe('process');
    expect(requests).toHaveLength(2);
    expect(second.status).toBe('completed');
    expect(FlowExecutor.conversationStates.get(conversationId)?.currentNodeId).toBe('end');
  });

  it('still lets a caller name the step to run', async () => {
    const conversationId = 'finish-named-step';
    finishFlow(conversationId);
    script = ['handoff'];
    await turn(conversationId, 'First task');

    script = ['text'];
    const second = await turn(conversationId, 'Second task', { processNodeId: 'process' });

    expect(requests).toHaveLength(2);
    expect(second.outputText).toBe('answer 2');
  });

  it('keeps a model that answered in plain text on its step', async () => {
    const conversationId = 'finish-plain-text';
    finishFlow(conversationId);
    script = ['text'];
    await turn(conversationId, 'First task');
    expect(FlowExecutor.conversationStates.get(conversationId)?.currentNodeId).toBe('process');

    script = ['text'];
    const second = await turn(conversationId, 'Second task');

    expect(requests).toHaveLength(2);
    expect(second.outputText).toBe('answer 2');
  });
});

describe('nodeAfterFinishStep', () => {
  const flow = {
    nodes: [node('start', 'start'), node('process', 'process'), node('static', 'static'), node('end', 'finish')],
  };

  it('does nothing when the conversation is not at a Finish step', () => {
    expect(nodeAfterFinishStep(flow, 'process', [{ role: 'assistant', processNodeId: 'process' }])).toBeUndefined();
    expect(nodeAfterFinishStep(flow, undefined, [])).toBeUndefined();
  });

  it('picks the model step that answered last', () => {
    expect(nodeAfterFinishStep(flow, 'end', [
      { role: 'assistant', processNodeId: 'process' },
      { role: 'assistant', processNodeId: 'static' },
      { role: 'user', processNodeId: undefined },
    ])).toBe('process');
  });

  it('falls back to Start when no model step answered or that step is gone', () => {
    expect(nodeAfterFinishStep(flow, 'end', [{ role: 'user' }])).toBe('start');
    expect(nodeAfterFinishStep(flow, 'end', [{ role: 'assistant', processNodeId: 'deleted' }])).toBe('start');
  });
});
