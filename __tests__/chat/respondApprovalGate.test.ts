/**
 * The chat /respond route is the decision point for every approval card (#1284).
 *
 * The saved conversation lives in a map that stands in for the disk, so a fresh
 * read after each request is what a restarted FLUJO would see. The decision
 * logic, the live-approval registry and the conversation lock run for real;
 * only the tool itself and the model resume are replaced.
 */
import type { SharedState } from '@/backend/execution/flow/types';
import { NextRequest } from 'next/server';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn(() => null) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));

const disk = new Map<string, SharedState>();
jest.mock('@/backend/execution/flow/loadConversationState', () => ({
  loadConversationState: async (id: string) => (disk.has(id) ? structuredClone(disk.get(id)) : undefined),
}));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({
  persistConversationState: async (key: string, state: SharedState) => {
    disk.set(key.replace('conversations/', ''), structuredClone(state));
  },
}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({
  appendRawForState: jest.fn(async () => {}),
  flushConversationLog: jest.fn(async () => {}),
}));
const processToolCallsMock = jest.fn();
jest.mock('@/backend/execution/flow/handlers/ModelHandler', () => ({
  ModelHandler: {
    processToolCalls: (...args: unknown[]) => processToolCallsMock(...args),
    resolveToolUiLink: async () => undefined,
  },
}));
const processChatCompletionMock = jest.fn(async (..._args: unknown[]) => new Response('{}'));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({
  processChatCompletion: (...args: unknown[]) => processChatCompletionMock(...args),
}));
jest.mock('@/backend/services/flow/index', () => ({ flowService: { getFlow: async (id: string) => ({ id, name: 'Flow' }) } }));
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({ resumePersonaFlowDispatch: jest.fn() }));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/respond/route';
import { waitForLiveToolDecision } from '@/backend/execution/flow/toolApprovalGate';

const call = (id: string, name = 'send_email') => ({ id, type: 'function' as const, function: { name, arguments: '{"to":"a@b.c"}' } });

function saveWaiting(conversationId: string, ids: string[], requireApproval?: boolean): void {
  disk.set(conversationId, {
    conversationId,
    flowId: 'flow-1',
    status: 'awaiting_tool_approval',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [{ role: 'assistant', content: null, tool_calls: ids.map((id) => call(id)), id: 'a1', timestamp: 1 }],
    pendingToolCalls: ids.map((id) => call(id)),
    ...(requireApproval === undefined ? {} : { requireApproval }),
  } as unknown as SharedState);
}

async function respond(conversationId: string, body: unknown) {
  return POST(new NextRequest(`http://localhost/v1/chat/conversations/${conversationId}/respond`, {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ conversationId }) });
}

beforeEach(() => {
  disk.clear();
  processChatCompletionMock.mockClear();
  processToolCallsMock.mockReset().mockImplementation(async (input: { toolCalls: Array<{ id: string }> }) => ({
    success: true,
    value: { toolCallMessages: input.toolCalls.map((toolCall) => ({ role: 'tool', tool_call_id: toolCall.id, content: 'sent' })), processedToolCalls: [] },
  }));
});

it.each([
  ['missing', undefined, false],
  ['off', false, false],
  ['on', true, true],
])('resumes with the saved setting when it is %s (missing means off)', async (_label, saved, expected) => {
  saveWaiting('conv-default', ['c1'], saved);

  expect((await respond('conv-default', { action: 'approve', toolCallId: 'c1' })).status).toBe(200);

  expect(processChatCompletionMock).toHaveBeenCalledTimes(1);
  expect(processChatCompletionMock.mock.calls[0][2]).toBe(expected);
});

it('picks up a saved wait after a restart, runs each call once, and resumes only after the last decision', async () => {
  // Nothing waits in memory: this is a fresh process reading the saved conversation.
  saveWaiting('conv-restart', ['c1', 'c2'], true);

  expect((await respond('conv-restart', { action: 'approve', toolCallId: 'c1' })).status).toBe(200);
  expect(processToolCallsMock).toHaveBeenCalledTimes(1);
  expect(processChatCompletionMock).not.toHaveBeenCalled();
  expect(disk.get('conv-restart')?.pendingToolCalls?.map((pending) => pending.id)).toEqual(['c2']);

  // A repeated click (or a retried request) never runs the call again.
  expect((await respond('conv-restart', { action: 'approve', toolCallId: 'c1' })).status).toBe(404);
  expect(processToolCallsMock).toHaveBeenCalledTimes(1);

  expect((await respond('conv-restart', { action: 'reject', toolCallId: 'c2' })).status).toBe(200);
  expect(processToolCallsMock).toHaveBeenCalledTimes(1);
  expect(processChatCompletionMock).toHaveBeenCalledTimes(1);
  const results = disk.get('conv-restart')!.messages.filter((message) => message.role === 'tool');
  expect(results.map((message) => message.content)).toEqual(['sent', 'tool denied']);
});

it('answers a live wait (agent SDK or sub-flow) without running or resuming anything itself', async () => {
  saveWaiting('conv-live', [], true);
  disk.get('conv-live')!.status = 'running';
  const decision = waitForLiveToolDecision('conv-live', call('sdk-1'));

  const res = await respond('conv-live', { action: 'approve', toolCallId: 'sdk-1' });

  expect(res.status).toBe(200);
  await expect(decision).resolves.toBe(true);
  expect(processToolCallsMock).not.toHaveBeenCalled();
  expect(processChatCompletionMock).not.toHaveBeenCalled();
});

it('does not run a call whose approval was cut off by a restart', async () => {
  saveWaiting('conv-crash', ['c1'], true);
  // The first approval saved its claim, then FLUJO stopped while the tool ran.
  processToolCallsMock.mockImplementationOnce(async () => {
    throw new Error('process stopped');
  });
  expect((await respond('conv-crash', { action: 'approve', toolCallId: 'c1' })).status).toBe(500);

  expect((await respond('conv-crash', { action: 'approve', toolCallId: 'c1' })).status).toBe(200);

  expect(processToolCallsMock).toHaveBeenCalledTimes(1);
  const last = disk.get('conv-crash')!.messages.at(-1);
  expect(last).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  expect(String(last?.content)).toContain('did not run it again');
});
