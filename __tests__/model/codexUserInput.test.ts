import { answerCodexUserInput, answerCodexAsyncUserInput } from '@/backend/services/model/adapters/codexUserInput';
import { executeQuestionTool } from '@/backend/execution/flow/handlers/runQuestionTool';
import { clearPendingQuestions, listPendingQuestions, resolvePendingQuestion, declinePendingQuestion } from '@/backend/services/questionRegistry';

const questions = [{ id: 'color', header: 'Color', question: 'Which color?', isSecret: false, isOther: true,
  options: [{ label: 'Blue', description: 'A blue result' }, { label: 'Green', description: 'A green result' }] }];
const conversationId = 'native-question-contract';
afterEach(() => clearPendingQuestions(conversationId));

it('returns native question ids with structured answers through the existing executor', async () => {
  const answered = jest.fn();
  const execute = jest.fn(args => executeQuestionTool(args, { conversationId,
    emit: event => {
      if (event.type !== 'run:awaiting_question') return;
      expect(listPendingQuestions(conversationId)).toHaveLength(1);
      expect(resolvePendingQuestion(conversationId, event.questionId, [['Purple']])).toBe(true);
      answered();
    },
  }));
  expect(await answerCodexUserInput(questions, new AbortController().signal, execute))
    .toEqual({ answers: { color: { answers: ['Purple'] } } });
  expect(answered).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
});

it('retains the existing unattended policy and supplies no invented answer', async () => {
  expect(await answerCodexUserInput(questions, new AbortController().signal,
    args => executeQuestionTool(args, { conversationId, unattended: true }))).toEqual({ answers: {} });
  expect(listPendingQuestions(conversationId)).toHaveLength(0);
});

it('drains exactly its pending question when the native request resolves without an answer', async () => {
  const controller = new AbortController();
  const pending = answerCodexUserInput(questions, controller.signal,
    args => executeQuestionTool(args, { conversationId, emit: () => controller.abort() }));
  await expect(pending).rejects.toThrow();
  expect(listPendingQuestions(conversationId)).toHaveLength(0);
});

it.each([
  { raw: [] }, { raw: [{ ...questions[0], isSecret: true }] }, { raw: [{ ...questions[0], options: null, isOther: false }] },
  { raw: [questions[0], questions[0]] }, { raw: [{ ...questions[0], id: 'x'.repeat(129) }] },
])('rejects unsupported, secret or ambiguous input before the executor', async ({ raw }) => {
  const execute = jest.fn();
  await expect(answerCodexUserInput(raw, new AbortController().signal, execute)).rejects.toThrow('unsupported');
  expect(execute).not.toHaveBeenCalled();
});

it('normalizes released async questions and preserves the actual free-text answer', async () => {
  const result = await answerCodexAsyncUserInput([{ title: 'Which color?', options: ['Blue', 'Green'] }],
    new AbortController().signal, args => executeQuestionTool(args, { conversationId,
      emit: event => { if (event.type === 'run:awaiting_question') {
        expect(event.questions[0]).toMatchObject({ custom: true, options: ['Blue', 'Green', 'Type your own answer'] });
        expect(resolvePendingQuestion(conversationId, event.questionId, [['Purple']])).toBe(true);
      } },
    }));
  expect(result.action).toBe('answer');
  if (result.action === 'decline') throw new Error('Expected supplied answer.');
  expect(JSON.parse(result.text.slice(result.text.indexOf('{')))).toEqual({
    questions: [{ id: 'question_1', question: 'Which color?' }], answers: { question_1: { answers: ['Purple'] } },
  });
});

it('reports a declined or unattended asynchronous request without inventing an answer', async () => {
  const result = await answerCodexAsyncUserInput([{ title: 'Your preference?', options: null }],
    new AbortController().signal, args => executeQuestionTool(args, { conversationId, unattended: true }));
  expect(result.action).toBe('unanswered');
  if (result.action === 'decline') throw new Error('Expected unattended policy response.');
  expect(JSON.parse(result.text.slice(result.text.indexOf('{')))).toMatchObject({ answers: {}, status: expect.stringContaining('No answer') });
});

it('keeps explicit decline distinct from timeout and unattended policy', async () => {
  const result = await answerCodexAsyncUserInput([{ title: 'Your preference?', options: null }],
    new AbortController().signal, args => executeQuestionTool(args, { conversationId,
      emit: event => { if (event.type === 'run:awaiting_question') declinePendingQuestion(conversationId, event.questionId); },
    }));
  expect(result).toEqual({ action: 'decline' });
});

it.each([[], [{ title: '', options: null }], [{ title: 'Color?', options: [] }], [{ title: 'Color?', options: ['Blue', 'Blue'] }]].map(raw => ({ raw })))
('rejects an invalid async question before executing it', async ({ raw }) => {
  const execute = jest.fn();
  await expect(answerCodexAsyncUserInput(raw, new AbortController().signal, execute)).rejects.toThrow('unsupported');
  expect(execute).not.toHaveBeenCalled();
});
