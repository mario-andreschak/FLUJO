import {
  registerPendingQuestion, resolvePendingQuestion, declinePendingQuestion, clearPendingQuestions,
  listPendingQuestions, InvalidQuestionAnswerError,
} from '@/backend/services/questionRegistry';
import {
  registerPendingElicitation, resolveElicitation, resolveConversationElicitation,
  clearAllElicitations, clearPendingElicitations, listPendingElicitations, InvalidElicitationResponseError,
} from '@/backend/services/mcp/elicitationRegistry';
import { runWithWorkspace } from '@/utils/workspace';

const emit = jest.fn();
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { emitterFor: () => emit },
}));

const questions = [{ prompt: 'Choose a color', options: ['Red', 'Blue'], custom: false }];
const form = (conversationId: string) => ({ conversationId, message: 'Name and amount', requestedSchema: {
  type: 'object', properties: { name: { type: 'string', minLength: 1 }, amount: { type: 'integer', minimum: 1 } },
  required: ['name', 'amount'], additionalProperties: false,
} });

afterEach(() => {
  for (const workspace of [undefined, 'input-a', 'input-b']) runWithWorkspace(workspace, () => {
    clearPendingQuestions('input-one'); clearPendingQuestions('input-two'); clearAllElicitations();
  });
  jest.useRealTimers();
  emit.mockClear();
});

it('rejects malformed question cardinality and labels without releasing its mailbox', async () => {
  const pending = registerPendingQuestion('input-one', 'question-1', questions);
  for (const answers of [[], [[]], [['Red', 'Blue']], [['unoffered']]]) {
    expect(() => resolvePendingQuestion('input-one', 'question-1', answers)).toThrow(InvalidQuestionAnswerError);
    expect(listPendingQuestions('input-one')).toHaveLength(1);
  }
  const snapshot = listPendingQuestions('input-one');
  snapshot[0].questions[0].options[0] = 'mutated';
  expect(resolvePendingQuestion('input-two', 'question-1', [['Red']])).toBe(false);
  expect(resolvePendingQuestion('input-one', 'question-1', [['Red']])).toBe(true);
  await expect(pending).resolves.toEqual({ action: 'answer', answers: [['Red']] });
  expect(emit).toHaveBeenLastCalledWith({ type: 'run:question_resolved', questionId: 'question-1', action: 'answer' });
  expect(resolvePendingQuestion('input-one', 'question-1', [['Red']])).toBe(false);
});

it('keeps same-named workspace and conversation mailboxes isolated during Stop', async () => {
  const first = runWithWorkspace('input-a', () => registerPendingQuestion('input-one', 'same', questions));
  const second = runWithWorkspace('input-b', () => registerPendingQuestion('input-one', 'same', questions));
  const sibling = runWithWorkspace('input-a', () => registerPendingQuestion('input-two', 'same', questions));
  runWithWorkspace('input-a', () => clearPendingQuestions('input-one'));
  await expect(first).resolves.toEqual({ action: 'decline' });
  expect(runWithWorkspace('input-a', () => listPendingQuestions('input-two'))).toHaveLength(1);
  expect(runWithWorkspace('input-b', () => listPendingQuestions('input-one'))).toHaveLength(1);
  runWithWorkspace('input-b', () => declinePendingQuestion('input-one', 'same'));
  runWithWorkspace('input-a', () => declinePendingQuestion('input-two', 'same'));
  await Promise.all([second, sibling]);
});

it('refuses duplicate questions and bounds prompt storage without replacing the owner', async () => {
  const pending = registerPendingQuestion('input-one', 'unique', questions);
  expect(() => registerPendingQuestion('input-one', 'unique', questions)).toThrow(/duplicate/);
  expect(() => registerPendingQuestion('input-one', 'huge', [{ prompt: 'x'.repeat(40_000), options: ['x'] }])).toThrow(/limits/);
  declinePendingQuestion('input-one', 'unique'); await pending;
});

it('validates the captured schema and cannot resolve another conversation or unbound authorization', async () => {
  const metadata = form('input-one');
  const pending = registerPendingElicitation('form-1', undefined, metadata);
  metadata.requestedSchema.required = [];
  const snapshot = listPendingElicitations('input-one');
  snapshot[0].requestedSchema.required = [];
  expect(resolveConversationElicitation('input-two', 'form-1', { action: 'accept', content: { name: 'A', amount: 2 } })).toBe(false);
  expect(resolveElicitation('form-1', { action: 'accept', content: { name: 'A', amount: 2 } })).toBe(false);
  expect(() => resolveConversationElicitation('input-one', 'form-1', { action: 'accept', content: { name: 'A' } })).toThrow(InvalidElicitationResponseError);
  expect(() => resolveConversationElicitation('input-one', 'form-1', { action: 'accept', content: { name: 'A', amount: 0 } })).toThrow(InvalidElicitationResponseError);
  expect(listPendingElicitations('input-one')).toHaveLength(1);
  expect(resolveConversationElicitation('input-one', 'form-1', { action: 'accept', content: { name: 'A', amount: 2 } })).toBe(true);
  await expect(pending).resolves.toEqual({ action: 'accept', content: { name: 'A', amount: 2 } });
  expect(emit).toHaveBeenLastCalledWith({ type: 'run:elicitation_resolved', elicitationId: 'form-1', action: 'accept' });
});

it('Stop releases only its bound form and retains sibling and unbound authorization mailboxes', async () => {
  const own = registerPendingElicitation('same', undefined, form('input-one'));
  const sibling = registerPendingElicitation('same', undefined, form('input-two'));
  const authorization = registerPendingElicitation('same');
  clearPendingElicitations('input-one');
  await expect(own).resolves.toEqual({ action: 'cancel' });
  expect(listPendingElicitations('input-two')).toHaveLength(1);
  expect(resolveConversationElicitation('input-one', 'same', { action: 'cancel' })).toBe(false);
  expect(resolveElicitation('same', { action: 'accept' })).toBe(true);
  await expect(authorization).resolves.toEqual({ action: 'accept' });
  clearPendingElicitations('input-two'); await sibling;
});

it('times out exact mailboxes and refuses late answers while newer prompts survive', async () => {
  jest.useFakeTimers();
  const oldQuestion = registerPendingQuestion('input-one', 'old-question', questions, 10);
  const currentQuestion = registerPendingQuestion('input-one', 'current-question', questions, 100);
  const oldForm = registerPendingElicitation('old-form', 10, form('input-one'));
  const currentForm = registerPendingElicitation('current-form', 100, form('input-one'));
  jest.advanceTimersByTime(11);
  await expect(oldQuestion).resolves.toEqual({ action: 'timeout' });
  await expect(oldForm).resolves.toEqual({ action: 'cancel' });
  expect(resolvePendingQuestion('input-one', 'old-question', [['Red']])).toBe(false);
  expect(resolveConversationElicitation('input-one', 'old-form', { action: 'cancel' })).toBe(false);
  expect(listPendingQuestions('input-one').map(input => input.questionId)).toEqual(['current-question']);
  expect(listPendingElicitations('input-one').map(input => input.elicitationId)).toEqual(['current-form']);
  clearPendingQuestions('input-one'); clearPendingElicitations('input-one');
  await Promise.all([currentQuestion, currentForm]);
});
