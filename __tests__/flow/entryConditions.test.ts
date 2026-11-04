/**
 * Conditions before the first model step.
 *
 * A flow can check a message on the edges leaving Start or Static, so a matching
 * message never reaches a model. The real-run cases execute the converter, nodes,
 * runFlow and adapter against a loopback provider and count what reaches it: a
 * follow-up turn resumes at the last Process step, which would otherwise skip the
 * check.
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
    getFlow: async (id: string) => {
      if (mockFlowReadFails) throw new Error('flow store is busy');
      return mockFlows.get(id) ?? null;
    },
    loadFlows: async () => [...mockFlows.values()],
  },
}));
let mockFlowReadFails = false;
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string): Promise<Model> => ({
      id, name: 'gate-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'gate-model', name: 'gate-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));

import { runFlow } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { FINAL_RESPONSE_ACTION } from '@/backend/execution/flow/types';
import { StartNode, StaticNode } from '@/backend/execution/flow/nodes';
import type { SharedState } from '@/backend/execution/flow/types';
import { saveItem } from '@/utils/storage/backend';
import {
  defaultConditionTarget,
  entryConditionStartNodeId,
  selectConditionedEdge,
  selectConditionText,
} from '@/utils/shared/edgeConditions';
import { compileFlowSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';

jest.setTimeout(30_000);

const BLOCK = { kind: 'contains', value: 'FORBIDDEN', ignoreCase: true } as const;
const FIXED_ANSWER = 'A person will answer this.';

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

/** Start -(condition)-> Static with a fixed text -> Finish, and Start -> Process. */
function gatedFlow(id: string): Flow {
  const definition = {
    id,
    name: id,
    nodes: [
      node('start', 'start', { promptTemplate: 'System prompt of the flow' }),
      node('blocked', 'static', { outputTemplate: FIXED_ANSWER }),
      node('end', 'finish'),
      node('process', 'process', { boundModel: 'gate-model', promptTemplate: 'Answer.' }),
    ],
    edges: [
      { id: 'to-blocked', source: 'start', target: 'blocked', data: { edgeType: 'standard', condition: BLOCK } },
      { id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'blocked-end', source: 'blocked', target: 'end', data: { edgeType: 'standard' } },
    ],
  } as unknown as Flow;
  mockFlows.set(id, definition);
  return definition;
}

