import { observeQuestionResolution } from '@/backend/execution/flow/handlers/runQuestionTool';
import type { QuestionResolution } from '@/backend/services/questionRegistry';
import { CodexAppServerRequestError } from './codexAppServerProcess';
import { codexRecord } from './codexProtocol';

/** Translate only the released question shape; execution still uses the flow's
 * existing question executor, including unattended policy and approval/fences. */
async function resolveCodexUserInput(raw: unknown, signal: AbortSignal,
  execute: (args: Record<string, unknown>) => Promise<unknown>) {
  const invalid = () => new CodexAppServerRequestError(-32602, 'Codex requested unsupported user input.');
  const text = (value: unknown, max: number) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
    return value;
  };
  if (!Array.isArray(raw) || !raw.length || raw.length > 3 || Buffer.byteLength(JSON.stringify(raw)) > 48 * 1024) throw invalid();
  const ids = new Set<string>();
  const questions = raw.map(value => {
    const question = codexRecord(value);
    const questionId = text(question.id, 128);
    if (ids.has(questionId) || question.isSecret === true
      || typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean') throw invalid();
    ids.add(questionId);
    const options = question.options === null ? [] : question.options;
    if (!Array.isArray(options) || options.length > 12) throw invalid();
    const labels = options.map(option => text(codexRecord(option).label, 512));
    if (new Set(labels).size !== labels.length || (!labels.length && !question.isOther)) throw invalid();
    return { id: questionId, prompt: `${text(question.header, 256)}: ${text(question.question, 4096)}`,
      options: labels, custom: question.isOther, multiple: false };
  });
  signal.throwIfAborted();
  const captured: { resolution?: QuestionResolution } = {};
  const args = observeQuestionResolution({ questions: questions.map(question => ({ prompt: question.prompt,
    options: question.options, custom: question.custom, multiple: question.multiple })) },
    result => { captured.resolution = result; }, signal);
  await execute(args);
  signal.throwIfAborted();
  // A declined, expired, unattended or rejected request has no supplied answer.
  const answers: Record<string, { answers: string[] }> = Object.create(null);
  if (captured.resolution?.action === 'answer') {
    for (const [index, question] of questions.entries()) answers[question.id] = { answers: captured.resolution.answers[index] ?? [] };
  }
  return { answers, resolution: captured.resolution };
}

export async function answerCodexUserInput(raw: unknown, signal: AbortSignal,
  execute: (args: Record<string, unknown>) => Promise<unknown>) {
  const result = await resolveCodexUserInput(raw, signal, execute);
  return { answers: result.answers };
}

export type CodexAsyncUserInputResult = { action: 'decline' } | { action: 'answer' | 'unanswered'; text: string };

/** Current models publish asynchronous questions as an agent-message item.
 * The answer is new user input after a confirmed terminal, never a replay. */
export async function answerCodexAsyncUserInput(raw: unknown, signal: AbortSignal,
  execute: (args: Record<string, unknown>) => Promise<unknown>): Promise<CodexAsyncUserInputResult> {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3 || Buffer.byteLength(JSON.stringify(raw)) > 48 * 1024) {
    throw new CodexAppServerRequestError(-32602, 'Codex requested unsupported user input.');
  }
  const questions = raw.map((value, index) => {
    const question = codexRecord(value);
    if (question.options !== null && (!Array.isArray(question.options) || !question.options.length)) {
      throw new CodexAppServerRequestError(-32602, 'Codex requested unsupported user input.');
    }
    return { id: `question_${index + 1}`, header: 'Question', question: question.title,
      options: question.options === null ? null : question.options.map(label => ({ label })),
      // The released async shape always permits a free-text answer.
      isOther: true, isSecret: false };
  });
  const result = await resolveCodexUserInput(questions, signal, execute);
  if (result.resolution?.action === 'decline') return { action: 'decline' };
  const answered = result.resolution?.action === 'answer';
  return { action: answered ? 'answer' : 'unanswered', text: 'User response to the preceding Codex question: ' + JSON.stringify({
    questions: questions.map(question => ({ id: question.id, question: question.question })),
    answers: result.answers,
    ...(answered ? {} : { status: result.resolution?.action === 'timeout'
      ? 'The question expired without an answer. Proceed without inventing one.'
      : 'No answer was supplied under the flow question policy. Do not infer an answer.' }),
  }) };
}
