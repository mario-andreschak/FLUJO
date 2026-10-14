import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import type { EmitFn, NodeRef } from '@/shared/types/execution/events';

const log = createLogger('backend/services/questionRegistry');

/**
 * In-memory registry of model-initiated `question` tool calls awaiting a user
 * answer (issue #258).
 *
 * The `question` synthetic tool lets a model ask the user a structured
 * multiple-choice question mid-run and KEEP WORKING with the answer in the same
 * node visit. Rather than the heavier disk-serialized approval pause/resume,
 * this uses the in-request blocking-promise pattern (mirroring
 * `mcp/elicitationRegistry.ts` and `toolApprovalRegistry.ts`): the tool
 * executor suspends the live turn by registering a promise here, emits a
 * `run:awaiting_question` SSE event, and awaits. The interactive `/respond`
 * route (or the headless approvals API) resolves or declines it, unblocking the
 * still-open request so the tool result flows back into the same tool loop.
 *
 * Module-level singleton kept on globalThis so it survives Next.js dev
 * hot-reloads, exactly like the elicitation registry and the ExecutionEventBus.
 */

const QUESTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_PENDING_PER_CONVERSATION = 8;
const MAX_PENDING_PROCESS = 128;
const MAX_PROMPT_BYTES = 32 * 1024;

/** One prompt the model asked, plus its offered options. */
export interface QuestionSpec {
  /** The question text shown to the user. */
  prompt: string;
  /** The offered options (already including any auto-appended custom option). */
  options: string[];
  /** Whether more than one option may be selected. */
  multiple?: boolean;
  /** Whether a free-text "Type your own answer" option is offered. */
  custom?: boolean;
}

/** How a pending question was resolved. */
export type QuestionResolution =
  | { action: 'answer'; answers: string[][] }
  | { action: 'decline' }
  | { action: 'timeout' };

interface PendingQuestion {
  workspace: string;
  conversationId: string;
  questionId: string;
  questions: QuestionSpec[];
  createdAt: number;
  node?: NodeRef;
  emit?: EmitFn;
  resolve: (result: QuestionResolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class InvalidQuestionAnswerError extends Error {
  constructor() { super('Answers must match the pending questions and their selection rules.'); }
}

/** Only the captured mailbox may settle; an older timer cannot clear a replacement. */
function settle(key: string, pending: PendingQuestion, result: QuestionResolution): boolean {
  if (registry.get(key) !== pending) return false;
  clearTimeout(pending.timer);
  registry.delete(key);
  pending.emit?.({ type: 'run:question_resolved', questionId: pending.questionId, action: result.action });
  pending.resolve(result);
  return true;
}

function cloneQuestions(questions: QuestionSpec[]): QuestionSpec[] {
  return questions.map(question => ({ ...question, options: [...question.options] }));
}

const globalForRegistry = globalThis as unknown as {
  __flujoQuestionRegistry?: Map<string, PendingQuestion>;
};
const registry: Map<string, PendingQuestion> =
  globalForRegistry.__flujoQuestionRegistry ??
  (globalForRegistry.__flujoQuestionRegistry = new Map());

/** Composite key so a conversation can have at most one pending question per id. */
function keyOf(conversationId: string, questionId: string): string {
  return workspaceCacheKey(conversationId, questionId);
}

export function hasPendingQuestion(conversationId: string, questionId: string): boolean {
  return registry.has(keyOf(conversationId, questionId));
}

/**
 * Register a pending question and return a promise that resolves when the user
 * answers, declines, or the request times out (default 5 minutes — prevents a
 * blocked turn from leaking forever if no one ever answers).
 */
export function registerPendingQuestion(
  conversationId: string,
  questionId: string,
  questions: QuestionSpec[],
  timeoutMs: number = QUESTION_TIMEOUT_MS,
  metadata: { node?: NodeRef } = {},
): Promise<QuestionResolution> {
  const key = keyOf(conversationId, questionId);
  if (registry.has(key) || registry.size >= MAX_PENDING_PROCESS
    || listPendingQuestions(conversationId).length >= MAX_PENDING_PER_CONVERSATION) {
    throw new Error('Too many pending questions or duplicate question ID.');
  }
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 16
    || questions.some(question => typeof question.prompt !== 'string' || !question.prompt.trim()
      || !Array.isArray(question.options) || question.options.length < 1 || question.options.length > 32
      || question.options.some(option => typeof option !== 'string' || !option.trim()))
    || Buffer.byteLength(JSON.stringify({ questions, node: metadata.node })) > MAX_PROMPT_BYTES) {
    throw new Error('Question prompt exceeds the supported input limits.');
  }
  const workspace = getCurrentWorkspace();
  const emit = executionEventBus.emitterFor(conversationId);
  return new Promise<QuestionResolution>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.get(key) === pending) {
        log.warn(`Question ${questionId} (conv ${conversationId}) timed out after ${timeoutMs}ms`);
        settle(key, pending, { action: 'timeout' });
      }
    }, timeoutMs);
    const pending: PendingQuestion = {
      workspace,
      conversationId,
      questionId,
      questions: cloneQuestions(questions),
      createdAt: Date.now(),
      ...(metadata.node ? { node: { ...metadata.node } } : {}),
      emit,
      resolve,
      timer,
    };
    registry.set(key, pending);
  });
}

