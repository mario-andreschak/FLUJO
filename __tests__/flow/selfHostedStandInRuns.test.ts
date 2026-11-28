/**
 * Issue #1367, checked without a GPU or a real server: FLUJO's real model path
 * (runFlow, the nodes, ModelHandler, compaction and the OpenAI-compatible
 * adapter) against a local stand-in that answers like vLLM, llama.cpp,
 * LM Studio and Ollama serving Qwen 3.5. The stand-in applies each server's
 * own rules for system messages, token counts, finish reasons and cut-off
 * tool calls; `__tests__/helpers/selfHostedServerStandIn.ts` names the
 * source of every rule.
 */
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';
import {
  SELF_HOSTED_SERVER_KINDS,
  SelfHostedServerStandIn,
  STAND_IN_MODEL,
  type SelfHostedServerKind,
  type StandInRequest,
} from '../helpers/selfHostedServerStandIn';

const mockFlows = new Map<string, Flow>();
const mockModels = new Map<string, Model>();
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockFlows.get(id) ?? null,
    loadFlows: async () => [...mockFlows.values()],
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string) => mockModels.get(id) ?? null,
    loadModels: async () => [...mockModels.values()],
    resolveAndDecryptApiKey: async () => 'not-needed',
  },
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { getCompletionAdapter } from '@/backend/services/model/adapters';
import { saveItem } from '@/utils/storage/backend';

jest.setTimeout(120_000);

/** vLLM reports `max_model_len` in /v1/models and FLUJO keeps it as the context window. */
const CONTEXT_WINDOW = 32_768;
/** Small enough that the long conversation below has to be compacted. */
const SMALL_CONTEXT_WINDOW = 6_000;

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target, data: { edgeType: 'standard' } });

/** Start -> Process -> Finish, the worker flow from the issue. */
function workerFlow(id: string, modelId: string, processProperties: Record<string, unknown> = {}): void {
  mockFlows.set(id, {
    id, name: id,
    nodes: [
      node('start', 'start', { promptTemplate: 'You are an unattended worker.' }),
      node('process', 'process', { boundModel: modelId, promptTemplate: 'Do the task, then hand off to Finish.', ...processProperties }),
      node('end', 'finish'),
    ],
    edges: [edge('start', 'process'), edge('process', 'end')],
  } as unknown as Flow);
}

/** Start -> Planner -> Writer -> Finish: the Writer continues the Planner's conversation. */
function twoStepFlow(id: string, modelId: string): void {
  mockFlows.set(id, {
    id, name: id,
    nodes: [
      node('start', 'start', { promptTemplate: 'You are an unattended worker.' }),
      node('planner', 'process', { boundModel: modelId, promptTemplate: 'Plan the work, then hand off to the writer.' }),
      node('writer', 'process', { boundModel: modelId, promptTemplate: 'Write the result, then hand off to Finish.' }),
      node('end', 'finish'),
    ],
    edges: [edge('start', 'planner'), edge('planner', 'writer'), edge('writer', 'end')],
  } as unknown as Flow);
}

const servers = new Map<SelfHostedServerKind, SelfHostedServerStandIn>();
const modelFor = (kind: SelfHostedServerKind, baseUrl: string, extra: Partial<Model> = {}): Model => ({
  id: `self-hosted-${kind}`,
  name: STAND_IN_MODEL,
  // vLLM, llama.cpp and LM Studio are saved as "openai" with their own address (the issue's setup).
  provider: kind === 'ollama' ? 'ollama' : 'openai',
  adapter: 'openai',
  ApiKey: '',
  baseUrl,
  contextWindow: CONTEXT_WINDOW,
  ...extra,
} as Model);

beforeAll(async () => {
  for (const kind of SELF_HOSTED_SERVER_KINDS) {
    const server = await SelfHostedServerStandIn.start(kind, { maxModelLen: CONTEXT_WINDOW });
    servers.set(kind, server);
    mockModels.set(`self-hosted-${kind}`, modelFor(kind, server.baseUrl));
  }
  await saveItem(StorageKey.MODELS, [...mockModels.values()]);
});

afterAll(async () => {
  await Promise.all([...servers.values()].map(server => server.close()));
});

beforeEach(() => {
  for (const server of servers.values()) server.reset();
  FlowExecutor.clearFlowCache();
});

let conversationNumber = 0;
const roles = (request: StandInRequest) => (request.messages ?? []).map(message => message.role);
const wireText = (request: StandInRequest) => JSON.stringify(request.messages ?? []);
const systemFirstAndAlone = (request: StandInRequest) => {
  expect(roles(request)[0]).toBe('system');
  expect(roles(request).filter(role => role === 'system')).toHaveLength(1);
};

