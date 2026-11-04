/**
 * A Static node can do what a model step can, with no model.
 *
 * It calls tools under the same approval rules as a model step, and it can choose the
 * next step from a tool's result. These cases execute graph conversion, nodes, runFlow
 * and the approval decision for real. Only the MCP layer is replaced, and what reaches
 * callTool is what is counted: a call that needs a person must not get there first.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Flow, FlowNode } from '@/shared/types/flow';

const mockCallTool = jest.fn();
const mockListTools = jest.fn();
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    callTool: (...args: unknown[]) => mockCallTool(...args),
    listServerTools: (...args: unknown[]) => mockListTools(...args),
    loadServerConfigs: async () => [{ name: 'srv' }],
    setNodeRoots: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: async () => null, loadFlows: async () => [] },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { runFlow } from '@/backend/execution/flow/runFlow';
import type { EdgeCondition } from '@/utils/shared/edgeConditions';
import { evaluateCondition, readConditionVariable, selectConditionedEdge } from '@/utils/shared/edgeConditions';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';

jest.setTimeout(30_000);

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

const call = (extra: Record<string, unknown> = {}) => ({
  kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'do_it', argumentsJson: '{"a":1}', result: '', ...extra,
});

function flowWith(id: string, entries: unknown[], properties: Record<string, unknown> = {}): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('work', 'static', { entries, ...properties }),
      node('after', 'static', { outputTemplate: 'Rest ran.' }),
      node('end', 'finish'),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['do_it'] }),
    ],
    edges: [
      { id: 'a', source: 'start', target: 'work', data: { edgeType: 'standard' } },
      { id: 'b', source: 'work', target: 'after', data: { edgeType: 'standard' } },
      { id: 'c', source: 'after', target: 'end', data: { edgeType: 'standard' } },
      { id: 'd', source: 'work', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

describe('real runs', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-static-parity-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    mockCallTool.mockReset().mockResolvedValue({ success: true, data: { ok: true, count: 3 } });
    mockListTools.mockReset().mockResolvedValue({ tools: [{ name: 'do_it', annotations: { readOnlyHint: false } }] });
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
  });

  afterEach(async () => {
    FlowExecutor.conversationStates.clear();
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const start = (id: string, definition: Flow, extra: Record<string, unknown> = {}) => runFlow({
    conversationId: id, flowDefinition: definition, prompt: 'Go', source: 'api', mode: 'conversation', flujo: true, userTurn: true, ...extra,
  });
  const srvCalls = () => mockCallTool.mock.calls.filter((args) => args[0] === 'srv');

  describe('the same approval as a model step', () => {
    it('runs at once when nothing asks for approval, as before', async () => {
      const result = await start('free', flowWith('free', [call()]));

      expect(result.status).toBe('completed');
      expect(srvCalls()).toHaveLength(1);
    });

    it('waits when the run asks for approval on every tool', async () => {
      const result = await start('run-wide', flowWith('run-wide', [call()]), { requireApproval: true });

      expect(result.status).toBe('awaiting_tool_approval');
      expect(srvCalls()).toHaveLength(0);
    });

    it('continues after an approval from a run-wide request', async () => {
      const id = 'run-wide-approved';
      const held = await start(id, flowWith(id, [call()]), { requireApproval: true });

      const state = FlowExecutor.conversationStates.get(id)!;
      await applyApprovalDecision(state, held.pendingToolCalls![0].id, 'approve');
      const done = await runFlow({ conversationId: id, source: 'api', mode: 'conversation', flujo: true, requireApproval: true });

      expect(done.status).toBe('completed');
      expect(done.outputText).toBe('Rest ran.');
      expect(srvCalls()).toHaveLength(1);
    });

    it('waits for a tool the node names', async () => {
      const result = await start('named', flowWith('named', [call()], { requireApprovalFor: ['do_it'] }));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(srvCalls()).toHaveLength(0);
    });

    it('does not wait for a tool the node does not name', async () => {
      const result = await start('other', flowWith('other', [call()], { requireApprovalFor: ['something_else'] }));

      expect(result.status).toBe('completed');
      expect(srvCalls()).toHaveLength(1);
    });

    it('waits for a writing tool under the node\'s write rule', async () => {
      const result = await start('writes', flowWith('writes', [call()], { requireApprovalForWrites: true }));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(srvCalls()).toHaveLength(0);
    });

    it('lets a read-only tool through under the write rule', async () => {
      mockListTools.mockResolvedValue({ tools: [{ name: 'do_it', annotations: { readOnlyHint: true } }] });

      const result = await start('reads', flowWith('reads', [call()], { requireApprovalForWrites: true }));

      expect(result.status).toBe('completed');
      expect(srvCalls()).toHaveLength(1);
    });

    it.each([
      ['has no hint', () => mockListTools.mockResolvedValue({ tools: [{ name: 'do_it' }] })],
      ['is not listed', () => mockListTools.mockResolvedValue({ tools: [] })],
      ['cannot be read', () => mockListTools.mockRejectedValue(new Error('server is down'))],
    ])('asks to be safe when the tool %s', async (_label, arrange) => {
      arrange();

      const result = await start('unknown-hint', flowWith('unknown-hint', [call()], { requireApprovalForWrites: true }));

      expect(result.status).toBe('awaiting_tool_approval');
      expect(srvCalls()).toHaveLength(0);
    });

    it('fails rather than running when the automation has no approver', async () => {
      const result = await start('no-approver', flowWith('no-approver', [call()]), { requireApproval: true, onApprovalRequired: 'fail' });

      expect(result.status).toBe('error');
      expect(result.error?.details).toMatchObject({ type: 'approval_required' });
      expect(srvCalls()).toHaveLength(0);
    });

    it('never holds a mock call, which has no effect', async () => {
      const result = await start('mock', flowWith('mock', [{ kind: 'toolCall', toolName: 'do_it', argumentsJson: '{}', result: 'pretend' }]), { requireApproval: true });

      expect(result.status).toBe('completed');
      expect(srvCalls()).toHaveLength(0);
    });
  });

  describe('branching on a tool result, with no model', () => {
    const branching = (id: string, condition: EdgeCondition) => {
      const flow = flowWith(id, [call({ captureVariable: 'result', resultFormat: 'json' })]);
      (flow.nodes as FlowNode[]).push(node('low', 'static', { outputTemplate: 'Took the low way.' }));
      flow.edges = [
        ...flow.edges.filter((edge) => edge.id !== 'b'),
        { id: 'to-low', source: 'work', target: 'low', data: { edgeType: 'standard', condition } },
        { id: 'to-after', source: 'work', target: 'after', data: { edgeType: 'standard' } },
        { id: 'low-end', source: 'low', target: 'end', data: { edgeType: 'standard' } },
      ] as Flow['edges'];
      return flow;
    };

    it('follows a number in the result', async () => {
      const taken = await start('low', branching('low', { kind: 'lt', value: '5', target: 'variable', variable: 'result.count' }));
      expect(taken.outputText).toBe('Took the low way.');

      const skipped = await start('high', branching('high', { kind: 'gt', value: '5', target: 'variable', variable: 'result.count' }));
      expect(skipped.outputText).toBe('Rest ran.');
    });

    it('follows a field in the result', async () => {
      const taken = await start('field', branching('field', { kind: 'equals', value: 'true', target: 'variable', variable: 'result.ok' }));
      expect(taken.outputText).toBe('Took the low way.');
    });

    it('takes the fallback when the field is not there', async () => {
      const result = await start('missing', branching('missing', { kind: 'exists', target: 'variable', variable: 'result.nothing' }));
      expect(result.outputText).toBe('Rest ran.');
    });

    it('branches on the result of a call a person approved first', async () => {
      const id = 'approved-branch';
      const flow = branching(id, { kind: 'lt', value: '5', target: 'variable', variable: 'result.count' });
      (flow.nodes.find((candidate) => candidate.id === 'work')!.data.properties as Record<string, unknown>).requireApprovalFor = ['do_it'];

      const held = await start(id, flow);
      expect(srvCalls()).toHaveLength(0);
      await applyApprovalDecision(FlowExecutor.conversationStates.get(id)!, held.pendingToolCalls![0].id, 'approve');
      const done = await runFlow({ conversationId: id, source: 'api', mode: 'conversation', flujo: true });

      expect(srvCalls()).toHaveLength(1);
      expect(done.outputText).toBe('Took the low way.');
    });
  });
});

describe('conditions on run variables', () => {
  it('reads variables and paths', () => {
    const variables = { plain: 'hello', json: '{"a":{"b":[{"c":7}]},"yes":true,"none":null}', object: { x: 1 } };

    expect(readConditionVariable('plain', variables)).toBe('hello');
    expect(readConditionVariable('json.a.b.0.c', variables)).toBe('7');
    expect(readConditionVariable('json.yes', variables)).toBe('true');
    expect(readConditionVariable('json.a', variables)).toBe('{"b":[{"c":7}]}');
    expect(readConditionVariable('object.x', variables)).toBe('1');
  });

  it.each([
    ['an unknown name', 'gone'],
    ['a path that is not there', 'json.nope'],
    ['a null value', 'json.none'],
    ['a path into plain text', 'plain.a'],
    ['a name from the prototype chain', 'constructor'],
    ['a path into the prototype chain', 'json.constructor'],
    ['nothing', ''],
  ])('finds nothing for %s', (_label, variable) => {
    expect(readConditionVariable(variable, { plain: 'hello', json: '{"none":null}' })).toBeNull();
  });

  it('copes with no variables', () => {
    expect(readConditionVariable('x', undefined)).toBeNull();
  });

  it.each([
    ['gt', '5', '6', true], ['gt', '5', '5', false],
    ['gte', '5', '5', true], ['gte', '5', '4', false],
    ['lt', '5', '4', true], ['lt', '5', '5', false],
    ['lte', '5', '5', true], ['lte', '5', '6', false],
    ['gt', '0.5', '0.75', true],
  ] as const)('compares numbers: %s %s against %s', (kind, value, text, expected) => {
    expect(evaluateCondition({ kind, value }, text)).toBe(expected);
  });

  it.each([
    ['text', 'many'], ['an empty value', ''], ['nothing', null],
  ])('never matches a comparison on %s, even negated', (_label, text) => {
    expect(evaluateCondition({ kind: 'gt', value: '5' }, text)).toBe(false);
    expect(evaluateCondition({ kind: 'gt', value: '5', negate: true }, text)).toBe(false);
  });

  it('tells a missing value from an empty one', () => {
    expect(evaluateCondition({ kind: 'exists' }, '')).toBe(true);
    expect(evaluateCondition({ kind: 'exists' }, null)).toBe(false);
    expect(evaluateCondition({ kind: 'exists', negate: true }, null)).toBe(true);
  });

  it('picks an edge by variable', () => {
    const conditions = { a: { kind: 'gte' as const, value: '10', target: 'variable' as const, variable: 'n' } };
    expect(selectConditionedEdge(['a', 'b'], conditions, [], 'last-message', { n: '12' })).toBe('a');
    expect(selectConditionedEdge(['a', 'b'], conditions, [], 'last-message', { n: '2' })).toBe('b');
    expect(selectConditionedEdge(['a', 'b'], conditions, [], 'last-message')).toBe('b');
  });
});

describe('authoring', () => {
  const context = { models: [], servers: [{ name: 'srv' }], serverTools: { srv: ['do_it'] } };
  const spec = (condition: Record<string, unknown>, node_props: Record<string, unknown> = {}) => ({
    name: 'Branch',
    nodes: [
      { key: 'start', type: 'start' },
      { key: 'work', type: 'static', entries: [call()], ...node_props },
      { key: 'end', type: 'finish' },
    ],
    edges: [{ from: 'start', to: 'work' }, { from: 'work', to: 'end', condition }, { from: 'work', to: 'end' }],
  });
  const compile = (...args: Parameters<typeof spec>) => compileFlowSpec(spec(...args) as never, context as never);
  const conditionOf = (compiled: ReturnType<typeof compile>) =>
    compiled.flow?.edges.map((edge) => (edge.data as { condition?: unknown }).condition).find(Boolean);

  it('keeps a variable condition', () => {
    const condition = { kind: 'gte', value: '5', target: 'variable', variable: 'stock.count' };
    expect(conditionOf(compile(condition))).toEqual(condition);
  });

  it('keeps a condition that needs no value', () => {
    expect(conditionOf(compile({ kind: 'exists', target: 'variable', variable: 'x' }))).toEqual({ kind: 'exists', target: 'variable', variable: 'x' });
  });

  it('stops the compile on a variable condition with no name, which would open the route', () => {
    const compiled = compile({ kind: 'equals', value: '1', target: 'variable' });

    expect(compiled.issues.map((issue) => issue.code)).toContain('edge-condition-variable');
    expect(compiled.errorCount).toBeGreaterThan(0);
  });

  it('carries the approval rules of a Static node there and back', () => {
    const compiled = compile({ kind: 'always' }, { requireApprovalFor: ['do_it'], requireApprovalForWrites: true });
    const properties = compiled.flow!.nodes.find((candidate) => candidate.type === 'static')!.data.properties as Record<string, unknown>;

    expect(properties).toMatchObject({ requireApprovalFor: ['do_it'], requireApprovalForWrites: true });
    expect(flowToSpec(compiled.flow!).nodes?.find((candidate) => candidate.type === 'static')).toMatchObject({
      requireApprovalFor: ['do_it'], requireApprovalForWrites: true,
    });
  });

  it('reports a variable condition with no name in flow validation', () => {
    const flow = flowWith('no-name', [call()]);
    (flow.edges[1].data as { condition?: unknown }).condition = { kind: 'equals', value: '1', target: 'variable' };

    expect(validateFlow(flow as never).issues.map((issue) => issue.code)).toContain('edge-condition-variable');
  });
});