/**
 * Answer a pending question. `answers` is one array of selected labels per
 * question, aligned to the questions' order (free-text answers arrive as their
 * own labels). Returns true when a matching pending question existed.
 */
export function resolvePendingQuestion(
  conversationId: string,
  questionId: string,
  answers: string[][],
): boolean {
  const key = keyOf(conversationId, questionId);
  const pending = registry.get(key);
  if (!pending) return false;
  if (!Array.isArray(answers) || answers.length !== pending.questions.length
    || answers.some((selected, index) => !Array.isArray(selected) || selected.length < 1
      || selected.length > (pending.questions[index].multiple ? 32 : 1)
      || new Set(selected).size !== selected.length
      || selected.some(answer => typeof answer !== 'string' || !answer.trim() || answer.length > 8192
        || (pending.questions[index].custom === false && !pending.questions[index].options.includes(answer))))
    || Buffer.byteLength(JSON.stringify(answers)) > MAX_PROMPT_BYTES) {
    throw new InvalidQuestionAnswerError();
  }
  return settle(key, pending, { action: 'answer', answers: answers.map(selected => [...selected]) });
}

/** Decline a pending question (the user chose not to answer). */
export function declinePendingQuestion(conversationId: string, questionId: string): boolean {
  const key = keyOf(conversationId, questionId);
  const pending = registry.get(key);
  if (!pending) return false;
  return settle(key, pending, { action: 'decline' });
}

/** List the pending questions for one conversation (metadata + specs). */
export function listPendingQuestions(conversationId: string): Array<{
  questionId: string;
  questions: QuestionSpec[];
  createdAt: number;
  node?: NodeRef;
}> {
  const out: Array<{ questionId: string; questions: QuestionSpec[]; createdAt: number; node?: NodeRef }> = [];
  for (const p of registry.values()) {
    if (p.workspace === getCurrentWorkspace() && p.conversationId === conversationId) {
      out.push({ questionId: p.questionId, questions: cloneQuestions(p.questions), createdAt: p.createdAt,
        ...(p.node ? { node: { ...p.node } } : {}) });
    }
  }
  return out;
}

/** List every pending question across all conversations (for the headless inbox). */
export function listAllPendingQuestions(): Array<{
  conversationId: string;
  questionId: string;
  questions: QuestionSpec[];
  createdAt: number;
}> {
  const workspace = getCurrentWorkspace();
  return Array.from(registry.values()).filter((p) => p.workspace === workspace).map((p) => ({
    conversationId: p.conversationId,
    questionId: p.questionId,
    questions: cloneQuestions(p.questions),
    createdAt: p.createdAt,
  }));
}

/** Decline + clear every pending question for a conversation (e.g. on cancel). */
export function clearPendingQuestions(conversationId: string): void {
  const workspace = getCurrentWorkspace();
  for (const [key, p] of registry.entries()) {
    if (p.workspace === workspace && p.conversationId === conversationId) {
      settle(key, p, { action: 'decline' });
    }
  }
}
