/**
 * #571 ordering contracts at the real execution boundaries. Only catalogue
 * lookup and key resolution are fixtures: graph conversion, nodes, runFlow,
 * model handler, adapter/installed SDK, journal and snapshot storage execute.
 * The provider is a loopback HTTP endpoint, never an external account.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import type { SharedState } from '@/backend/execution/flow/types';
import type { StorageKey } from '@/shared/types/storage';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';

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
      id, name: 'ordering-fixture', provider: 'openai', adapter: 'openai',
      ApiKey: '', baseUrl: mockBaseUrl,
    }),
    loadModels: async () => [{ id: 'ordering-model', name: 'ordering-fixture' }],
    resolveAndDecryptApiKey: async () => 'loopback-fixture-key',
  },
}));
// SWC exports are non-configurable. Wrap the real implementations through Jest's
// module factory; the wrappers observe completed I/O and do not replace it.
jest.mock('@/backend/execution/flow/persistConversationState', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/persistConversationState')>(
    '@/backend/execution/flow/persistConversationState',
  );
  return { ...actual, persistConversationState: async (...args: Parameters<typeof actual.persistConversationState>) => {
    const [, state] = args;
    if (!state.ephemeral && state.recovery?.currentCheckpoint) {
      const events = await conversationLog.readConversationLog(state.conversationId!);
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
        type: 'recovery:checkpoint', checkpoint: expect.objectContaining({ id: state.recovery.currentCheckpoint.id }),
      })]));
      record(state.conversationId!, `durable-checkpoint:${state.recovery.currentCheckpoint.phase}`);
    }
    await actual.persistConversationState(...args);
    if (!state.ephemeral) record(state.conversationId!, `snapshot:${state.recovery?.currentCheckpoint?.phase ?? 'none'}:${state.recovery?.classification ?? 'none'}`);
  } };
});
jest.mock('@/backend/execution/flow/modelTurnArchive', () => {
  const actual = jest.requireActual<typeof import('@/backend/execution/flow/modelTurnArchive')>(
    '@/backend/execution/flow/modelTurnArchive',
  );
  return {
    ...actual,
    archiveModelDispatch: async (...args: Parameters<typeof actual.archiveModelDispatch>) => {
      const entry = await actual.archiveModelDispatch(...args);
      dispatch = { conversationId: args[0].conversationId, nodeId: args[0].nodeId, id: entry.id };
      record(dispatch.conversationId, `archive:${dispatch.nodeId}`);
      return entry;
    },
    updateModelDispatchOutcome: async (...args: Parameters<typeof actual.updateModelDispatchOutcome>) => {
      await actual.updateModelDispatchOutcome(...args);
      record(args[0], `archive-outcome:${args[2]}`);
    },
  };
});

import { runFlow, type FlowRunInput } from '@/backend/execution/flow/runFlow';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import * as conversationLog from '@/backend/execution/flow/conversationLog';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { loadItem } from '@/utils/storage/backend';
import { mcpService } from '@/backend/services/mcp';
import { saveConfig } from '@/backend/services/mcp/config';
import { installTrustedHostProfile } from '../mcp/fixtures/trustedHostProfile';
import { fingerprintTrustedHostExecutable, fingerprintTrustedHostSource, trustedHostMcpApproval } from '@/backend/services/security/trustedHostMcp';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';

jest.setTimeout(30_000);

type Observation = { conversationId: string; operation: string; elapsedMs: number };
type Dispatch = { conversationId: string; nodeId: string; id: string };
const observations: Observation[] = [];
let dispatch: Dispatch | undefined;
let server: Server;
let unsubscribe: () => void;
let respond: (response: ServerResponse, body: Record<string, unknown>) => void;
let toolConversationId = '';
let actualToolCalls = 0;
let profile = '';
let observationStart = 0;
const httpBodies: Record<string, unknown>[] = [];
const toolChildren: ChildProcess[] = [];
let toolProfile: ReturnType<typeof installTrustedHostProfile> | undefined;
const realStep = FlowExecutor.executeStep;

function record(conversationId: string, operation: string) {
  observations.push({ conversationId, operation, elapsedMs: Math.round(performance.now() - observationStart) });
}

function eventOperation(event: ExecutionEvent): string {
  if (event.type === 'recovery:checkpoint') return `event:checkpoint:${event.checkpoint.phase}`;
  if (event.type === 'recovery:transition') return `event:recovery:${event.recovery.classification}`;
  return `event:${event.type}`;
}

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } };
}

function flow(id: string, properties: Record<string, unknown> = {}): Flow {
  const definition: Flow = {
    id, name: id,
    nodes: [node('start', 'start'), node('process', 'process', { boundModel: 'ordering-model', ...properties })],
    edges: [{ id: 'start-to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } }],
  };
  mockFlows.set(id, definition);
  return definition;
}

function answer(response: ServerResponse, body: Record<string, unknown>, content = 'fixture answer', callIdentity = false) {
  const toolCalls = callIdentity ? [{ id: 'call-identity', type: 'function',
    function: { name: encodeToolName('ordering-fixture', 'identity'), arguments: '{}' } }] : undefined;
  const finishReason = callIdentity ? 'tool_calls' : 'stop';
  const message = { role: 'assistant', content: callIdentity ? null : content, refusal: null,
    ...(toolCalls ? { tool_calls: toolCalls } : {}) };
  const completion = {
    id: 'fixture-completion', object: 'chat.completion', created: 1, model: 'ordering-fixture',
    choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message }],
  };
  if (body.stream) {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
      choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: message.content,
        ...(toolCalls ? { tool_calls: toolCalls.map(call => ({ ...call, index: 0 })) } : {}) } }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk',
      choices: [{ index: 0, finish_reason: finishReason, delta: {} }] })}\n\ndata: [DONE]\n\n`);
  } else {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(completion));
  }
}

async function toolFlow(id: string, maxTurns = 3): Promise<Flow> {
  record(id, 'fixture:stage:start');
  const source = fs.readFileSync(path.resolve('__tests__/mcp/fixtures/processBoundaryServer.mjs'), 'utf8')
    .replace(/from '(@modelcontextprotocol\/[^']+)'/g, (_match, moduleName: string) =>
      `from ${JSON.stringify(pathToFileURL(require.resolve(moduleName)).href)}`);
  toolProfile = installTrustedHostProfile({ name: 'ordering-fixture', nodeSource: source });
  const config = toolProfile.config;
  const policy = trustedHostMcpApproval(config).policy;
  const originalEntryPoint = policy.entryPoint;
  const entryPoint = path.join(policy.sourceRoot, 'processBoundaryServer.mjs');
  fs.renameSync(originalEntryPoint, entryPoint);
  config.args = [entryPoint];
  config.source = { type: 'local' };
  Object.assign(config.trustedHost!, { runtime: 'node', entryPoint,
    sourceDigest: fingerprintTrustedHostSource(policy.sourceRoot),
    executableDigest: fingerprintTrustedHostExecutable(process.execPath) });
  toolProfile.approve();
  record(id, 'fixture:stage:done');
  expect(await saveConfig(new Map([[config.name, config]]))).toMatchObject({ success: true });
  const definition = flow(id, { maxTurns });
  definition.nodes.push(node('mcp-fixture', 'mcp', { boundServer: config.name, enabledTools: ['identity'] }));
  definition.edges.push({ id: 'process-mcp', source: 'process', target: 'mcp-fixture', data: { edgeType: 'mcp' } });
  toolConversationId = id;
  const realCall = mcpService.callTool.bind(mcpService);
  jest.spyOn(mcpService, 'callTool').mockImplementation(async (...args) => {
    record(toolConversationId, `tool-dispatch:${args[1]}`);
    const result = await realCall(...args);
    actualToolCalls += 1;
    if (!result.success) record(toolConversationId, `tool-error:${result.error}`);
    const identity = (result.data as { structuredContent?: { pid?: number; parentPid?: number; token?: string } })?.structuredContent;
    expect(result.success).toBe(true);
    expect(identity?.pid).toBeGreaterThan(0);
    expect(identity?.pid).not.toBe(process.pid);
    expect(identity?.parentPid).toBe(process.pid);
    expect(identity?.token).toMatch(/^[0-9a-f-]{36}$/);
    const child = (mcpService.getClient(config.name)?.transport as unknown as { _process?: ChildProcess })?._process;
    expect(child?.pid).toBe(identity?.pid);
    if (child && !toolChildren.includes(child)) toolChildren.push(child);
    record(toolConversationId, `tool-result:${args[1]}`);
    return result;
  });
  return definition;
}

function input(conversationId: string, definition = flow(conversationId)): FlowRunInput {
  return {
    conversationId, flowDefinition: definition, prompt: 'Test the execution boundary.',
    source: 'api', mode: 'conversation',
    executionAuthority: {
      signal: new AbortController().signal,
      assertCurrent: async () => { record(conversationId, 'authority'); },
    },
  };
}

function operations(conversationId: string): string[] {
  return observations.filter(entry => entry.conversationId === conversationId).map(entry => entry.operation);
}

function expectOrdered(conversationId: string, expected: string[]) {
  const actual = operations(conversationId);
  let cursor = -1;
  for (const operation of expected) {
    const next = actual.indexOf(operation, cursor + 1);
    expect({ operation, trace: actual, foundAfterPrevious: next > cursor }).toEqual(expect.objectContaining({
      foundAfterPrevious: true,
    }));
    cursor = next;
  }
}

beforeEach(async () => {
  observationStart = performance.now();
  observations.length = 0;
  httpBodies.length = 0;
  toolChildren.length = 0;
  dispatch = undefined;
  actualToolCalls = 0;
  profile = expect.getState().currentTestName ?? 'unknown';
  mockFlows.clear();
  FlowExecutor.conversationStates.clear();
  FlowExecutor.clearFlowCache();
  respond = (response, body) => answer(response, body);
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      if (!dispatch) {
        response.writeHead(500); response.end('Dispatch was not archived before HTTP.');
        return;
      }
      record(dispatch.conversationId, `http:${dispatch.nodeId}`);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      httpBodies.push(body);
      respond(response, body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  unsubscribe = executionEventBus.subscribeGlobal(({ event }) => record(event.conversationId, eventOperation(event)));

  jest.spyOn(FlowExecutor, 'executeStep').mockImplementation(async (state, emit) => {
    const nextNodeId = await FlowExecutor.peekNextNodeId(state);
    record(state.conversationId!, `step:${nextNodeId}`);
    const result = await realStep.call(FlowExecutor, state, emit);
    record(state.conversationId!, `step-return:${nextNodeId}:${result.action}`);
    return result;
  });
});

afterEach(async () => {
  const teardown = await mcpService.disconnectAll('execution-ordering-test');
  unsubscribe?.();
  for (const conversationId of FlowExecutor.conversationStates.keys()) {
    await conversationLog.flushConversationLog(conversationId);
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  jest.restoreAllMocks();
  FlowExecutor.conversationStates.clear();
  FlowExecutor.clearFlowCache();
  console.info('CODE_HEALTH_EXECUTION_TRACE', JSON.stringify({ profile, observations, actualToolCalls,
    shutdownReceipts: teardown.shutdownReceipts,
    childExits: toolChildren.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
  }));
  expect(teardown.failed).toEqual([]);
  for (const receipt of teardown.shutdownReceipts) {
    expect(receipt).toMatchObject({ processOwnership: 'owned', exitOutcome: 'observed_exit', errorClassification: 'none' });
  }
  for (const child of toolChildren) {
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  }
  toolProfile?.restore();
  toolProfile = undefined;
});

describe('execution ordering with real graph and loopback SDK dispatch', () => {
  it('commits checkpoints before a physical request and terminal recovery before run:done', async () => {
    const conversationId = 'ordering-ordinary';
    const result = await runFlow(input(conversationId));
    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('fixture answer');
    expectOrdered(conversationId, [
      'event:run:start', 'event:recovery:running',
      'event:checkpoint:node:before', 'durable-checkpoint:node:before', 'snapshot:node:before:running', 'step:start',
      'event:checkpoint:node:after', 'step:process', 'archive:process', 'event:model:dispatch', 'http:process',
      'archive-outcome:completed', 'event:checkpoint:node:after',
      'event:recovery:completed', 'snapshot:node:after:completed', 'event:run:done',
    ]);
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    const snapshot = await loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
    expect(snapshot?.status).toBe('completed');
    expect(snapshot?.recovery?.classification).toBe('completed');
    expect(snapshot?.executionAuthority).toBeUndefined();
  });

  it('pauses before and after a model turn and consumes its saved action without redispatch', async () => {
    const conversationId = 'ordering-debug';
    const request = input(conversationId);
    const first = await runFlow({ ...request, debug: true, userTurn: true });
    expect(first.status).toBe('paused_debug');
    expect(first.sharedState.debugBoundary).toMatchObject({ operation: 'node', phase: 'before', nodeId: 'start' });
    expect(operations(conversationId)).not.toContain('http:process');
    record(conversationId, 'resume:first-step');
    const startStep = await runFlow({ ...request, prompt: undefined, userTurn: false });
    expect(startStep.status).toBe('paused_debug');
    expect(operations(conversationId)).not.toContain('http:process');
    record(conversationId, 'resume:model-step');
    const second = await runFlow({ ...request, prompt: undefined, userTurn: false });
    expect(second.status).toBe('paused_debug');
    expect(second.sharedState.debugPendingAction).toMatchObject({ action: 'FINAL_RESPONSE' });
    const preparation = second.sharedState.executionTrace?.find(step => step.nodeId === 'process')?.prepResultSnapshot;
    expect(preparation).toBeDefined();
    expect(Object.hasOwn(preparation!, 'abortSignal')).toBe(false);
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    record(conversationId, 'resume:consume-action');
    const third = await runFlow({ ...request, prompt: undefined, userTurn: false });
    expect(third.status).toBe('completed');
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    expectOrdered(conversationId, [
      'event:recovery:paused', 'resume:first-step', 'step:start', 'resume:model-step', 'step:process', 'archive:process', 'http:process',
      'archive-outcome:completed', 'event:recovery:paused', 'resume:consume-action',
      'event:recovery:completed', 'event:run:done',
    ]);
  });

  it('holds a real stdio tool behind approval, then records the result before the next request', async () => {
    const conversationId = 'ordering-approval';
    const request = input(conversationId, await toolFlow(conversationId));
    let turns = 0;
    respond = (response, body) => answer(response, body, 'approved result', ++turns === 1);
    const first = await runFlow({ ...request, requireApproval: true, onApprovalRequired: 'pause' });
    expect(first.status).toBe('awaiting_tool_approval');
    expect(actualToolCalls).toBe(0);
    const pending = first.sharedState.pendingToolCalls!;
    expect(pending).toHaveLength(1);
    record(conversationId, 'decision:approve');
    expect((await applyApprovalDecision(first.sharedState, pending[0].id, 'approve')).outcome).toBe('ready');
    expect(actualToolCalls).toBe(1);
    const second = await runFlow({ ...request, prompt: undefined });
    expect(second.status).toBe('completed');
    expect(second.outputText).toBe('approved result');
    expect(actualToolCalls).toBe(1);
    expectOrdered(conversationId, [
      'http:process', 'event:run:awaiting_approval', 'event:recovery:paused',
      'decision:approve', 'tool-dispatch:identity', 'tool-result:identity',
      'http:process', 'event:recovery:completed', 'event:run:done',
    ]);
    expect(second.sharedState.messages.filter(message => message.role === 'tool')).toHaveLength(1);
  });

  it('answers capped calls synthetically before a final summary request without executing a tool', async () => {
    const conversationId = 'ordering-cap';
    const request = input(conversationId, await toolFlow(conversationId, 1));
    let turns = 0;
    respond = (response, body) => {
      answer(response, body, 'capped summary', ++turns === 1);
    };
    const result = await runFlow(request);
    expect(result.status).toBe('capped');
    expect(result.outputText).toBe('capped summary');
    expect(turns).toBe(2);
    expect(httpBodies[1].tools).toBeUndefined();
    expect(httpBodies[1].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'tool', tool_call_id: 'call-identity' })]));
    expect(actualToolCalls).toBe(0);
    expectOrdered(conversationId, [
      'http:process', 'archive-outcome:completed', 'event:message',
      'http:process', 'archive-outcome:completed', 'event:recovery:capped', 'event:run:done',
    ]);
  });

  it('persists a permanent provider failure before its terminal event without extra HTTP attempts', async () => {
    const conversationId = 'ordering-error';
    respond = response => {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture authentication failure', type: 'authentication_error', code: 'invalid_api_key' } }));
    };
    const result = await runFlow(input(conversationId));
    expect(result.status).toBe('error');
    expect(result.error?.statusCode).toBe(401);
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    expectOrdered(conversationId, [
      'archive:process', 'http:process', 'archive-outcome:error', 'event:error',
      'event:recovery:permanent_failure', 'snapshot:node:before:permanent_failure', 'event:run:done',
    ]);
  });

  it.each(['run', 'run-with-authority', 'authority'] as const)(
    'aborts an in-flight physical request from %s and journals cancellation before the terminal event', async cancellation => {
    const conversationId = `ordering-cancel-${cancellation}`;
    const controller = new AbortController();
    let received!: () => void;
    const requestReceived = new Promise<void>(resolve => { received = resolve; });
    let connectionClosed!: (aborted: boolean) => void;
    const physicalConnectionClosed = new Promise<boolean>(resolve => { connectionClosed = resolve; });
    let pendingResponse!: ServerResponse;
    let pendingBody!: Record<string, unknown>;
    respond = (response, body) => {
      pendingResponse = response;
      pendingBody = body;
      response.once('close', () => {
        const aborted = controller.signal.aborted && !response.writableEnded;
        record(conversationId, aborted ? 'http:closed-by-abort' : 'http:response-ended');
        connectionClosed(aborted);
      });
      received();
    };
    const request = input(conversationId);
    if (cancellation === 'run') request.executionAuthority = undefined;
    if (cancellation === 'authority') request.executionAuthority!.signal = controller.signal;
    const running = runFlow({ ...request, ...(cancellation !== 'authority' ? { abortSignal: controller.signal } : {}) });
    await requestReceived;
    record(conversationId, 'owner:cancel');
    controller.abort();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abortedAtEndpoint = await Promise.race([
      physicalConnectionClosed,
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5_000); }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!abortedAtEndpoint) {
      // Drain a faulty implementation before failing, so it cannot outlive the
      // isolated data root or corrupt later profiles. This is failure cleanup.
      record(conversationId, 'cleanup:owner-abort-was-not-forwarded');
      FlowExecutor.conversationStates.get(conversationId)!.isCancelled = true;
      answer(pendingResponse, pendingBody);
      await running;
      throw new Error('Owner abort did not stop the actual provider request.');
    }
    const result = await running;
    expect(result.status).toBe('error');
    expect(result.error?.message).toMatch(/cancelled/i);
    expect(result.sharedState.recovery?.classification).toBe('cancelled');
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    expectOrdered(conversationId, [
      'archive:process', 'http:process', 'owner:cancel', 'archive-outcome:cancelled',
      'event:recovery:cancelled', 'snapshot:node:before:cancelled', 'event:run:done',
    ]);
  });

  it('reloads a durable debugger pause and completes its saved action without repeating HTTP', async () => {
    const conversationId = 'ordering-cold-resume';
    const request = input(conversationId);
    await runFlow({ ...request, debug: true, userTurn: true });
    await runFlow({ ...request, prompt: undefined });
    const paused = await runFlow({ ...request, prompt: undefined });
    expect(paused.status).toBe('paused_debug');
    expect(paused.sharedState.debugPendingAction).toMatchObject({ action: 'FINAL_RESPONSE' });
    const runId = paused.runId;
    await conversationLog.flushConversationLog(conversationId);
    FlowExecutor.conversationStates.clear();
    FlowExecutor.clearFlowCache();
    record(conversationId, 'restart:discard-live-state');
    const result = await runFlow({ ...request, prompt: undefined });
    expect(result.status).toBe('completed');
    expect(result.runId).toBe(runId);
    expect(operations(conversationId).filter(operation => operation === 'http:process')).toHaveLength(1);
    expectOrdered(conversationId, [
      'http:process', 'archive-outcome:completed', 'event:recovery:paused',
      'restart:discard-live-state', 'event:recovery:completed', 'event:run:done',
    ]);
  });

  it('finishes a durable child before the parent continuation and preserves parent-child event order', async () => {
    const conversationId = 'ordering-subflow';
    const child = flow('ordering-child-flow');
    const parent = flow('ordering-parent-flow');
    parent.nodes.push(node('subflow', 'subflow', {
      subflowId: child.id, inputMode: 'isolated', promptTemplate: 'Child boundary task.',
      outputMode: 'steps', saveConversation: true,
    }));
    parent.edges = [
      { id: 'start-to-subflow', source: 'start', target: 'subflow', data: { edgeType: 'standard' } },
      { id: 'subflow-to-process', source: 'subflow', target: 'process', data: { edgeType: 'standard' } },
    ];
    const result = await runFlow(input(conversationId, parent));
    expect(result.status).toBe('completed');
    const childRequests = observations.filter(entry => entry.operation === 'http:process' && entry.conversationId !== conversationId);
    expect(childRequests).toHaveLength(1);
    const childId = childRequests[0].conversationId;
    const childSnapshot = await loadItem<SharedState | undefined>(`conversations/${childId}` as StorageKey, undefined);
    expect(childSnapshot?.parentRunId).toBe(conversationId);
    expect(childSnapshot?.recovery?.classification).toBe('completed');
    // Subflow's custom emitter translates run events onto the parent channel;
    // the child's own committed snapshots still delimit its real dispatch.
    expectOrdered(childId, ['durable-checkpoint:node:before', 'snapshot:node:before:running',
      'archive:process', 'http:process', 'archive-outcome:completed', 'snapshot:node:after:completed']);
    const globalMilestones = observations.filter(entry =>
      entry.operation === 'step:subflow' || entry.operation === 'http:process' || entry.operation === 'event:run:done'
      || entry.operation === 'event:subflow:start' || entry.operation === 'event:subflow:done');
    expect(globalMilestones).toEqual([
      { conversationId, operation: 'step:subflow' },
      { conversationId, operation: 'event:subflow:start' },
      { conversationId: childId, operation: 'http:process' },
      { conversationId, operation: 'event:subflow:done' },
      { conversationId, operation: 'http:process' },
      { conversationId, operation: 'event:run:done' },
    ]);
  });
});
