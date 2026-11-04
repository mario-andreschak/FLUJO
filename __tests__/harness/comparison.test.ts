/**
 * Comparison runs: the same examples against several models or flows, fixed checks only.
 *
 * Everything real runs here except the MCP layer: routes, the comparison service, runFlow,
 * nodes and the adapter against a loopback provider that behaves differently per model.
 * Counting requests matters, because the point of a comparison is that no model is asked
 * to propose or judge. Nothing may reach a real tool either.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { HarnessComparison } from '@/shared/types/harnessComparison';
import { StorageKey } from '@/shared/types/storage';

const mockRealToolCall = jest.fn();
const mockFlows = new Map<string, Flow>();
let mockModels: Model[] = [];
jest.mock('@/backend/services/mcp', () => {
  const known: Record<string, unknown> = {
    // The real callTool answers from the evaluation scope when one is active. Reaching
    // the line after that check would be a real tool call.
    callTool: async (server: string, tool: string, args: Record<string, unknown>) => {
      const scope = jest.requireActual('@/backend/services/harness/executionScope');
      if (scope.getHarnessExecution()) {
        return { success: true, data: { content: [{ type: 'text', text: scope.replayHarnessTool(`${server}::${tool}`, args) }] } };
      }
      mockRealToolCall(server, tool);
      return { success: true, data: {} };
    },
    loadServerConfigs: async () => [{ name: 'srv' }],
    setNodeRoots: () => undefined,
    getClient: () => ({}),
    getClientGeneration: () => 0,
    getToolSchemaHash: () => undefined,
  };
  return { mcpService: new Proxy(known, { get: (target, name: string) => target[name] ?? (async () => ({})) }) };
});
jest.mock('@/backend/services/flow', () => ({
  flowService: {
    getFlow: async (id: string) => mockFlows.get(id) ?? null,
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
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/utils/encryption/secure', () => ({
  ...jest.requireActual('@/utils/encryption/secure'),
  isEncryptionLocked: jest.fn(async () => false),
}));

import { DELETE as itemDelete, GET as itemGet } from '@/app/api/harness/comparisons/[id]/route';
import { GET as listGet, POST as listPost } from '@/app/api/harness/comparisons/route';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { harnessComparisonFinished } from '@/backend/services/harness/comparison';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';

jest.setTimeout(60_000);

const FETCH_TOOL = encodeToolName('srv', 'fetch_hours');
const WRITE_TOOL = encodeToolName('srv', 'send_it');

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function stepFlow(id: string, extra: Partial<Flow> = {}, boundModel = 'small'): Flow {
  const flow = {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('process', 'process', { boundModel, promptTemplate: 'Answer.' }),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['fetch_hours', 'send_it'] }),
    ],
    edges: [
      { id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'process', target: 'tools', data: { edgeType: 'mcp' } },
    ],
    ...extra,
  } as unknown as Flow;
  mockFlows.set(id, flow);
  return flow;
}

describe('comparison runs', () => {
  let server: Server;
  let dataDir: string;
  let previousDataDir: string | undefined;
  let requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
  /** What each model does: which tools it calls first, and what it finally says. */
  let script: Record<string, { calls?: string[]; say: string; reportAs?: string }> = {};

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        const plan = script[body.model] ?? { say: 'no script' };
        const answered = body.messages.some((message: { role: string }) => message.role === 'tool');
        const calls = !answered && plan.calls?.length
          ? plan.calls.map((name, index) => ({ id: `call_${index}`, index, type: 'function', function: { name, arguments: '{}' } }))
          : undefined;
        const toolEcho = body.messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => message.content).join(' ');
        const content = calls ? null : `${plan.say}${toolEcho ? ` ${toolEcho}` : ''}`;
        // An evaluation scope always asks for the whole answer at once.
        expect(body.stream).toBeFalsy();
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 1,
          model: plan.reportAs ?? body.model,
          choices: [{
            index: 0,
            finish_reason: calls ? 'tool_calls' : 'stop',
            logprobs: null,
            message: { role: 'assistant', content, refusal: null, ...(calls ? { tool_calls: calls } : {}) },
          }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    mockModels = ['small', 'large'].map((id) => ({
      id, name: id, provider: 'openai', adapter: 'openai', ApiKey: 'loopback-fixture-key', baseUrl,
    } as Model));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-comparison-'));
    process.env.FLUJO_DATA_DIR = dataDir;
    await fs.mkdir(path.join(dataDir, 'workspaces', 'default-workspace', 'db'), { recursive: true });
    await saveItem(StorageKey.MODELS, mockModels);
    await saveItem(StorageKey.SPEECH_SETTINGS, { speech: {}, experimental: { harnessLabEnabled: true } } as never);
    requests = [];
    script = { small: { say: 'Small answer' }, large: { say: 'Large answer' } };
    mockRealToolCall.mockReset();
    mockFlows.clear();
    FlowExecutor.clearFlowCache();
    jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async () => ({
      success: true,
      value: { availableTools: ['fetch_hours', 'send_it'].map((name) => ({
        name: encodeToolName('srv', name), originalName: name, server: 'srv', description: name,
        inputSchema: { type: 'object', properties: {} },
      })) },
    }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const post = (body: unknown) => listPost(new Request('http://localhost/api/harness/comparisons?workspace=default-workspace', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }) as never);
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const read = async (id: string) => (await itemGet(new Request(`http://localhost/api/harness/comparisons/${id}?workspace=default-workspace`) as never, params(id))).json() as Promise<HarnessComparison>;

  /** Starts a comparison and waits for it, as a client polling the API would see it. */
  const compare = async (input: Record<string, unknown>, id = randomUUID()) => {
    const response = await post({ id, input: { name: 'Test', ...input } });
    expect(response.status).toBe(201);
    await harnessComparisonFinished(id);
    return read(id);
  };
  const both = [{ flowId: 'assistant', modelId: 'small' }, { flowId: 'assistant', modelId: 'large' }];

  it('runs the same examples on each model and needs no model to judge', async () => {
    stepFlow('assistant');
    script.large = { say: 'I think it is fine' };

    const done = await compare({
      variants: both,
      cases: [{ id: 'hours', input: 'When do you open?', forbidden: ['i think'] }, { id: 'where', input: 'Where are you?' }],
    });

    expect(done.status).toBe('completed');
    expect(requests.map((request) => request.model)).toEqual(['small', 'small', 'large', 'large']);
    expect(done.summary.map((row) => [row.modelId, row.passed, row.failed])).toEqual([['small', 2, 0], ['large', 1, 1]]);
    expect(done.results.find((result) => result.variant === 1 && result.caseId === 'hours')).toMatchObject({
      status: 'failed', violations: ['i think'], modelsUsed: ['large'],
    });
  });

  it('compares different flows too, leaving saved flows untouched', async () => {
    stepFlow('first', {}, 'small');
    stepFlow('second', {}, 'large');
    const saved = JSON.stringify(mockFlows.get('first'));

    const done = await compare({
      variants: [{ flowId: 'first' }, { flowId: 'second' }],
      cases: [{ input: 'Hello' }],
    });

    expect(done.results.map((result) => result.modelsUsed)).toEqual([['small'], ['large']]);
    expect(JSON.stringify(mockFlows.get('first'))).toBe(saved);

    await compare({ variants: [{ flowId: 'first', modelId: 'large' }], cases: [{ input: 'Hello' }] });
    expect(JSON.stringify(mockFlows.get('first'))).toBe(saved);
  });

  it('checks required phrases, ignoring case', async () => {
    stepFlow('assistant');

    const done = await compare({
      variants: [{ flowId: 'assistant', modelId: 'small' }],
      cases: [{ id: 'yes', input: 'Hello', required: ['small ANSWER'] }, { id: 'no', input: 'Hello again', required: ['nothing like this'] }],
    });

    expect(done.results.map((result) => [result.caseId, result.status, result.missing])).toEqual([
      ['yes', 'passed', []],
      ['no', 'failed', ['nothing like this']],
    ]);
  });

  describe('tool checks', () => {
    it('passes when the expected tool is called, and gives the model the case result', async () => {
      stepFlow('assistant');
      script.small = { calls: [FETCH_TOOL], say: 'We open at' };

      const done = await compare({
        variants: [{ flowId: 'assistant', modelId: 'small' }],
        cases: [{ input: 'When?', expectedTools: ['fetch_hours'], required: ['8 am'], toolResults: { fetch_hours: '8 am' } }],
      });

      expect(done.results[0]).toMatchObject({ status: 'passed', toolsCalled: ['fetch_hours'], modelCalls: 2 });
      expect(done.results[0].output).toContain('8 am');
    });

    it('fails when the expected tool is not called', async () => {
      stepFlow('assistant');

      const done = await compare({
        variants: [{ flowId: 'assistant', modelId: 'small' }],
        cases: [{ input: 'When?', expectedTools: ['fetch_hours'] }],
      });

      expect(done.results[0]).toMatchObject({ status: 'failed', missingTools: ['fetch_hours'], toolsCalled: [] });
    });

    it('fails when a forbidden tool is called', async () => {
      stepFlow('assistant');
      script.small = { calls: [WRITE_TOOL], say: 'Done' };

      const done = await compare({
        variants: [{ flowId: 'assistant', modelId: 'small' }],
        cases: [{ input: 'Send it', forbiddenTools: ['send_it'] }],
      });

      expect(done.results[0]).toMatchObject({ status: 'failed', forbiddenToolsCalled: ['send_it'] });
    });

    it('never runs a tool for real, and says so to the model', async () => {
      stepFlow('assistant');
      script.small = { calls: [WRITE_TOOL], say: 'Result:' };

      const done = await compare({ variants: [{ flowId: 'assistant', modelId: 'small' }], cases: [{ input: 'Send it' }] });

      expect(mockRealToolCall).not.toHaveBeenCalled();
      expect(done.results[0].output).toContain('did not run');
    });

    it('does not stop for a step that requires approval, since nothing has an effect', async () => {
      stepFlow('assistant');
      const flow = mockFlows.get('assistant')!;
      (flow.nodes.find((candidate) => candidate.id === 'process')!.data.properties as Record<string, unknown>).requireApprovalFor = ['send_it'];
      script.small = { calls: [WRITE_TOOL], say: 'Done' };

      const done = await compare({ variants: [{ flowId: 'assistant', modelId: 'small' }], cases: [{ input: 'Send it', expectedTools: ['send_it'] }] });

      expect(done.results[0]).toMatchObject({ status: 'passed' });
    });
  });

  describe('flow limits still apply', () => {
    it('reports a model outside the flow\'s list as an error, without a request', async () => {
      stepFlow('assistant', { allowedModels: ['small'] });

      const done = await compare({ variants: both, cases: [{ input: 'Hello' }] });

      expect(done.results[0].status).toBe('passed');
      expect(done.results[1]).toMatchObject({ status: 'error', error: { code: 'model_not_allowed' }, modelCalls: 0 });
      expect(requests.map((request) => request.model)).toEqual(['small']);
    });

    it('shows a condition before the model holding, with no model call', async () => {
      mockFlows.set('gated', {
        id: 'gated',
        name: 'gated',
        nodes: [
          node('start', 'start'),
          node('fixed', 'static', { outputTemplate: 'A person will answer.' }),
          node('end', 'finish'),
          node('process', 'process', { boundModel: 'small', promptTemplate: 'Answer.' }),
        ],
        edges: [
          { id: 'block', source: 'start', target: 'fixed', data: { edgeType: 'standard', condition: { kind: 'contains', value: 'forbidden' } } },
          { id: 'open', source: 'start', target: 'process', data: { edgeType: 'standard' } },
          { id: 'finish', source: 'fixed', target: 'end', data: { edgeType: 'standard' } },
        ],
      } as unknown as Flow);

      const done = await compare({
        variants: [{ flowId: 'gated' }],
        cases: [
          { id: 'blocked', input: 'A forbidden question', required: ['a person will answer'] },
          { id: 'open', input: 'An ordinary question', required: ['small answer'] },
        ],
      });

      expect(done.results.map((result) => [result.caseId, result.status, result.modelCalls])).toEqual([
        ['blocked', 'passed', 0],
        ['open', 'passed', 1],
      ]);
    });

    it('passes through a wait for a person and a gated Static call, with no real effect', async () => {
      mockFlows.set('waits', {
        id: 'waits',
        name: 'waits',
        nodes: [
          node('start', 'start'),
          node('decide', 'static', {
            entries: [
              { kind: 'humanGate', text: 'Go on?' },
              { kind: 'toolCall', executionMode: 'real', serverName: 'srv', toolName: 'send_it', argumentsJson: '{}', result: '', requireApproval: true },
            ],
            outputTemplate: 'Finished.',
          }),
          node('end', 'finish'),
          node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['send_it'] }),
        ],
        edges: [
          { id: 'a', source: 'start', target: 'decide', data: { edgeType: 'standard' } },
          { id: 'b', source: 'decide', target: 'end', data: { edgeType: 'standard' } },
          { id: 'c', source: 'decide', target: 'tools', data: { edgeType: 'mcp' } },
        ],
      } as unknown as Flow);

      const done = await compare({ variants: [{ flowId: 'waits' }], cases: [{ input: 'Go', expectedTools: ['send_it'], required: ['finished'] }] });

      expect(done.results[0]).toMatchObject({ status: 'passed', modelCalls: 0, toolsCalled: ['send_it'] });
      expect(mockRealToolCall).not.toHaveBeenCalled();
    });
  });

  it('records the name a provider reports instead of failing on it', async () => {
    stepFlow('assistant');
    script.small = { say: 'Small answer', reportAs: 'small-2026-11-01' };

    const done = await compare({ variants: [{ flowId: 'assistant', modelId: 'small' }], cases: [{ input: 'Hello' }] });

    expect(done.results[0]).toMatchObject({ status: 'passed', modelsUsed: ['small'], reportedModels: ['small-2026-11-01'] });
  });

  it('runs well past the limit of an experiment', async () => {
    stepFlow('assistant');

    const done = await compare({
      variants: [{ flowId: 'assistant', modelId: 'small' }],
      cases: Array.from({ length: 50 }, (_, index) => ({ input: `Question ${index}`, required: ['small answer'] })),
    });

    expect(done.results).toHaveLength(50);
    expect(done.summary[0].passed).toBe(50);
  });

  it('counts a run stopped by the call limit as an error, not a failed check', async () => {
    stepFlow('assistant');
    script.small = { calls: [FETCH_TOOL], say: 'Done' };

    const done = await compare({
      variants: [{ flowId: 'assistant', modelId: 'small' }],
      cases: [{ input: 'Hello' }],
      maxModelCallsPerCase: 1,
    });

    expect(done.results[0].status).toBe('error');
    expect(requests).toHaveLength(1);
  });

  describe('managing a comparison', () => {
    it('repeats nothing when a client retries the same request', async () => {
      stepFlow('assistant');
      const id = randomUUID();
      const input = { variants: [{ flowId: 'assistant', modelId: 'small' }], cases: [{ input: 'Hello' }] };

      await compare(input, id);
      const count = requests.length;
      const retried = await post({ id, input: { name: 'Test', ...input } });

      expect(retried.status).toBe(201);
      expect(requests).toHaveLength(count);
    });

    it('refuses a different request under a used id', async () => {
      stepFlow('assistant');
      const id = randomUUID();
      await compare({ variants: [{ flowId: 'assistant' }], cases: [{ input: 'Hello' }] }, id);

      const response = await post({ id, input: { name: 'Other', variants: [{ flowId: 'assistant' }], cases: [{ input: 'Hello' }] } });

      expect(response.status).toBe(409);
    });

    it('stays off until Harness Lab is enabled', async () => {
      await saveItem(StorageKey.SPEECH_SETTINGS, { speech: {} } as never);
      stepFlow('assistant');

      const response = await post({ id: randomUUID(), input: { name: 'Test', variants: [{ flowId: 'assistant' }], cases: [{ input: 'Hello' }] } });

      expect(response.status).toBe(403);
    });

    it.each([
      ['no variants', { variants: [], cases: [{ input: 'Hello' }] }],
      ['no examples', { variants: [{ flowId: 'assistant' }], cases: [] }],
      ['too many examples', { variants: [{ flowId: 'assistant' }], cases: Array.from({ length: 201 }, (_, index) => ({ input: `Q${index}` })) }],
      ['an unknown field', { variants: [{ flowId: 'assistant' }], cases: [{ input: 'Hello', judge: 'model' }] }],
    ])('refuses %s', async (_label, input) => {
      stepFlow('assistant');

      const response = await post({ id: randomUUID(), input: { name: 'Test', ...input } });

      expect(response.status).toBe(400);
    });

    it('refuses repeated example ids, and flows or models it cannot find', async () => {
      stepFlow('assistant');
      const cases = [{ input: 'Hello' }];

      expect((await post({ id: randomUUID(), input: { name: 'T', variants: [{ flowId: 'assistant' }], cases: [{ id: 'x', input: 'A' }, { id: 'x', input: 'B' }] } })).status).toBe(400);
      expect((await post({ id: randomUUID(), input: { name: 'T', variants: [{ flowId: 'nowhere' }], cases } })).status).toBe(404);
      expect((await post({ id: randomUUID(), input: { name: 'T', variants: [{ flowId: 'assistant', modelId: 'nobody' }], cases } })).status).toBe(404);
    });

    it('lists comparisons with their totals', async () => {
      stepFlow('assistant');
      const id = randomUUID();
      await compare({ variants: [{ flowId: 'assistant', modelId: 'small' }], cases: [{ input: 'Hello' }] }, id);

      const { comparisons } = await (await (listGet as unknown as (request: Request) => Promise<Response>)(new Request('http://localhost/api/harness/comparisons?workspace=default-workspace'))).json();

      expect(comparisons).toEqual([expect.objectContaining({ id, status: 'completed', cases: 1, name: 'Test' })]);
      expect(comparisons[0].summary[0].passed).toBe(1);
    });

    it('says a comparison was interrupted when a restart cut it off, keeping what it had', async () => {
      const id = randomUUID();
      await saveCollectionItem('harness-comparisons', id, {
        schemaVersion: 1, id, createdAt: 1, updatedAt: 1, status: 'running', input: { name: 'T', variants: [{ flowId: 'assistant' }], cases: [{ input: 'A', required: [], forbidden: [], expectedTools: [], forbiddenTools: [] }], maxModelCallsPerCase: 8 },
        results: [{ variant: 0, caseId: 'case-1', status: 'passed' }], summary: [],
      });

      const seen = await read(id);

      expect(seen.status).toBe('interrupted');
      expect(seen.results).toHaveLength(1);
    });

    it('stops a running comparison and removes a finished one', async () => {
      stepFlow('assistant');
      const running = randomUUID();
      expect((await post({ id: running, input: { name: 'T', variants: [{ flowId: 'assistant', modelId: 'small' }], cases: Array.from({ length: 20 }, (_, index) => ({ input: `Q${index}` })) } })).status).toBe(201);

      const stopped = await itemDelete(new Request(`http://localhost/api/harness/comparisons/${running}?workspace=default-workspace`) as never, params(running));
      expect(await stopped.json()).toEqual({ status: 'cancelled' });
      const cancelled = await read(running);
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.results.length).toBeLessThan(20);

      const removed = await itemDelete(new Request(`http://localhost/api/harness/comparisons/${running}?workspace=default-workspace`) as never, params(running));
      expect(await removed.json()).toEqual({ status: 'deleted' });
      const gone = await itemGet(new Request(`http://localhost/api/harness/comparisons/${running}?workspace=default-workspace`) as never, params(running));
      expect(gone.status).toBe(404);
    });
  });
});
