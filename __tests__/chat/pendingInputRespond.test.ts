import type { SharedState } from '@/backend/execution/flow/types';
import { NextRequest } from 'next/server';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => undefined) }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn(() => null) }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: new Map() } }));
const loadConversationState = jest.fn(async (conversationId: string) => ({ conversationId, status: 'running', messages: [] } as unknown as SharedState));
jest.mock('@/backend/execution/flow/loadConversationState', () => ({ loadConversationState: (id: string) => loadConversationState(id) }));
jest.mock('@/backend/execution/flow/toolApprovalRegistry', () => ({ resolvePendingApproval: jest.fn(() => false), listPendingToolCalls: jest.fn(() => []) }));
jest.mock('@/backend/execution/flow/toolCancelRegistry', () => ({ cancelToolCall: jest.fn(() => false) }));
jest.mock('@/backend/execution/flow/resumeAfterApproval', () => ({ applyApprovalDecision: jest.fn() }));
jest.mock('@/backend/execution/flow/persistConversationState', () => ({ persistConversationState: jest.fn() }));
jest.mock('@/app/v1/chat/completions/chatCompletionService', () => ({ processChatCompletion: jest.fn() }));
jest.mock('@/backend/services/flow/index', () => ({ flowService: { getFlow: jest.fn() } }));
jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({ resumePersonaFlowDispatch: jest.fn() }));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: { emitterFor: () => jest.fn() } }));

import { POST } from '@/app/v1/chat/conversations/[conversationId]/respond/route';
import { registerPendingQuestion, clearPendingQuestions, listPendingQuestions } from '@/backend/services/questionRegistry';
import { registerPendingElicitation, clearAllElicitations, listPendingElicitations, resolveElicitation } from '@/backend/services/mcp/elicitationRegistry';

async function respond(conversationId: string, body: unknown) {
  return POST(new NextRequest(`http://localhost/v1/chat/conversations/${conversationId}/respond`, {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ conversationId }) });
}
afterEach(() => { clearPendingQuestions('input-one'); clearAllElicitations(); });

it.each(['completed', 'error', 'capped'] as const)('rejects orphaned inputs from a %s run without releasing its server', async (status) => {
  const question = registerPendingQuestion('input-one', 'orphan-question', [{ prompt: 'Pick', options: ['A'], custom: false }]);
  const form = registerPendingElicitation('orphan-form', undefined, {
    conversationId: 'input-one', message: 'Pick', requestedSchema: { type: 'object', properties: {} },
  });
  try {
    const terminal = { conversationId: 'input-one', status, messages: [] } as unknown as SharedState;
    for (const body of [
      { action: 'question-answer', questionId: 'orphan-question', answers: [['A']] },
      { action: 'question-decline', questionId: 'orphan-question' },
      { action: 'elicitation-submit', elicitationId: 'orphan-form', content: {} },
      { action: 'elicitation-cancel', elicitationId: 'orphan-form' },
    ]) {
      loadConversationState.mockResolvedValueOnce(terminal);
      expect((await respond('input-one', body)).status).toBe(404);
    }
    expect(listPendingQuestions('input-one')).toHaveLength(1);
    expect(listPendingElicitations('input-one')).toHaveLength(1);
  } finally {
    clearPendingQuestions('input-one'); clearAllElicitations();
    await Promise.all([question, form]);
  }
});

it('validates the action-specific input ID even when an unrelated valid ID is supplied', async () => {
  expect((await respond('input-one', { action: 'question-answer', questionId: 7,
    toolCallId: 'unrelated', answers: [['A']] })).status).toBe(400);
  expect((await respond('input-one', { action: 'elicitation-cancel', elicitationId: {},
    toolCallId: 'unrelated' })).status).toBe(400);
});

it('returns 400 for invalid answers without clearing the request, then rejects the stale answer after completion', async () => {
  const pending = registerPendingQuestion('input-one', 'question-1', [{ prompt: 'Pick', options: ['A'], custom: false }]);
  expect((await respond('input-one', { action: 'question-answer', questionId: 'question-1', answers: [['A', 'B']] })).status).toBe(400);
  expect(listPendingQuestions('input-one')).toHaveLength(1);
  expect((await respond('input-two', { action: 'question-answer', questionId: 'question-1', answers: [['A']] })).status).toBe(404);
  expect((await respond('input-one', { action: 'question-answer', questionId: 'question-1', answers: [['A']] })).status).toBe(200);
  await expect(pending).resolves.toEqual({ action: 'answer', answers: [['A']] });
  expect((await respond('input-one', { action: 'question-answer', questionId: 'question-1', answers: [['A']] })).status).toBe(404);
});

it('checks schema and conversation ownership before releasing an elicitation or unbound authorization', async () => {
  const pending = registerPendingElicitation('form-1', undefined, { conversationId: 'input-one', message: 'Amount', requestedSchema: {
    type: 'object', properties: { amount: { type: 'integer', minimum: 1 } }, required: ['amount'],
  } });
  expect((await respond('input-one', { action: 'elicitation-submit', elicitationId: 'form-1', content: { amount: 0 } })).status).toBe(400);
  expect(listPendingElicitations('input-one')).toHaveLength(1);
  expect((await respond('input-two', { action: 'elicitation-cancel', elicitationId: 'form-1' })).status).toBe(404);
  expect((await respond('input-one', { action: 'elicitation-submit', elicitationId: 'form-1', content: { amount: 3 } })).status).toBe(200);
  await expect(pending).resolves.toEqual({ action: 'accept', content: { amount: 3 } });
  const authorization = registerPendingElicitation('authorization');
  expect((await respond('input-one', { action: 'elicitation-cancel', elicitationId: 'authorization' })).status).toBe(404);
  expect(resolveElicitation('authorization', { action: 'accept' })).toBe(true);
  await authorization;
});
