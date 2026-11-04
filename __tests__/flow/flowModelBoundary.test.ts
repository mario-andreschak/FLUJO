/**
 * A caller pointing at FLUJO cannot see which model answers behind it.
 *
 * Three things answer that: a list of what a flow can reach, a limit the engine enforces
 * before every model turn, and a record of what a turn used. The real-run cases execute
 * nodes, runFlow and the adapter against a loopback provider. Counting the requests that
 * reach it is the point: a refused model must never get one.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import { StorageKey } from '@/shared/types/storage';

const mockFlows = new Map<string, Flow>();
let mockModels: Model[] = [];
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockFlows.get(id) ?? null,
    getFlowByName: async (name: string) => [...mockFlows.values()].find((flow) => flow.name === name) ?? null,
    loadFlows: async () => [...mockFlows.values()],
  },
}));
jest.mock('@/backend/services/model', () => ({
  modelService: {
    getModel: async (id: string) => mockModels.find((model) => model.id === id) ?? null,
    loadModels: async () => mockModels,
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
jest.mock('@/backend/execution/flow/validateFlowForRun', () => ({
  validateFlowForRun: async () => ({ isRunnable: true, issues: [] }),
  validateFlowObjectForRun: async () => ({ isRunnable: true, issues: [] }),
}));

import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { GET as modelsRoute } from '@/app/api/flow/[id]/models/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { describeFlowModelReach } from '@/backend/services/flow/modelReach';
import { intersectAllowedModels, modelsOutsideBoundary } from '@/utils/shared/flowModelBoundary';
import { compileFlowSpec, flowToSpec } from '@/utils/shared/flowSpecCompiler';
import { validateFlow } from '@/utils/shared/flowValidation';
import { saveItem } from '@/utils/storage/backend';

jest.setTimeout(30_000);

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function oneStepFlow(id: string, boundModel: string, allowedModels?: string[]): Flow {
  const flow = {
    id,
    name: id,
    ...(allowedModels ? { allowedModels } : {}),
    nodes: [node('start', 'start'), node('process', 'process', { boundModel, promptTemplate: 'Answer.' })],
    edges: [{ id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
  } as unknown as Flow;
  mockFlows.set(id, flow);
  return flow;
}

describe('real runs', () => {
  let server: Server;
  const requests: unknown[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests.push(request.url);
        const message = { role: 'assistant', content: 'model answer', refusal: null };
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm',
          choices: [{ index: 0, delta: message, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    mockModels = ['checked', 'other'].map((id) => ({
      id, name: `${id}-name`, displayName: `${id} display`, provider: 'openai', adapter: 'openai', ApiKey: 'loopback-fixture-key', baseUrl,
    } as Model));
    mockModels.push({
      id: 'policy-checked', name: 'policy/checked', ApiKey: '', provider: 'openai',
      fallbackPolicy: { modelIds: ['checked', 'checked-backup'] },
    } as Model);
    mockModels.push({ id: 'checked-backup', name: 'backup-name', provider: 'openai', adapter: 'openai', ApiKey: 'loopback-fixture-key', baseUrl } as Model);
    mockModels.push({
      id: 'policy-mixed', name: 'policy/mixed', ApiKey: '', provider: 'openai',
      fallbackPolicy: { modelIds: ['checked', 'other'] },
    } as Model);
    await saveItem(StorageKey.MODELS, mockModels);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    FlowExecutor.clearFlowCache();
    FlowExecutor.conversationStates.clear();
  });

  const run = (id: string, extra: Record<string, unknown> = {}) => runFlow({
    conversationId: id, flowId: id, prompt: 'Question', source: 'api', mode: 'conversation', userTurn: true, ...extra,
  });

  it('runs on a model that is on the list, and records it', async () => {
    oneStepFlow('allowed-run', 'checked', ['checked']);

    const result = await run('allowed-run');

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(result.modelsUsed).toEqual(['checked']);
  });

  it('stops before any request on a model that is not on the list', async () => {
    oneStepFlow('refused-run', 'other', ['checked']);

    const result = await run('refused-run');

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ code: 'model_not_allowed' });
    expect(requests).toHaveLength(0);
    expect(result.modelsUsed).toBeUndefined();
  });

  it('allows no model at all with an empty list', async () => {
    oneStepFlow('empty-list', 'checked', []);

    const result = await run('empty-list');

    expect(result.status).toBe('error');
    expect(requests).toHaveLength(0);
  });

  it('changes nothing without a list', async () => {
    oneStepFlow('no-list', 'other');

    const result = await run('no-list');

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(result.modelsUsed).toEqual(['other']);
  });

  it('allows a fallback policy when every member is on the list, and records the member used', async () => {
    oneStepFlow('policy-ok', 'policy-checked', ['checked', 'checked-backup']);

    const result = await run('policy-ok');

    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(1);
    expect(result.modelsUsed).toEqual(['checked']);
  });

  it('refuses a fallback policy with a member outside the list, even if the first member is fine', async () => {
    oneStepFlow('policy-mixed-run', 'policy-mixed', ['checked']);

    const result = await run('policy-mixed-run');

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ code: 'model_not_allowed' });
    expect(result.error?.message).toContain('other');
    expect(requests).toHaveLength(0);
  });

  it('holds a subflow to its parent\'s list, so it cannot widen the limit', async () => {
    oneStepFlow('child-run', 'other', ['checked', 'other']);
    FlowExecutor.conversationStates.set('parent-run', { allowedModels: ['checked'] } as never);

    const result = await run('child-run', { parentRunId: 'parent-run', source: 'subflow', userTurn: false, depth: 1 });

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ code: 'model_not_allowed' });
    expect(requests).toHaveLength(0);
  });

  it('keeps the limit for the rest of a conversation when a flow widens it later', async () => {
    const id = 'narrow-only';
    oneStepFlow(id, 'checked', ['checked']);
    await run(id);

    const pinned = FlowExecutor.conversationStates.get(id)!;
    pinned.flowSnapshot = oneStepFlow(id, 'other', ['checked', 'other']);
    FlowExecutor.clearFlowCache();
    const result = await run(id);

    expect(result.status).toBe('error');
    expect(result.error?.details).toMatchObject({ code: 'model_not_allowed' });
  });

  it('starts the record again on the next user turn', async () => {
    const id = 'record-per-turn';
    oneStepFlow(id, 'checked');
    await run(id);
    FlowExecutor.conversationStates.get(id)!.modelsUsed = ['from-an-earlier-turn'];

    const result = await run(id);

    expect(result.modelsUsed).toEqual(['checked']);
  });

  it('tells an API caller which models answered', async () => {
    const flow = oneStepFlow('api-receipt', 'checked', ['checked']);

    const response = await processChatCompletion(
      { model: `flow-${flow.name}`, messages: [{ role: 'user', content: 'Question' }] } as never,
      true, false, false,
    );

    expect((await response.json()).flujo_models).toEqual(['checked']);
  });
});

describe('describeFlowModelReach', () => {
  beforeEach(() => {
    mockFlows.clear();
    mockModels = [
      { id: 'a', name: 'a-name', displayName: 'A', provider: 'openai', adapter: 'openai', ApiKey: 'secret-value', baseUrl: 'https://user:hunter2@a.example:8443/v1?token=abc' },
      { id: 'b', name: 'b-name', provider: 'anthropic', ApiKey: 'other-secret', baseUrl: 'https://b.example/v1' },
      { id: 'local', name: 'local-name', adapter: 'codex-cli', provider: 'openai', ApiKey: '' },
      { id: 'policy', name: 'policy/p', ApiKey: '', provider: 'openai', fallbackPolicy: { modelIds: ['a', 'b'] } },
    ] as unknown as Model[];
  });

  const flowWith = (id: string, nodes: FlowNode[], allowedModels?: string[]) => {
    const flow = { id, name: id, nodes, edges: [], ...(allowedModels ? { allowedModels } : {}) } as unknown as Flow;
    mockFlows.set(id, flow);
    return flow;
  };

  it('returns nothing for an unknown flow', async () => {
    await expect(describeFlowModelReach('missing')).resolves.toBeNull();
  });

  it('lists a step\'s model with where it goes, and never credentials', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'a' })]);

    const reach = await describeFlowModelReach('f');

    expect(reach).toMatchObject({ flowId: 'f', allowedModels: null, complete: true, unresolved: [] });
    expect(reach!.models).toEqual([expect.objectContaining({
      id: 'a', displayName: 'A', provider: 'openai', host: 'a.example:8443', allowed: true,
      usedBy: [{ flowId: 'f', nodeId: 'p' }],
    })]);
    const text = JSON.stringify(reach);
    for (const secret of ['secret-value', 'hunter2', 'token=abc']) expect(text).not.toContain(secret);
  });

  it('has no host for a model without an address', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'local' })]);
    expect((await describeFlowModelReach('f'))!.models[0].host).toBeNull();
  });

  it('counts fallback policy members, not the policy', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'policy' })]);

    const reach = await describeFlowModelReach('f');

    expect(reach!.models.map((model) => model.id)).toEqual(['a', 'b']);
    expect(reach!.models[0].usedBy[0].viaPolicy).toBe('policy');
  });

  it('follows subflows, single and parallel, and survives a loop', async () => {
    flowWith('root', [
      node('p', 'process', { boundModel: 'a' }),
      node('s', 'subflow', { subflowId: 'child' }),
      node('q', 'subflow', { parallelSubflowIds: ['other-child'] }),
    ]);
    flowWith('child', [node('p', 'process', { boundModel: 'b' }), node('back', 'subflow', { subflowId: 'root' })]);
    flowWith('other-child', [node('p', 'process', { boundModel: 'local' })]);

    const reach = await describeFlowModelReach('root');

    expect(reach!.models.map((model) => model.id).sort()).toEqual(['a', 'b', 'local']);
  });

  it('marks what the list does not allow', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'a' }), node('q', 'process', { boundModel: 'b' })], ['a']);

    const reach = await describeFlowModelReach('f');

    expect(reach!.allowedModels).toEqual(['a']);
    expect(Object.fromEntries(reach!.models.map((model) => [model.id, model.allowed]))).toEqual({ a: true, b: false });
  });

  it('says so when the list may be too short', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'gone' }), node('s', 'subflow', { subflowId: 'gone-flow' })]);

    const reach = await describeFlowModelReach('f');

    expect(reach!.complete).toBe(false);
    expect(reach!.unresolved.map((item) => [item.kind, item.id])).toEqual([['model', 'gone'], ['flow', 'gone-flow']]);
  });

  it('is available over the API', async () => {
    flowWith('f', [node('p', 'process', { boundModel: 'a' })]);
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const found = await modelsRoute(new Request('http://localhost/api/flow/f/models?workspace=default-workspace') as never, params('f'));
    const missing = await modelsRoute(new Request('http://localhost/api/flow/none/models?workspace=default-workspace') as never, params('none'));

    expect(found.status).toBe(200);
    expect((await found.json()).models[0].id).toBe('a');
    expect(missing.status).toBe(404);
  });
});

describe('helpers', () => {
  it('narrows lists', () => {
    expect(intersectAllowedModels(undefined, undefined)).toBeUndefined();
    expect(intersectAllowedModels(['a'], undefined)).toEqual(['a']);
    expect(intersectAllowedModels(undefined, ['a'])).toEqual(['a']);
    expect(intersectAllowedModels(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(intersectAllowedModels(['a'], ['b'])).toEqual([]);
  });

  it('finds what is outside', () => {
    expect(modelsOutsideBoundary({ id: 'a' }, undefined)).toEqual([]);
    expect(modelsOutsideBoundary({ id: 'a' }, ['a'])).toEqual([]);
    expect(modelsOutsideBoundary({ id: 'a' }, [])).toEqual(['a']);
    expect(modelsOutsideBoundary({ id: 'p', fallbackPolicy: { modelIds: ['a', 'b'] } }, ['a'])).toEqual(['b']);
    expect(modelsOutsideBoundary({ id: 'p', fallbackPolicy: { modelIds: ['a'] } }, ['a'])).toEqual([]);
  });
});

describe('authoring', () => {
  const context = {
    models: [{ id: 'm1', name: 'model-one', displayName: 'Checked model' }, { id: 'm2', name: 'model-two' }],
    servers: [],
    serverTools: {},
  };
  const spec = (allowedModels: unknown) => ({
    name: 'Limited',
    allowedModels,
    nodes: [{ key: 'start', type: 'start' }, { key: 'step', type: 'process', model: 'm1', prompt: 'x' }, { key: 'finish', type: 'finish' }],
    edges: [{ from: 'start', to: 'step' }, { from: 'step', to: 'finish' }],
  });

  it('resolves names and carries the list there and back', () => {
    const compiled = compileFlowSpec(spec(['Checked model', 'model-two']) as never, context as never);

    expect(compiled.flow?.allowedModels).toEqual(['m1', 'm2']);
    expect(flowToSpec(compiled.flow!).allowedModels).toEqual(['m1', 'm2']);
  });

  it('keeps an empty list, which means no model, rather than dropping it', () => {
    expect(compileFlowSpec(spec([]) as never, context as never).flow?.allowedModels).toEqual([]);
  });

  it('leaves a flow without a list alone', () => {
    expect(compileFlowSpec(spec(undefined) as never, context as never).flow?.allowedModels).toBeUndefined();
  });

  it.each([
    ['an unknown model', ['nobody'], 'allowed-model-unknown'],
    ['a malformed list', 'm1', 'invalid-allowed-models'],
  ])('stops the compile on %s, because dropping it would change the limit', (_label, value, code) => {
    const compiled = compileFlowSpec(spec(value) as never, context as never);

    expect(compiled.issues.map((issue) => issue.code)).toContain(code);
    expect(compiled.errorCount).toBeGreaterThan(0);
  });

  describe('flow validation', () => {
    const models = [
      { id: 'a' },
      { id: 'b' },
      { id: 'policy', fallbackPolicy: { modelIds: ['a', 'b'] } },
    ];
    const flow = (boundModel: string, allowedModels: string[]) => oneStepFlow(`v-${boundModel}`, boundModel, allowedModels);
    const codes = (candidate: Flow) => validateFlow(candidate as never, { models }).issues.map((issue) => issue.code);

    it('reports a step outside the list and blocks the run', () => {
      expect(codes(flow('b', ['a']))).toContain('model-outside-allowed');
      expect(validateFlow(flow('b', ['a']) as never, { models }).isRunnable).toBe(false);
    });

    it('accepts a step on the list', () => {
      expect(codes(flow('a', ['a']))).not.toContain('model-outside-allowed');
    });

    it('judges a fallback policy by its members', () => {
      expect(codes(flow('policy', ['a']))).toContain('model-outside-allowed');
      expect(codes(flow('policy', ['a', 'b']))).not.toContain('model-outside-allowed');
    });
  });
});
