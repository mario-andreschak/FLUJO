/**
 * A flow decides what is allowed next. A model only runs the conversation.
 *
 * The real-run cases execute nodes, runFlow and the adapter against a loopback provider.
 * Only the MCP layer is replaced. What the provider receives shows what the model was
 * offered, and what reaches callTool shows what ran.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';

const mockCallTool = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    callTool: (...args: unknown[]) => mockCallTool(...args),
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
      id, name: 'decision-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'decision-model', name: 'decision-fixture' }],
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
import { saveItem } from '@/utils/storage/backend';
import {
  decisionConditionMatches,
  decisionRuleIssues,
  effectiveAllowedToolNames,
  selectDecisionRule,
  type DecisionRule,
} from '@/utils/shared/decisionRules';
import { entryConditionStartNodeId, recordVariableSource, variableCameFrom } from '@/utils/shared/edgeConditions';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';

jest.setTimeout(30_000);

const READ_TOOL = encodeToolName('srv', 'read_it');
const WRITE_TOOL = encodeToolName('srv', 'write_it');
// What the model sees in the request, which is not the name it calls back with here.
const OFFERED_READ = 'srv_read_it';
const OFFERED_WRITE = 'srv_write_it';

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

const edge = (id: string, source: string, target: string, condition?: unknown, edgeType = 'standard') => ({
  id, source, target, data: { edgeType, ...(condition ? { condition } : {}) },
});

const outcomeIs = (value: string) => ({ kind: 'equals', value, target: 'variable', variable: 'decision.outcome' });

/** start → gate/decide → (allowed | refused). The model step has both tools attached. */
function decidingFlow(id: string, rules: DecisionRule[], entries: unknown[] = []): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('decide', 'static', { entries, rules }),
      node('allowed', 'process', { boundModel: 'decision-model', promptTemplate: 'Work.' }),
      node('refused', 'static', { outputTemplate: 'Refused by the flow.' }),
      node('end', 'finish'),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it', 'write_it'] }),
    ],
    edges: [
      edge('a', 'start', 'decide'),
      edge('to-allowed', 'decide', 'allowed', outcomeIs('proceed')),
      edge('to-refused', 'decide', 'refused'),
      edge('allowed-end', 'allowed', 'end'),
      edge('refused-end', 'refused', 'end'),
      edge('tools', 'allowed', 'tools', undefined, 'mcp'),
    ],
  } as unknown as Flow;
}