function answer(response: ServerResponse, body: Record<string, unknown>) {
  const message = { role: 'assistant', content: 'model answer', refusal: null };
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gate-fixture',
      choices: [{ index: 0, delta: message, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 1, model: 'gate-fixture',
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
}

describe('real runs', () => {
  let server: Server;
  const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];

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
    await saveItem(StorageKey.MODELS, [{ id: 'gate-model', name: 'gate-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    mockFlowReadFails = false;
    FlowExecutor.clearFlowCache();
  });

  const turn = (conversationId: string, prompt: string, extra: Record<string, unknown> = {}) => runFlow({
    conversationId, flowId: conversationId, prompt, source: 'api', mode: 'conversation', userTurn: true, ...extra,
  });

  it('answers a matching first question without any model', async () => {
    const conversationId = 'gate-first';
    gatedFlow(conversationId);

    const result = await turn(conversationId, 'What about forbidden things?');

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe(FIXED_ANSWER);
    expect(requests).toHaveLength(0);
  });

  it('lets other questions through to the model', async () => {
    const conversationId = 'gate-pass';
    gatedFlow(conversationId);

    const result = await turn(conversationId, 'What are the opening hours?');

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('model answer');
    expect(requests).toHaveLength(1);
  });

  it('checks a follow-up in the same conversation instead of resuming at the model step', async () => {
    const conversationId = 'gate-follow-up';
    gatedFlow(conversationId);

    await turn(conversationId, 'What are the opening hours?');
    expect(requests).toHaveLength(1);

    const followUp = await turn(conversationId, 'And what about forbidden things?');

    expect(followUp.status).toBe('completed');
    expect(followUp.outputText).toBe(FIXED_ANSWER);
    expect(requests).toHaveLength(1);
  });

  it('keeps a follow-up that passes on the model step with its history', async () => {
    const conversationId = 'gate-follow-up-pass';
    gatedFlow(conversationId);

    await turn(conversationId, 'First question');
    const followUp = await turn(conversationId, 'Second question', {
      prompt: undefined,
      messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'model answer' },
        { role: 'user', content: 'Second question' },
      ],
    });

    expect(followUp.outputText).toBe('model answer');
    expect(requests).toHaveLength(2);
    const texts = (requests[1].messages ?? []).map((message) => String(message.content));
    expect(texts.some((text) => text.includes('First question'))).toBe(true);
    expect(texts.some((text) => text.includes('Second question'))).toBe(true);
  });

  it('does not let a client name the model step to skip the check', async () => {
    const conversationId = 'gate-named-step';
    gatedFlow(conversationId);
    await turn(conversationId, 'First question');
    expect(requests).toHaveLength(1);

    const result = await turn(conversationId, 'Forbidden again', { processNodeId: 'process' });

    expect(result.outputText).toBe(FIXED_ANSWER);
    expect(requests).toHaveLength(1);
  });

  it('ends the turn instead of skipping the check when the flow cannot be read', async () => {
    const conversationId = 'gate-read-failure';
    gatedFlow(conversationId);
    await turn(conversationId, 'First question');
    expect(requests).toHaveLength(1);

    // A conversation saved before flows were pinned reads its flow from the store.
    const saved = FlowExecutor.conversationStates.get(conversationId);
    expect(saved).toBeDefined();
    delete saved!.flowSnapshot;
    mockFlowReadFails = true;
    const failed = await turn(conversationId, 'Forbidden while the store is busy');
    expect(failed.status).toBe('error');
    expect(requests).toHaveLength(1);

    mockFlowReadFails = false;
    const healed = await turn(conversationId, 'Next question');
    expect(healed.status).toBe('completed');
    expect(requests).toHaveLength(2);
  });

  it('leaves a flow without entry conditions resuming at its last model step', async () => {
    const conversationId = 'gate-none';
    mockFlows.set(conversationId, {
      id: conversationId,
      name: conversationId,
      nodes: [node('start', 'start'), node('process', 'process', { boundModel: 'gate-model', promptTemplate: 'Answer.' })],
      edges: [{ id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
    } as unknown as Flow);

    await turn(conversationId, 'First question');
    const realStep = FlowExecutor.executeStep;
    const entered: Array<string | undefined> = [];
    const executeStep = jest.spyOn(FlowExecutor, 'executeStep').mockImplementation(async (state, emit) => {
      entered.push(state.currentNodeId);
      return realStep.call(FlowExecutor, state, emit);
    });
    await turn(conversationId, 'Second question');
    executeStep.mockRestore();

    expect(entered[0]).toBe('process');
    expect(requests).toHaveLength(2);
  });
});

describe('Start and Static nodes route on conditions', () => {
  const startNode = (edges: Record<string, typeof BLOCK | undefined>, prompt = 'Prompt') => {
    const start = new StartNode();
    const ordered = Object.keys(edges);
    for (const edge of ordered) start.addSuccessor(new StartNode(), edge);
    start.node_params = {
      id: 'start', type: 'start', label: 'Start',
      properties: { promptTemplate: prompt },
      orderedOutgoingEdges: ordered,
      edgeConditions: Object.fromEntries(Object.entries(edges).filter(([, condition]) => !!condition)),
    } as unknown as StartNode['node_params'];
    return start;
  };
  const stateWith = (...messages: Array<{ role: string; content: string }>) => ({
    messages: messages.map((message, index) => ({ ...message, id: `m${index}`, timestamp: index })),
    trackingInfo: { executionId: 'run', startTime: 1, nodeExecutionTracker: [] },
  } as unknown as SharedState);
  const runStart = async (start: StartNode, state: SharedState) => {
    const prep = await start.prep(state, start.node_params);
    return start.post(prep, { success: true }, state, start.node_params);
  };

  it('tests the user message, not the system prompt it adds', async () => {
    const start = startNode({ blocked: { ...BLOCK }, open: undefined }, 'FORBIDDEN words are named in this prompt');
    const state = stateWith({ role: 'user', content: 'Opening hours?' });

    await expect(runStart(start, state)).resolves.toBe('open');
    expect(state.messages.at(-1)?.role).toBe('system');
  });

  it('takes the matching edge', async () => {
    const start = startNode({ blocked: { ...BLOCK }, open: undefined });
    await expect(runStart(start, stateWith({ role: 'user', content: 'forbidden?' }))).resolves.toBe('blocked');
  });

  it('ends the run when nothing matches and there is no plain edge', async () => {
    const start = startNode({ blocked: { ...BLOCK } });
    await expect(runStart(start, stateWith({ role: 'user', content: 'Hello' }))).resolves.toBe(FINAL_RESPONSE_ACTION);
  });

  it('routes a Static node on its own result', async () => {
    const staticNode = new StaticNode();
    staticNode.addSuccessor(new StartNode(), 'failed');
    staticNode.addSuccessor(new StartNode(), 'passed');
    staticNode.node_params = {
      id: 'static', type: 'static', label: 'Static',
      properties: { entries: [{ kind: 'message', role: 'assistant', content: 'status: FAILED' }] },
      orderedOutgoingEdges: ['failed', 'passed'],
      edgeConditions: { failed: { kind: 'contains', value: 'FAILED' } },
    } as unknown as StaticNode['node_params'];
    const state = stateWith({ role: 'user', content: 'Hello' });
    const prep = await staticNode.prep(state, staticNode.node_params);

    await expect(staticNode.post(prep, {}, state, staticNode.node_params)).resolves.toBe('failed');
  });

  it('leaves a Static node without conditions on its first successor', async () => {
    const staticNode = new StaticNode();
    staticNode.addSuccessor(new StartNode(), 'first');
    staticNode.addSuccessor(new StartNode(), 'second');
    staticNode.node_params = { id: 'static', type: 'static', label: 'Static', properties: {} } as unknown as StaticNode['node_params'];
    const state = stateWith({ role: 'user', content: 'Hello' });
    const prep = await staticNode.prep(state, staticNode.node_params);

    await expect(staticNode.post(prep, {}, state, staticNode.node_params)).resolves.toBe('first');
  });
});

describe('condition helpers', () => {
  it('finds the last user message past later messages', () => {
    const messages = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'reply' },
      { role: 'system', content: 'prompt' },
    ];
    expect(selectConditionText(messages, 'last-user')).toBe('question');
    expect(selectConditionText([{ role: 'system', content: 'prompt' }], 'last-user')).toBeNull();
  });

  it('picks the default target by the node an edge leaves', () => {
    expect(defaultConditionTarget('start')).toBe('last-user');
    expect(defaultConditionTarget('static')).toBe('last-message');
    expect(defaultConditionTarget('process')).toBe('last-assistant');
    expect(defaultConditionTarget(undefined)).toBe('last-assistant');
  });

  it('prefers a match, then a plain edge, then nothing', () => {
    const messages = [{ role: 'user', content: 'FORBIDDEN' }];
    const conditions = { a: { kind: 'contains' as const, value: 'nothing' }, b: { kind: 'contains' as const, value: 'FORBIDDEN' } };
    expect(selectConditionedEdge(['a', 'c', 'b'], conditions, messages, 'last-user')).toBe('b');
    expect(selectConditionedEdge(['a', 'c'], conditions, messages, 'last-user')).toBe('c');
    expect(selectConditionedEdge(['a'], conditions, messages, 'last-user')).toBeNull();
  });

  describe('entryConditionStartNodeId', () => {
    const typed = (id: string, type: string) => ({ id, data: { type } });
    const edge = (source: string, target: string, data: Record<string, unknown> = {}) => ({ source, target, data });
    const condition = { kind: 'always' };

    it('finds a condition on a Start edge', () => {
      expect(entryConditionStartNodeId({
        nodes: [typed('s', 'start'), typed('p', 'process')],
        edges: [edge('s', 'p', { condition })],
      })).toBe('s');
    });

    it('finds a condition behind Static and Signal nodes', () => {
      expect(entryConditionStartNodeId({
        nodes: [typed('s', 'start'), typed('i', 'static'), typed('n', 'signal'), typed('p', 'process')],
        edges: [edge('s', 'i'), edge('i', 'n'), edge('n', 'p', { condition })],
      })).toBe('s');
    });

    it('ignores a condition after the first model step', () => {
      expect(entryConditionStartNodeId({
        nodes: [typed('s', 'start'), typed('p', 'process'), typed('i', 'static'), typed('f', 'finish')],
        edges: [edge('s', 'p'), edge('p', 'i'), edge('i', 'f', { condition })],
      })).toBeNull();
    });

    it('ignores tool wiring and handles loops', () => {
      expect(entryConditionStartNodeId({
        nodes: [typed('s', 'start'), typed('i', 'static'), typed('m', 'mcp')],
        edges: [edge('s', 'i'), edge('i', 's'), edge('i', 'm', { edgeType: 'mcp', condition })],
      })).toBeNull();
    });

    it('handles a missing flow', () => {
      expect(entryConditionStartNodeId(null)).toBeNull();
      expect(entryConditionStartNodeId({ nodes: [], edges: [] })).toBeNull();
    });
  });
});