describe.each(SELF_HOSTED_SERVER_KINDS)('a flow on %s serving Qwen 3.5', (kind) => {
  const server = () => servers.get(kind)!;
  const modelId = `self-hosted-${kind}`;
  const newConversation = (build: (id: string, model: string) => void = workerFlow) => {
    const conversationId = `stand-in-${kind.replace(/[^a-z0-9]/g, '-')}-${++conversationNumber}`;
    build(conversationId, modelId);
    return conversationId;
  };
  const turn = (conversationId: string, input: { prompt: string } | { messages: Array<{ role: 'user' | 'assistant'; content: string }> }) =>
    runFlow({ conversationId, flowId: conversationId, source: 'api', mode: 'conversation', userTurn: true, ...input });

  it('sends one system message, first, and keeps the token counts the server reports', async () => {
    const conversationId = newConversation();
    const result = await turn(conversationId, { prompt: 'First task' });

    expect(server().refusals).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('answer 1');
    const [request] = server().answered;
    systemFirstAndAlone(request);
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
    const usage = FlowExecutor.conversationStates.get(conversationId)?.usage;
    expect(usage?.promptTokens).toBeGreaterThan(0);
    expect(usage?.completionTokens).toBeGreaterThan(0);
    expect(usage?.totalTokens).toBe((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0));
    expect(usage?.unreportedCalls).toBeUndefined();
  });

  it('answers a message sent after the model handed off to Finish', async () => {
    const conversationId = newConversation();
    server().script = [{ call: 'handoff_to_', args: {}, say: 'Done, finishing.' }];
    const first = await turn(conversationId, { prompt: 'First task' });
    expect(first.status).toBe('completed');
    expect(FlowExecutor.conversationStates.get(conversationId)?.currentNodeId).toBe('end');

    server().script = [{ say: 'Second answer' }];
    const second = await turn(conversationId, { messages: [
      { role: 'user', content: 'First task' },
      { role: 'assistant', content: 'Done, finishing.' },
      { role: 'user', content: 'Second task' },
    ] });

    expect(server().refusals).toEqual([]);
    expect(server().answered).toHaveLength(2);
    expect(second.status).toBe('completed');
    expect(second.outputText).toBe('Second answer');
    const followUp = server().answered[1];
    systemFirstAndAlone(followUp);
    expect(wireText(followUp)).toContain('First task');
    expect(wireText(followUp)).toContain('Second task');
  });

  it('runs a tool, sends its result back and gets the final answer in the same turn', async () => {
    const conversationId = newConversation((id, model) => workerFlow(id, model, { enableTodoTool: true }));
    server().script = [
      { call: 'todo', args: { items: [{ content: 'Read the report', status: 'done' }] }, say: 'Tracking the work.' },
      { say: 'The report is read.' },
    ];
    const result = await turn(conversationId, { prompt: 'Read the report' });

    expect(server().refusals).toEqual([]);
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('The report is read.');
    const [, afterTool] = server().answered;
    systemFirstAndAlone(afterTool);
    // The task list goes last, as a user turn (#259).
    expect(roles(afterTool)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(String(afterTool.messages?.at(-1)?.content)).toContain('Current task list');
    expect(FlowExecutor.conversationStates.get(conversationId)?.todos?.[0]).toEqual(expect.objectContaining({ content: 'Read the report' }));
  });

  it('lets a second step continue the first step\'s conversation', async () => {
    const conversationId = newConversation(twoStepFlow);
    server().script = [
      { call: 'handoff_to_', args: {}, say: 'The plan is ready.' },
      { say: 'The result is written.' },
    ];
    const result = await turn(conversationId, { prompt: 'Plan and write' });

    expect(server().refusals).toEqual([]);
    expect(result.outputText).toBe('The result is written.');
    const writer = server().answered[1];
    systemFirstAndAlone(writer);
    expect(wireText(writer)).toContain('Write the result');
    expect(wireText(writer)).not.toContain('Plan the work');
    expect(wireText(writer)).toContain('Plan and write');
  });

  it('never runs a tool call that the output limit cut off, and the next message still gets an answer', async () => {
    const conversationId = newConversation();
    server().script = [{ cutOffCall: 'handoff_to_', args: { prompt: 'Summarize the report for the night shift and list every open ticket' }, say: 'Handing off now.' }];
    const first = await turn(conversationId, { prompt: 'First task' });

    const state = FlowExecutor.conversationStates.get(conversationId);
    expect(state?.currentNodeId).toBe('process');
    const reply = state?.messages.findLast(message => message.role === 'assistant');
    expect(reply?.tool_calls ?? []).toEqual([]);
    expect(reply).toEqual(expect.objectContaining({ cutOff: 'length' }));
    expect(first.outputText).toContain('Handing off now.');

    server().script = [{ say: 'Second answer' }];
    const second = await turn(conversationId, { messages: [
      { role: 'user', content: 'First task' },
      { role: 'assistant', content: first.outputText ?? '' },
      { role: 'user', content: 'Second task' },
    ] });
    expect(server().refusals).toEqual([]);
    expect(second.outputText).toBe('Second answer');
  });

  it('summarizes a long conversation through the same server, and the compacted turn is accepted', async () => {
    // A small context window makes FLUJO compact; the summary request and the compacted turn both go to the server.
    const smallServer = await SelfHostedServerStandIn.start(kind, { maxModelLen: SMALL_CONTEXT_WINDOW });
    try {
      mockModels.set(`${modelId}-small`, modelFor(kind, smallServer.baseUrl, { id: `${modelId}-small`, contextWindow: SMALL_CONTEXT_WINDOW }));
      await saveItem(StorageKey.MODELS, [...mockModels.values()]);
      const conversationId = newConversation((id) => workerFlow(id, `${modelId}-small`));
      const filler = (seed: number) => Array.from({ length: 120 }, (_, index) => `w${seed}x${index}`).join(' ');
      const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (let index = 0; index < 12; index++) {
        history.push({ role: 'user', content: `Task ${index}: ${filler(index)}` });
        history.push({ role: 'assistant', content: `Reply ${index}: ${filler(index + 100)}` });
      }
      history.push({ role: 'user', content: 'Final task' });
      smallServer.script = [{ say: 'Final answer' }];

      const result = await turn(conversationId, { messages: history });

      expect(smallServer.refusals).toEqual([]);
      expect({ status: result.status, error: result.error?.message, calls: smallServer.answered.map(roles) })
        .toEqual(expect.objectContaining({ status: 'completed', error: undefined }));
      expect(result.outputText).toBe('Final answer');
      expect(smallServer.summaries).toBeGreaterThan(0);
      const summaryRequest = smallServer.answered[0];
      const compacted = smallServer.answered.at(-1)!;
      expect(roles(summaryRequest)[0]).toBe('system');
      expect(roles(summaryRequest).filter(role => role === 'system')).toHaveLength(1);
      expect(roles(summaryRequest)).toContain('user');
      systemFirstAndAlone(compacted);
      expect(wireText(compacted)).toContain('## Objective');
      expect(wireText(compacted)).toContain('Final task');
    } finally {
      await smallServer.close();
    }
  });

  it('starts a run that has no input', async () => {
    const conversationId = newConversation();
    const result = await runFlow({ conversationId, flowId: conversationId, source: 'api', mode: 'conversation', userTurn: true });

    expect(server().refusals).toEqual([]);
    expect(result.status).toBe('completed');
    expect(roles(server().answered[0])).toContain('user');
  });

  it('shows a refused request in the server\'s own words, and the next message still runs', async () => {
    const conversationId = newConversation();
    server().templateError = 'Unknown test: sequence';
    const refused = await turn(conversationId, { prompt: 'First task' });

    expect(refused.status).toBe('error');
    const message = String(refused.error?.message ?? '');
    expect(message).toContain('Unknown test: sequence');
    expect(message).not.toContain('\\"');
    expect(message).not.toContain('\\n');

    server().templateError = undefined;
    const next = await turn(conversationId, { prompt: 'Second task' });
    expect(next.status).toBe('completed');
  });
});

describe.each(SELF_HOSTED_SERVER_KINDS)('FLUJO\'s adapter against %s, with and without streaming', (kind) => {
  const server = () => servers.get(kind)!;
  const model = () => mockModels.get(`self-hosted-${kind}`)!;
  const tool = { type: 'function' as const, function: { name: 'bash__run', description: 'Run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } };
  const call = (streaming: boolean, extra: Record<string, unknown> = {}) => {
    const adapter = getCompletionAdapter(model());
    const input = {
      model: model(), apiKey: 'not-needed', temperature: 0, tools: [tool],
      messages: [
        { role: 'system' as const, content: 'You are a worker.' },
        { role: 'user' as const, content: 'Clean up the folder' },
        { role: 'system' as const, content: 'The source conversation ends above.' },
      ],
      ...extra,
    };
    return streaming
      ? adapter.createStreamCompletion!({ ...input, onModelDelta: () => undefined })
      : adapter.createCompletion(input);
  };

  it.each([true, false])('reads the token counts (streaming: %s)', async (streaming) => {
    const result = await call(streaming);
    expect(server().refusals).toEqual([]);
    expect(result.completion.choices[0].message.content).toBe('answer 1');
    expect(result.completion.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(result.completion.usage?.completion_tokens).toBeGreaterThan(0);
    expect(server().answered[0].stream_options).toEqual(streaming ? { include_usage: true } : undefined);
  });

  it.each([true, false])('keeps a finished tool call (streaming: %s)', async (streaming) => {
    server().script = [{ call: 'bash__run', args: { command: 'ls' } }];
    const result = await call(streaming);
    const choice = result.completion.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toEqual([expect.objectContaining({ function: { name: 'bash__run', arguments: '{"command":"ls"}' } })]);
  });

  it.each([true, false])('drops a tool call the output limit cut off (streaming: %s)', async (streaming) => {
    server().script = [{ cutOffCall: 'bash__run', args: { command: 'rm -rf /tmp/report-old /tmp/report-draft' }, say: 'Cleaning up.' }];
    const result = await call(streaming);
    const choice = result.completion.choices[0];
    expect(choice.finish_reason).toBe('length');
    expect(choice.message.tool_calls ?? []).toEqual([]);
  });

  it.each([true, false])('drops a cut-off call when FLUJO sent an output cap (streaming: %s)', async (streaming) => {
    server().script = [{ cutOffCall: 'bash__run', args: { command: 'rm -rf /tmp/report-old /tmp/report-draft' } }];
    const result = await call(streaming, { maxTokens: 64 });
    expect(server().answered[0].max_tokens).toBe(64);
    expect(result.completion.choices[0].finish_reason).toBe('length');
    expect(result.completion.choices[0].message.tool_calls ?? []).toEqual([]);
  });
});

describe('the stand-in refuses what the real servers refuse', () => {
  const post = async (kind: SelfHostedServerKind, body: Record<string, unknown>) => {
    const response = await fetch(`${servers.get(kind)!.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: STAND_IN_MODEL, ...body }),
    });
    return { status: response.status, text: await response.text() };
  };

  it.each(SELF_HOSTED_SERVER_KINDS)('%s and a system message that is not first', async (kind) => {
    const reply = await post(kind, { messages: [{ role: 'user', content: 'Hi' }, { role: 'system', content: 'Late' }] });
    if (kind === 'ollama') {
      // Ollama's own Qwen renderer folds it into the first system turn.
      expect(reply.status).toBe(200);
    } else {
      expect(reply.status).toBe(400);
      expect(reply.text).toContain('System message must be at the beginning.');
    }
  });

  it.each(SELF_HOSTED_SERVER_KINDS)('%s and a request with no user turn', async (kind) => {
    const reply = await post(kind, { messages: [{ role: 'system', content: 'Only instructions' }] });
    expect(reply.status).toBe(kind === 'ollama' ? 500 : 400);
    expect(reply.text.toLowerCase()).toContain('no user query found in messages');
  });

  it.each(SELF_HOSTED_SERVER_KINDS)('%s and stream_options without streaming', async (kind) => {
    const reply = await post(kind, { messages: [{ role: 'user', content: 'Hi' }], stream_options: { include_usage: true } });
    expect(reply.status).toBe(kind.startsWith('vllm') ? 400 : 200);
  });

  it.each(SELF_HOSTED_SERVER_KINDS)('%s streams token counts only when asked for them', async (kind) => {
    const chunks = async (body: Record<string, unknown>) => (await post(kind, { messages: [{ role: 'user', content: 'Hi' }], stream: true, ...body })).text
      .split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const asked = await chunks({ stream_options: { include_usage: true } });
    expect(asked.at(-1)).toEqual(expect.objectContaining({ choices: [], usage: expect.objectContaining({ prompt_tokens: expect.any(Number) }) }));
    const notAsked = await chunks({});
    expect(notAsked.some(chunk => chunk.usage)).toBe(false);
    // llama.cpp always sends its own timings.
    expect(Boolean(notAsked.at(-1)?.timings)).toBe(kind === 'llama.cpp');
  });

  it.each(SELF_HOSTED_SERVER_KINDS)('%s finish reason for a call cut off while streaming', async (kind) => {
    const server = servers.get(kind)!;
    server.script = [{ cutOffCall: 'bash__run', args: { command: 'rm -rf /tmp/report-old' } }];
    const text = (await post(kind, { messages: [{ role: 'user', content: 'Hi' }], stream: true })).text;
    const chunks = text.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)) as {
      choices: Array<{ finish_reason: string | null; delta: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    });
    const finish = chunks.flatMap(chunk => chunk.choices).find(choice => choice.finish_reason)?.finish_reason;
    const streamedArguments = chunks.flatMap(chunk => chunk.choices).flatMap(choice => choice.delta.tool_calls ?? [])
      .map(call => call.function?.arguments ?? '').join('');
    if (kind === 'vllm-0.11') {
      // The old relabel: the cut JSON is closed and the call looks finished.
      expect(finish).toBe('tool_calls');
      expect(() => JSON.parse(streamedArguments)).not.toThrow();
    } else {
      expect(finish).toBe('length');
      if (kind === 'ollama') expect(streamedArguments).toBe('');
      else expect(() => JSON.parse(streamedArguments)).toThrow();
    }
    server.reset();
  });
});