describe('real runs', () => {
  let server: Server;
  let requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
  let plannedCalls: string[] = [];
  let replyText = 'all done';

  function answer(response: ServerResponse, body: Record<string, unknown>) {
    const firstTurn = requests.length === 1;
    const planned = firstTurn ? plannedCalls : [];
    const toolCalls = planned.length
      ? planned.map((name, index) => ({ id: `call_${index}`, index, type: 'function', function: { name, arguments: '{}' } }))
      : undefined;
    const message = { role: 'assistant', content: toolCalls ? null : replyText, refusal: null, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    const finishReason = toolCalls ? 'tool_calls' : 'stop';
    const completion = { id: 'c', object: 'chat.completion', created: 1, model: 'decision-fixture' };
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
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        requests.push(body as typeof requests[number]);
        answer(response, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await saveItem(StorageKey.MODELS, [{ id: 'decision-model', name: 'decision-fixture', provider: 'openai', adapter: 'openai', ApiKey: '', baseUrl: mockBaseUrl }]);
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    plannedCalls = [];
    replyText = 'all done';
    mockCallTool.mockReset().mockResolvedValue({ success: true, data: { ok: true } });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
    // The model step is offered the two MCP tools, as a connected server would provide.
    jest.spyOn(ToolHandler, 'processMCPNodes').mockResolvedValue({
      success: true,
      value: {
        availableTools: ['read_it', 'write_it'].map((name) => ({
          name: encodeToolName('srv', name),
          originalName: name,
          server: 'srv',
          description: name,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    FlowExecutor.conversationStates.clear();
  });

  const start = (id: string, definition: Flow, extra: Record<string, unknown> = {}) => runFlow({
    conversationId: id, flowDefinition: definition, prompt: 'Go', source: 'api', mode: 'conversation', flujo: true, userTurn: true, ...extra,
  });
  const offered = (index = 0) => (requests[index]?.tools ?? []).map((tool) => tool.function.name);
  const srvCalls = () => mockCallTool.mock.calls.filter((args) => args[0] === 'srv');

  describe('a fixed decision, with no model', () => {
    const rules: DecisionRule[] = [
      { id: 'yes', when: { kind: 'equals', value: 'go', variable: 'ticket' }, outcome: 'proceed', reason: 'ticket_says_go' },
      { id: 'default', outcome: 'refuse', reason: 'nothing_applies' },
    ];

    it('takes the first rule that applies and reports it', async () => {
      const result = await start('first', decidingFlow('first', rules), { variables: { ticket: 'go' } });

      expect(result.outputText).toBe('all done');
      expect(result.decisions).toMatchObject([{ nodeId: 'decide', ruleId: 'yes', outcome: 'proceed', reason: 'ticket_says_go' }]);
      expect(requests).toHaveLength(1);
    });

    it('never asks a model when the rules say no', async () => {
      const result = await start('refuse', decidingFlow('refuse', rules), { variables: { ticket: 'stop' } });

      expect(result.outputText).toBe('Refused by the flow.');
      expect(result.decisions).toMatchObject([{ ruleId: 'default', outcome: 'refuse' }]);
      expect(requests).toHaveLength(0);
    });

    it('stops with an error when no rule applies, rather than carrying on', async () => {
      const result = await start('none', decidingFlow('none', [rules[0]]), { variables: { ticket: 'stop' } });

      expect(result.status).toBe('error');
      expect(result.error?.details).toMatchObject({ code: 'decision_no_rule' });
      expect(requests).toHaveLength(0);
    });

    it('sets literal variables and never fills in a template', async () => {
      const flow = decidingFlow('literal', [{ id: 'd', outcome: 'refuse', set: { note: '${var:ticket}' } }]);

      await start('literal', flow, { variables: { ticket: 'typed by the caller' } });

      const state = FlowExecutor.conversationStates.get('literal')!;
      expect(state.variables?.note).toBe('${var:ticket}');
      expect(state.variableSources?.note?.from).toBe('rule');
    });

    it('decides again on every user turn when the rules come before the model', async () => {
      const flow = decidingFlow('turns', rules);

      const first = await start('turns', flow, { variables: { ticket: 'go' } });
      expect(first.decisions).toMatchObject([{ ruleId: 'yes' }]);

      const second = await start('turns', flow, { prompt: 'Again', variables: { ticket: 'stop' } });
      expect(second.decisions).toMatchObject([{ ruleId: 'default' }]);
      expect(second.outputText).toBe('Refused by the flow.');
      expect(FlowExecutor.conversationStates.get('turns')!.decisionLog).toHaveLength(2);
    });
  });

  describe('a model cannot approve anything', () => {
    const needsPerson: DecisionRule[] = [
      { id: 'yes', when: { kind: 'equals', value: 'approved', variable: 'consent', from: 'person' }, outcome: 'proceed' },
      { id: 'default', outcome: 'refuse' },
    ];
    const gate = { kind: 'humanGate', text: 'May we?', captureVariable: 'consent', onReject: 'continue' };

    it('accepts the answer of a person', async () => {
      const held = await start('person', decidingFlow('person', needsPerson, [gate]));
      expect(held.status).toBe('awaiting_tool_approval');

      await applyApprovalDecision(FlowExecutor.conversationStates.get('person')!, held.pendingToolCalls![0].id, 'approve');
      const done = await runFlow({ conversationId: 'person', source: 'api', mode: 'conversation', flujo: true });

      expect(done.decisions).toMatchObject([{ ruleId: 'yes', outcome: 'proceed' }]);
      expect(done.outputText).toBe('all done');
    });

    it('treats a rejection as no', async () => {
      const held = await start('rejected', decidingFlow('rejected', needsPerson, [gate]));

      await applyApprovalDecision(FlowExecutor.conversationStates.get('rejected')!, held.pendingToolCalls![0].id, 'reject');
      const done = await runFlow({ conversationId: 'rejected', source: 'api', mode: 'conversation', flujo: true });

      expect(done.decisions).toMatchObject([{ ruleId: 'default' }]);
      expect(done.outputText).toBe('Refused by the flow.');
    });

    it('does not accept the same word from a model', async () => {
      replyText = 'approved';
      const flow: Flow = {
        id: 'model-says',
        name: 'model-says',
        nodes: [
          node('start', 'start'),
          node('chat', 'process', { boundModel: 'decision-model', promptTemplate: 'Talk.', captureVariable: 'consent' }),
          node('decide', 'static', { rules: needsPerson }),
          node('act', 'static', { outputTemplate: 'Acted.' }),
          node('refused', 'static', { outputTemplate: 'Refused by the flow.' }),
          node('end', 'finish'),
        ],
        edges: [
          edge('a', 'start', 'chat'),
          edge('b', 'chat', 'decide', { kind: 'always' }),
          edge('to-act', 'decide', 'act', outcomeIs('proceed')),
          edge('to-refused', 'decide', 'refused'),
          edge('c', 'act', 'end'),
          edge('d', 'refused', 'end'),
        ],
      } as unknown as Flow;

      const result = await start('model-says', flow);

      expect(FlowExecutor.conversationStates.get('model-says')!.variables?.consent).toBe('approved');
      expect(result.outputText).toBe('Refused by the flow.');
    });

    it('does not accept the same word from the caller', async () => {
      const result = await start('caller-says', decidingFlow('caller-says', needsPerson), { variables: { consent: 'approved' } });

      expect(result.decisions).toMatchObject([{ ruleId: 'default' }]);
      expect(requests).toHaveLength(0);
    });

    it('stops trusting a value a model overwrote, even with the same word', async () => {
      replyText = 'approved';
      const flow: Flow = {
        id: 'overwrite',
        name: 'overwrite',
        nodes: [
          node('start', 'start'),
          node('ask', 'static', { entries: [gate] }),
          node('chat', 'process', { boundModel: 'decision-model', promptTemplate: 'Talk.', captureVariable: 'consent' }),
          node('decide', 'static', { rules: needsPerson }),
          node('act', 'static', { outputTemplate: 'Acted.' }),
          node('refused', 'static', { outputTemplate: 'Refused by the flow.' }),
          node('end', 'finish'),
        ],
        edges: [
          edge('a', 'start', 'ask'),
          edge('b', 'ask', 'chat'),
          edge('c', 'chat', 'decide', { kind: 'always' }),
          edge('to-act', 'decide', 'act', outcomeIs('proceed')),
          edge('to-refused', 'decide', 'refused'),
          edge('d', 'act', 'end'),
          edge('e', 'refused', 'end'),
        ],
      } as unknown as Flow;

      const held = await start('overwrite', flow);
      await applyApprovalDecision(FlowExecutor.conversationStates.get('overwrite')!, held.pendingToolCalls![0].id, 'reject');
      const done = await runFlow({ conversationId: 'overwrite', source: 'api', mode: 'conversation', flujo: true });

      expect(done.outputText).toBe('Refused by the flow.');
    });

    it('accepts a tool result as coming from the tool, and a mock as not', async () => {
      const rule = (from: 'tool'): DecisionRule[] => [
        { id: 'ok', when: { kind: 'equals', value: 'true', variable: 'check.ok', from }, outcome: 'proceed' },
        { id: 'default', outcome: 'refuse' },
      ];
      const real = { kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'read_it', argumentsJson: '{}', result: '', captureVariable: 'check', resultFormat: 'json' };
      const mock = { kind: 'toolCall', toolName: 'read_it', argumentsJson: '{}', result: '{"ok":true}', captureVariable: 'check', resultFormat: 'json' };

      const withReal = decidingFlow('real', rule('tool'), [real]);
      withReal.edges.push(edge('decide-tools', 'decide', 'tools', undefined, 'mcp') as never);
      expect((await start('real', withReal)).decisions).toMatchObject([{ ruleId: 'ok' }]);

      expect((await start('mock', decidingFlow('mock', rule('tool'), [mock]))).decisions).toMatchObject([{ ruleId: 'default' }]);
    });
  });

  describe('limiting tools', () => {
    const limited = (allowTools: string[] | undefined): DecisionRule[] => [{ id: 'd', outcome: 'proceed', ...(allowTools ? { allowTools } : {}) }];

    it('offers only what the decision allows', async () => {
      await start('narrow', decidingFlow('narrow', limited(['read_it'])));

      expect(offered()).toContain(OFFERED_READ);
      expect(offered()).not.toContain(OFFERED_WRITE);
    });

    it('offers no connected tool with an empty list', async () => {
      await start('empty', decidingFlow('empty', limited([])));

      expect(requests).toHaveLength(1);
      expect(offered()).not.toContain(OFFERED_READ);
      expect(offered()).not.toContain(OFFERED_WRITE);
    });

    it('leaves the tools alone when a rule names none', async () => {
      await start('open', decidingFlow('open', limited(undefined)));

      expect(offered()).toEqual(expect.arrayContaining([OFFERED_READ, OFFERED_WRITE]));
    });

    it('refuses a call to a tool the decision took away, and the model hears why', async () => {
      plannedCalls = [WRITE_TOOL];

      await start('blocked', decidingFlow('blocked', limited(['read_it'])));

      expect(srvCalls()).toHaveLength(0);
      expect(JSON.stringify(requests[1])).toContain('not available');
    });

    it('holds a subflow inside the limit of the run that started it', async () => {
      const parentId = 'limit-parent';
      await start(parentId, decidingFlow(parentId, limited(['read_it'])));
      requests = [];
      const childFlow = {
        id: 'limit-child',
        name: 'limit-child',
        nodes: [
          node('start', 'start'),
          node('allowed', 'process', { boundModel: 'decision-model', promptTemplate: 'Child.' }),
          node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it', 'write_it'] }),
        ],
        edges: [edge('a', 'start', 'allowed'), edge('b', 'allowed', 'tools', undefined, 'mcp')],
      } as unknown as Flow;

      await runFlow({
        flowDefinition: childFlow, prompt: 'Sub', source: 'subflow', mode: 'ephemeral', flujo: true, userTurn: true, parentRunId: parentId, depth: 1,
      } as never);

      expect(requests).toHaveLength(1);
      expect(offered()).toContain(OFFERED_READ);
      expect(offered()).not.toContain(OFFERED_WRITE);
    });

    it('runs a call to a tool the decision allows', async () => {
      plannedCalls = [READ_TOOL];

      await start('allowed', decidingFlow('allowed', limited(['read_it'])));

      expect(srvCalls()).toHaveLength(1);
    });

    it('keeps the limit when a follow-up turn skips the decision', async () => {
      const flow: Flow = {
        id: 'mid',
        name: 'mid',
        nodes: [
          node('start', 'start'),
          node('first', 'process', { boundModel: 'decision-model', promptTemplate: 'One.' }),
          node('decide', 'static', { rules: limited(['read_it']) }),
          node('allowed', 'process', { boundModel: 'decision-model', promptTemplate: 'Two.' }),
          node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it', 'write_it'] }),
        ],
        edges: [
          edge('a', 'start', 'first'),
          edge('b', 'first', 'decide', { kind: 'always' }),
          edge('c', 'decide', 'allowed'),
          edge('d', 'allowed', 'tools', undefined, 'mcp'),
        ],
      } as unknown as Flow;

      await start('mid', flow);
      expect(FlowExecutor.conversationStates.get('mid')!.allowedToolNames).toEqual(['read_it']);
      requests = [];
      await start('mid', flow, { prompt: 'Next' });

      expect(requests).toHaveLength(1);
      expect(offered()).toContain(OFFERED_READ);
      expect(offered()).not.toContain(OFFERED_WRITE);
    });
  });
});

describe('decision rules on their own', () => {
  const state = {
    variables: { a: '1', j: '{"x":{"y":2}}', p: 'approved' },
    variableSources: { p: { from: 'person' as const, value: 'approved' }, j: { from: 'tool' as const, value: '{"x":{"y":2}}' } },
  };
  const leaf = (variable: string, value: string) => ({ kind: 'equals' as const, value, variable });

  it('combines conditions', () => {
    expect(decisionConditionMatches({ all: [leaf('a', '1'), leaf('j.x.y', '2')] }, [], state)).toBe(true);
    expect(decisionConditionMatches({ all: [leaf('a', '1'), leaf('j.x.y', '9')] }, [], state)).toBe(false);
    expect(decisionConditionMatches({ any: [leaf('a', '9'), leaf('j.x.y', '2')] }, [], state)).toBe(true);
    expect(decisionConditionMatches({ not: leaf('a', '9') }, [], state)).toBe(true);
  });

  it.each([
    ['an empty all', { all: [] }],
    ['an empty any', { any: [] }],
    ['an unknown kind', { kind: 'nope', variable: 'a', value: '1' }],
    ['a value that is not an object', 'always'],
    ['nothing', null],
    ['an empty not', { not: 'x' }],
  ])('does not apply on %s', (_label, when) => {
    expect(decisionConditionMatches(when, [], state)).toBe(false);
  });

  it('gives up on endless nesting', () => {
    let when: unknown = leaf('a', '1');
    for (let i = 0; i < 40; i++) when = { all: [when] };
    expect(decisionConditionMatches(when, [], state)).toBe(false);
  });

  it('can test a message', () => {
    const messages = [{ role: 'user', content: 'cancel my order' }];
    expect(decisionConditionMatches({ kind: 'contains', value: 'cancel', target: 'last-user' }, messages, state)).toBe(true);
  });

  it('requires the source to match', () => {
    expect(decisionConditionMatches({ ...leaf('p', 'approved'), from: 'person' }, [], state)).toBe(true);
    expect(decisionConditionMatches({ ...leaf('p', 'approved'), from: 'model' }, [], state)).toBe(false);
    expect(decisionConditionMatches({ ...leaf('p', 'approved'), from: ['tool', 'person'] }, [], state)).toBe(true);
    expect(decisionConditionMatches({ ...leaf('j.x.y', '2'), from: 'tool' }, [], state)).toBe(true);
    expect(decisionConditionMatches({ ...leaf('a', '1'), from: 'person' }, [], state)).toBe(false);
  });

  it('never matches a failed source, even negated, but can ask about absence', () => {
    expect(decisionConditionMatches({ ...leaf('a', '9'), negate: true, from: 'person' }, [], state)).toBe(false);
    expect(decisionConditionMatches({ ...leaf('gone', '9'), negate: true }, [], state)).toBe(false);
    expect(decisionConditionMatches({ kind: 'exists', variable: 'a', from: 'person' }, [], state)).toBe(false);
    expect(decisionConditionMatches({ kind: 'exists', variable: 'a', from: 'person', negate: true }, [], state)).toBe(true);
  });

  it('forgets the source once the value changes', () => {
    const changed = { ...state, variables: { ...state.variables, p: 'approved!' } };
    expect(variableCameFrom('p', 'person', state)).toBe(true);
    expect(variableCameFrom('p', 'person', changed)).toBe(false);
  });

  it('does not read names from the prototype chain', () => {
    expect(variableCameFrom('constructor', 'person', state)).toBe(false);
    const target: { variables: Record<string, string>; variableSources?: Record<string, { from: 'person'; value: string }> } = { variables: JSON.parse('{"__proto__":"x"}') };
    recordVariableSource(target, '__proto__', 'person');
    expect(({} as Record<string, unknown>).from).toBeUndefined();
  });

  it('takes the first rule and treats no condition as always', () => {
    const rules: DecisionRule[] = [
      { id: 'no', when: leaf('a', '9'), outcome: 'x' },
      { id: 'yes', when: leaf('a', '1'), outcome: 'y' },
      { id: 'later', outcome: 'z' },
    ];
    expect(selectDecisionRule(rules, [], state)?.id).toBe('yes');
    expect(selectDecisionRule(rules.slice(0, 1), [], state)).toBeNull();
    expect(selectDecisionRule(undefined, [], state)).toBeNull();
  });

  it('keeps a subflow inside its parent\'s limit', () => {
    expect(effectiveAllowedToolNames({})).toBeUndefined();
    expect(effectiveAllowedToolNames({ inheritedAllowedToolNames: ['a'] })).toEqual(['a']);
    expect(effectiveAllowedToolNames({ allowedToolNames: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(effectiveAllowedToolNames({ allowedToolNames: ['a', 'b'], inheritedAllowedToolNames: ['b', 'c'] })).toEqual(['b']);
    expect(effectiveAllowedToolNames({ allowedToolNames: [], inheritedAllowedToolNames: ['b'] })).toEqual([]);
  });

  it('returns to the start on every turn when rules come before the model', () => {
    const flow = {
      nodes: [
        { id: 's', data: { type: 'start' } },
        { id: 'r', data: { type: 'static', properties: { rules: [{ id: 'a', outcome: 'b' }] } } },
        { id: 'p', data: { type: 'process' } },
      ],
      edges: [{ source: 's', target: 'r', data: {} }, { source: 'r', target: 'p', data: {} }],
    };
    expect(entryConditionStartNodeId(flow)).toBe('s');
    expect(entryConditionStartNodeId({ ...flow, nodes: flow.nodes.map((n) => (n.id === 'r' ? { id: 'r', data: { type: 'static', properties: {} } } : n)) })).toBeNull();
  });

  describe('checking rules', () => {
    const errors = (rules: unknown) => decisionRuleIssues(rules, 'N').filter((issue) => issue.severity === 'error').map((issue) => issue.message);

    it('accepts good rules', () => {
      expect(decisionRuleIssues([
        { id: 'a', when: { all: [{ kind: 'gt', value: '1', variable: 'x', from: 'tool' }, { not: { kind: 'exists', variable: 'y' } }] }, outcome: 'o', set: { z: '1' }, allowTools: ['t'] },
        { id: 'b', outcome: 'p', reason: 'because' },
      ], 'N')).toEqual([]);
    });

    it.each([
      ['not a list', {}, 'must be a list'],
      ['a rule that is not an object', ['x'], 'must be an object'],
      ['no id', [{ outcome: 'a' }], 'needs an id'],
      ['a repeated id', [{ id: 'a', outcome: 'a' }, { id: 'a', outcome: 'b' }], 'repeats'],
      ['no outcome', [{ id: 'a' }], 'needs an outcome'],
      ['an unknown kind', [{ id: 'a', outcome: 'b', when: { kind: 'nope' } }], 'unknown kind'],
      ['a comparison with no value', [{ id: 'a', outcome: 'b', when: { kind: 'gt', variable: 'x' } }], 'needs a value'],
      ['an empty all', [{ id: 'a', outcome: 'b', when: { all: [] } }], 'at least one'],
      ['two operators', [{ id: 'a', outcome: 'b', when: { all: [], any: [] } }], 'only one'],
      ['an unknown source', [{ id: 'a', outcome: 'b', when: { kind: 'exists', variable: 'x', from: 'admin' } }], 'unknown source'],
      ['a source with no variable', [{ id: 'a', outcome: 'b', when: { kind: 'contains', value: 'x', from: 'person' } }], 'when it tests a variable'],
      ['a target variable with no name', [{ id: 'a', outcome: 'b', when: { kind: 'exists', target: 'variable' } }], 'does not name'],
      ['an invalid variable to set', [{ id: 'a', outcome: 'b', set: { 'a b': '1' } }], 'invalid variable'],
      ['a reserved variable to set', [{ id: 'a', outcome: 'b', set: JSON.parse('{"constructor":"1"}') }], 'invalid variable'],
      ['a set value that is not text', [{ id: 'a', outcome: 'b', set: { x: 1 } }], 'to text'],
      ['an allow list that is not a list', [{ id: 'a', outcome: 'b', allowTools: 'x' }], 'list of tool names'],
    ])('reports %s', (_label, rules, expected) => {
      expect(errors(rules).join(' ')).toContain(expected);
    });

    it('warns when nothing catches the rest', () => {
      const issues = decisionRuleIssues([{ id: 'a', outcome: 'b', when: { kind: 'exists', variable: 'x' } }], 'N');
      expect(issues).toEqual([expect.objectContaining({ severity: 'warning', code: 'decision-no-fallback' })]);
    });
  });

  describe('in the flow format', () => {
    const context = { models: [], servers: [], serverTools: {} };
    const spec = (decide: Record<string, unknown>) => ({
      name: 'Decide',
      nodes: [{ key: 'start', type: 'start' }, { key: 'decide', type: 'static', ...decide }, { key: 'end', type: 'finish' }],
      edges: [{ from: 'start', to: 'decide' }, { from: 'decide', to: 'end' }],
    });

    it('carries rules there and back', () => {
      const rules = [{ id: 'd', outcome: 'go', allowTools: ['t'] }];
      const compiled = compileFlowSpec(spec({
        rules, decisionVariable: 'verdict', entries: [{ kind: 'humanGate', text: 'OK?', captureVariable: 'consent' }],
      }) as never, context as never);
      const properties = compiled.flow!.nodes.find((candidate) => candidate.type === 'static')!.data.properties as Record<string, unknown>;

      expect(properties).toMatchObject({ rules, decisionVariable: 'verdict', entries: [{ kind: 'humanGate', captureVariable: 'consent' }] });
      expect(flowToSpec(compiled.flow!).nodes?.find((candidate) => candidate.type === 'static')).toMatchObject({ rules, decisionVariable: 'verdict' });
    });

    it.each([
      ['bad rules', { rules: [{ id: 'a' }] }, 'decision-rule-invalid'],
      ['a bad decision variable', { rules: [{ id: 'a', outcome: 'b' }], decisionVariable: 'a b' }, 'decision-variable-invalid'],
      ['a bad gate variable', { entries: [{ kind: 'humanGate', text: 'OK?', captureVariable: 'a b' }] }, 'static-invalid-capture'],
    ])('stops the compile on %s', (_label, decide, code) => {
      const compiled = compileFlowSpec(spec(decide) as never, context as never);

      expect(compiled.issues.map((issue) => issue.code)).toContain(code);
      expect(compiled.errorCount).toBeGreaterThan(0);
    });
  });
});