describe('authoring', () => {
  const spec = (edgeCondition: Record<string, unknown>, from = 'start') => compileFlowSpec({
    name: 'Gate',
    nodes: [
      { key: 'start', type: 'start' },
      { key: 'blocked', type: 'static', outputTemplate: 'Fixed' },
      { key: 'finish', type: 'finish' },
    ],
    edges: [
      { from, to: from === 'start' ? 'blocked' : 'finish', condition: edgeCondition },
      ...(from === 'start' ? [{ from: 'blocked', to: 'finish' }, { from: 'start', to: 'finish' }] : [{ from: 'start', to: 'blocked' }]),
    ],
  } as never, { servers: [], serverTools: {} });

  const conditionOf = (compiled: ReturnType<typeof spec>) =>
    compiled.flow?.edges.map((edge) => (edge.data as { condition?: unknown } | undefined)?.condition).find(Boolean);

  it('keeps a condition on a Start edge without a warning about it', () => {
    const compiled = spec({ kind: 'contains', value: 'FORBIDDEN' });
    expect(conditionOf(compiled)).toEqual({ kind: 'contains', value: 'FORBIDDEN' });
    expect(compiled.issues.map((issue) => issue.code)).not.toContain('edge-condition-non-process');
  });

  it('keeps a condition on a Static edge', () => {
    expect(conditionOf(spec({ kind: 'contains', value: 'FORBIDDEN' }, 'blocked'))).toEqual({ kind: 'contains', value: 'FORBIDDEN' });
  });

  it('keeps an explicit target that differs from the edge default', () => {
    expect(conditionOf(spec({ kind: 'contains', value: 'x', target: 'last-assistant' }))).toEqual({ kind: 'contains', value: 'x', target: 'last-assistant' });
    expect(conditionOf(spec({ kind: 'contains', value: 'x', target: 'last-message' }))).toEqual({ kind: 'contains', value: 'x', target: 'last-message' });
    expect(conditionOf(spec({ kind: 'contains', value: 'x', target: 'last-user' }))).toEqual({ kind: 'contains', value: 'x' });
  });

  it('still drops a condition on a node type that cannot route', () => {
    const compiled = compileFlowSpec({
      name: 'Gate',
      nodes: [
        { key: 'start', type: 'start' },
        { key: 'signal', type: 'signal', topic: 'x' },
        { key: 'finish', type: 'finish' },
      ],
      edges: [
        { from: 'start', to: 'signal' },
        { from: 'signal', to: 'finish', condition: { kind: 'contains', value: 'x' } },
      ],
    } as never, { servers: [], serverTools: {} });
    expect(conditionOf(compiled)).toBeUndefined();
    expect(compiled.issues.map((issue) => issue.code)).toContain('edge-condition-non-process');
  });

  it('accepts entry conditions in flow validation and warns when there is no fallback', () => {
    const flow = gatedFlow('validation');
    const { issues } = validateFlow(flow as never);
    expect(issues.filter((issue) => issue.code === 'edge-condition-non-process')).toEqual([]);
    expect(issues.filter((issue) => issue.code === 'edge-condition-no-fallback')).toEqual([]);

    const withoutFallback = { ...flow, edges: flow.edges.filter((edge) => edge.id !== 'to-process') };
    expect(validateFlow(withoutFallback as never).issues.map((issue) => issue.code)).toContain('edge-condition-no-fallback');
  });
});
