/**
 * "Require tool approvals" while runs go on (#1284): the saved setting of a
 * conversation decides when a run's request says nothing, a change saved during
 * a run applies from its next batch of tool calls without waiting for the run to
 * end, and a call a sub-flow waits on shows in the approval inbox, which can
 * answer it.
 *
 * Real runs: runFlow, the nodes, the OpenAI adapter, storage, the conversation
 * PATCH route and the approval inbox routes run for real against a loopback
 * provider. Only the MCP layer is replaced; its callTool is what must not fire
 * before a decision.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn(() => null) }));
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
import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { encodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { approvalSettingNow } from '@/backend/execution/flow/approvalSetting';
import { registerCancellableRun } from '@/backend/execution/flow/cancellationCoordinator';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { PATCH as patchConversation } from '@/app/v1/chat/conversations/[conversationId]/route';
import { GET as listApprovals } from '@/app/api/approvals/route';
import { POST as decideApproval } from '@/app/api/approvals/[id]/route';

jest.setTimeout(30_000);

const READ_TOOL = encodeToolName('srv', 'read_it');
const WRITE_TOOL = encodeToolName('srv', 'write_it');

function node(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label: id, type, properties } } as FlowNode;
}

function flowFor(id: string): Flow {
  return {
    id,
    name: id,
    nodes: [
      node('start', 'start'),
      node('process', 'process', { boundModel: 'approval-model', promptTemplate: 'Work.' }),
      node('tools', 'mcp', { boundServer: 'srv', enabledTools: ['read_it', 'write_it'] }),
    ],
    edges: [
      { id: 'to-process', source: 'start', target: 'process', data: { edgeType: 'standard' } },
      { id: 'to-tools', source: 'process', target: 'tools', data: { edgeType: 'mcp' } },
    ],
  } as unknown as Flow;
}

async function patchApproval(conversationId: string, requireApproval: boolean): Promise<Response> {
  return patchConversation(new NextRequest(`http://localhost/v1/chat/conversations/${conversationId}`, {
    method: 'PATCH', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ requireApproval }),
  }), { params: Promise.resolve({ conversationId }) });
}

async function savedState(conversationId: string): Promise<SharedState | undefined> {
  return loadItem<SharedState | undefined>(`conversations/${conversationId}` as StorageKey, undefined);
}

describe('real runs', () => {
  let server: Server;
  type WireMessage = { role: string; tool_call_id?: string; tool_calls?: unknown[]; content?: unknown };
  let requests: Array<{ messages?: WireMessage[] }> = [];
  /** The tool calls the provider asks for after each user message, one batch per model turn; then it answers in words. */
  let rounds: string[][] = [];
  /** Runs before the provider answers turn `index` (0-based, counted from the last user message), as a person acting meanwhile. */
  let beforeTurn: (index: number) => Promise<void> = async () => {};

  /** How many tool batches the model already asked for since the last user message. */
  function turnOf(body: { messages?: WireMessage[] }): number {
    const messages = body.messages ?? [];
    const lastUser = messages.map((message) => message.role).lastIndexOf('user');
    return messages.slice(lastUser + 1).filter((message) => message.role === 'assistant' && message.tool_calls?.length).length;
  }

  function answer(response: ServerResponse, body: Record<string, unknown>, index: number) {
    const calls = rounds[index];
    const toolCalls = calls?.map((name, callIndex) => ({ id: `call_${index}_${callIndex}`, index: callIndex, type: 'function', function: { name, arguments: '{}' } }));
    const message = { role: 'assistant', content: toolCalls ? null : 'all done', refusal: null, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
    const finishReason = toolCalls ? 'tool_calls' : 'stop';
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
        const index = turnOf(body);
        requests.push(body);
        void beforeTurn(index).then(() => answer(response, body, index), (error) => {
          response.writeHead(500).end(String(error));
        });
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
    rounds = [[READ_TOOL]];
    beforeTurn = async () => {};
    callToolMock.mockReset().mockResolvedValue({ success: true, data: { content: [{ type: 'text', text: 'done' }] } });
    FlowExecutor.clearFlowCache();
    jest.spyOn(ToolHandler, 'processMCPNodes').mockImplementation(async (input) => {
      const tool = (name: string) => ({
        name: encodeToolName('srv', name),
        originalName: name,
        server: 'srv',
        nodeId: input.mcpNodes?.[0]?.id,
        description: name,
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false },
      });
      return { success: true, value: { availableTools: [tool('read_it'), tool('write_it')] } };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    FlowExecutor.conversationStates.clear();
  });

  const run = (conversationId: string, extra: Record<string, unknown> = {}) => runFlow({
    conversationId,
    flowDefinition: flowFor(conversationId),
    prompt: 'Please work.',
    source: 'chat',
    mode: 'conversation',
    flujo: true,
    userTurn: true,
    ...extra,
  });
  const calledTools = () => callToolMock.mock.calls.filter((call) => call[0] === 'srv').map((call) => call[1]);
  /** The person rejects what waits, and the run goes on, as the chat card's Reject does. */
  const rejectAndResume = async (conversationId: string) => {
    const state = FlowExecutor.conversationStates.get(conversationId)!;
    for (const call of [...(state.pendingToolCalls ?? [])]) await applyApprovalDecision(state, call.id, 'reject');
    return runFlow({ conversationId, source: 'chat', mode: 'conversation', flujo: true });
  };

  describe('the saved setting decides when a request says nothing (R2)', () => {
    it('keeps asking in a conversation whose box is ticked, until a request turns it off', async () => {
      const conversationId = 'saved-setting';
      expect((await run(conversationId, { requireApproval: true })).status).toBe('awaiting_tool_approval');
      expect((await savedState(conversationId))?.requireApproval).toBe(true);
      // The resume after the decision says nothing either and keeps the setting.
      expect((await rejectAndResume(conversationId)).status).toBe('completed');
      expect((await savedState(conversationId))?.requireApproval).toBe(true);
      expect(calledTools()).toEqual([]);

      // A later message that does not mention the setting, as an API caller sends
      // it: it still asks, and the saved box stays ticked.
      const again = await run(conversationId);
      expect(again.status).toBe('awaiting_tool_approval');
      expect(calledTools()).toEqual([]);
      expect((await savedState(conversationId))?.requireApproval).toBe(true);
      await rejectAndResume(conversationId);

      // An explicit "off" is a choice: it is saved and the tool runs unasked.
      const off = await run(conversationId, { requireApproval: false });
      expect(off.status).toBe('completed');
      expect(calledTools()).toEqual(['read_it']);
      expect((await savedState(conversationId))?.requireApproval).toBe(false);

      // Saying nothing now keeps "off".
      expect((await run(conversationId)).status).toBe('completed');
      expect(calledTools()).toEqual(['read_it', 'read_it']);
    });

    it('starts a new conversation with approval off when nothing is said', async () => {
      expect((await run('saved-setting-new')).status).toBe('completed');
      expect((await savedState('saved-setting-new'))?.requireApproval).toBe(false);
    });
  });

  describe('a change saved during a run applies from its next batch (R8)', () => {
    it('ticking the box while the agent works holds the next batch, and the save does not wait for the run', async () => {
      const conversationId = 'tick-mid-run';
      rounds = [[READ_TOOL], [WRITE_TOOL]];
      let patched: Response | undefined;
      beforeTurn = async (index) => {
        // After the first tool ran, the person ticks the box. The run still holds the conversation.
        if (index === 1) patched = await patchApproval(conversationId, true);
      };

      const result = await run(conversationId, { requireApproval: false });

      expect(patched?.status).toBe(200);
      expect(await patched!.json()).toMatchObject({ id: conversationId, status: 'running' });
      expect(calledTools()).toEqual(['read_it']);
      expect(result.status).toBe('awaiting_tool_approval');
      expect(result.pendingToolCalls?.map((call) => call.function.name)).toEqual([WRITE_TOOL]);
      expect((await savedState(conversationId))?.requireApproval).toBe(true);
    });

    it('unticking the box while a sub-flow waits keeps the card, and later calls run unasked', async () => {
      const viewed = 'untick-viewed';
      rounds = [[READ_TOOL], [WRITE_TOOL]];
      // The conversation on screen: its run holds the conversation while the sub-flow works.
      const parent = { conversationId: viewed, flowId: 'parent', title: 'Parent', status: 'running', requireApproval: true,
        messages: [], createdAt: 1, updatedAt: 1 } as unknown as SharedState;
      await saveItem(`conversations/${viewed}` as StorageKey, parent);
      FlowExecutor.conversationStates.set(viewed, parent);
      let releaseParent!: () => void;
      const registration = await registerCancellableRun({ conversationId: viewed });
      const parentHold = withConversationExecutionLock(viewed, () => new Promise<void>((resolve) => { releaseParent = resolve; }))
        .finally(() => registration.release());
      try {
        const child = run('untick-child', { mode: 'ephemeral', source: 'subflow', userTurn: false, requireApproval: true, approvalConversationId: viewed });
        for (let attempt = 0; attempt < 500 && listPendingToolCalls(viewed).length === 0; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(listPendingToolCalls(viewed).map((call) => call.function.name)).toEqual([READ_TOOL]);

        const unticked = await patchApproval(viewed, false);
        expect(unticked.status).toBe(200);
        expect((await savedState(viewed))?.requireApproval).toBe(false);
        expect(approvalSettingNow(viewed, true)).toBe(false);
        // The call already on the card still waits for its decision.
        expect(listPendingToolCalls(viewed).map((call) => call.function.name)).toEqual([READ_TOOL]);
        expect(calledTools()).toEqual([]);

        // Answered from the approval inbox, where the wait is listed without its arguments.
        const listed = await (await listApprovals(new Request('http://localhost/api/approvals'))).json();
        const entry = listed.approvals.find((approval: { conversationId: string }) => approval.conversationId === viewed);
        expect(entry).toMatchObject({ live: true, pendingToolCalls: [{ id: 'call_0_0', name: READ_TOOL }] });
        expect(entry.approvalId).toMatch(/^apr_/);
        expect(Date.parse(entry.expiresAt)).toBeGreaterThan(Date.now());
        expect(JSON.stringify(entry)).not.toContain('arguments');
        const decide = () => decideApproval(new NextRequest(`http://localhost/api/approvals/${entry.approvalId}`, {
          method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
        }), { params: Promise.resolve({ id: entry.approvalId }) });
        const approved = await decide();
        expect(approved.status).toBe(200);
        expect(await approved.json()).toMatchObject({ status: 'running', conversationId: viewed, live: true });

        const result = await child;
        expect(result.status).toBe('completed');
        // The second batch came after the box was unticked: it ran without a card.
        expect(calledTools()).toEqual(['read_it', 'write_it']);
        // The receipt named one call; replaying it decides nothing.
        expect((await decide()).status).toBe(404);
      } finally {
        releaseParent?.();
        await parentHold;
      }
    });
  });
});
