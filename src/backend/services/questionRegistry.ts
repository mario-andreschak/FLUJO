import { createLogger } from '@/utils/logger';

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
  conversationId: string;
  questionId: string;
  questions: QuestionSpec[];
  createdAt: number;
  resolve: (result: QuestionResolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

const globalForRegistry = globalThis as unknown as {
  __flujoQuestionRegistry?: Map<string, PendingQuestion>;
};
const registry: Map<string, PendingQuestion> =
  globalForRegistry.__flujoQuestionRegistry ??
  (globalForRegistry.__flujoQuestionRegistry = new Map());

/** Composite key so a conversation can have at most one pending question per id. */
function keyOf(conversationId: string, questionId: string): string {
  return `${conversationId}::${questionId}`;
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
): Promise<QuestionResolution> {
  const key = keyOf(conversationId, questionId);
  return new Promise<QuestionResolution>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.has(key)) {
        log.warn(`Question ${questionId} (conv ${conversationId}) timed out after ${timeoutMs}ms`);
        registry.delete(key);
        resolve({ action: 'timeout' });
      }
    }, timeoutMs);
    registry.set(key, { conversationId, questionId, questions, createdAt: Date.now(), resolve, timer });
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
  clearTimeout(pending.timer);
  registry.delete(key);
  pending.resolve({ action: 'answer', answers });
  return true;
}

/** Decline a pending question (the user chose not to answer). */
export function declinePendingQuestion(conversationId: string, questionId: string): boolean {
  const key = keyOf(conversationId, questionId);
  const pending = registry.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  registry.delete(key);
  pending.resolve({ action: 'decline' });
  return true;
}

/** List the pending questions for one conversation (metadata + specs). */
export function listPendingQuestions(conversationId: string): Array<{
  questionId: string;
  questions: QuestionSpec[];
  createdAt: number;
}> {
  const out: Array<{ questionId: string; questions: QuestionSpec[]; createdAt: number }> = [];
  for (const p of registry.values()) {
    if (p.conversationId === conversationId) {
      out.push({ questionId: p.questionId, questions: p.questions, createdAt: p.createdAt });
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
  return Array.from(registry.values()).map((p) => ({
    conversationId: p.conversationId,
    questionId: p.questionId,
    questions: p.questions,
    createdAt: p.createdAt,
  }));
}

/** Decline + clear every pending question for a conversation (e.g. on cancel). */
export function clearPendingQuestions(conversationId: string): void {
  for (const [key, p] of registry.entries()) {
    if (p.conversationId === conversationId) {
      clearTimeout(p.timer);
      registry.delete(key);
      p.resolve({ action: 'decline' });
    }
  }
}
