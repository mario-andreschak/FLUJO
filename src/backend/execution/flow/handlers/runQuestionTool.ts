import { createLogger } from '@/utils/logger';
import { ToolDefinition } from '../types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';
import {
  registerPendingQuestion,
  QuestionSpec,
} from '@/backend/services/questionRegistry';

/**
 * The synthetic `question` tool (issue #258).
 *
 * Lets a model ask the user a structured multiple-choice question mid-run and
 * KEEP WORKING with the answer in the same node visit — instead of guessing or
 * ending the turn. Same synthetic-tool mechanism as `write_resource` /
 * `read_resource` (runResourceTools.ts): built as a deterministic
 * ToolDefinition, offered only when a Process node opts in
 * (`node_params.properties.allowQuestion`), dispatched by name in both tool
 * loops (ModelHandler.processToolCalls for the request/response path, and via
 * `localToolExecutors` for the self-orchestrating Claude-subscription adapter).
 *
 * The pause/resume uses the in-request blocking-promise pattern
 * (questionRegistry.ts), mirroring MCP elicitation: emit a
 * `run:awaiting_question` event, register a promise, and await the user's
 * answer from the `/respond` route (or the headless approvals API). The turn is
 * still live, so no state serialization / re-entry is needed.
 *
 * The description carries the opencode `question` tool's guidance verbatim so a
 * model behaves the same: don't add your own "Other" catch-all (a free-text
 * option is auto-appended when `custom` is on); put a recommended option first
 * and suffix its label with "(Recommended)".
 */

const log = createLogger('backend/flow/execution/handlers/runQuestionTool');

export const QUESTION_TOOL_NAME = 'question';

/** True for the synthetic `question` tool (dispatched here, not via mcpService). */
export function isQuestionToolName(name: string): boolean {
  return name === QUESTION_TOOL_NAME;
}

/** Label auto-appended as the free-text option when a question has `custom` on. */
export const CUSTOM_OPTION_LABEL = 'Type your own answer';

/**
 * The `question` tool definition. Deterministic (fixed name / description /
 * schema, no per-run interpolation) so, once offered, the tool set stays
 * byte-identical turn to turn (preserving the #89 provider prefix-cache).
 */
export function buildQuestionTool(): ToolDefinition {
  return {
    name: QUESTION_TOOL_NAME,
    description:
      'Ask the user one or more multiple-choice questions and wait for their answer, then CONTINUE ' +
      'working with that answer — use this instead of guessing or ending your turn when you genuinely ' +
      'need the user to decide between options. ' +
      'Provide a list of questions; each has a prompt and a list of options. ' +
      'Set `multiple: true` on a question to let the user pick more than one option (answers come back ' +
      'as a list). ' +
      '`custom` defaults to true and automatically appends a "' + CUSTOM_OPTION_LABEL + '" free-text ' +
      'option — so do NOT add your own "Other"/"Something else" catch-all option. ' +
      'If you want to recommend an option, put it FIRST and suffix its label with " (Recommended)". ' +
      'Only ask when it materially changes what you do next; keep the number of questions and options small.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'The questions to ask the user.',
          items: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'The question to ask.',
              },
              options: {
                type: 'array',
                items: { type: 'string' },
                description: 'The options the user can choose from. Do not include an "Other" option.',
              },
              multiple: {
                type: 'boolean',
                description: 'Allow selecting more than one option. Defaults to false.',
              },
              custom: {
                type: 'boolean',
                description:
                  'Auto-append a free-text "' + CUSTOM_OPTION_LABEL + '" option. Defaults to true.',
              },
            },
            required: ['prompt', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  };
}

export interface QuestionToolContext {
  /** Owning conversation — a question is scoped to it. Absent ⇒ refused. */
  conversationId?: string;
  /** The asking process node (carried on the emitted event for the live view). */
  node?: NodeRef;
  emit?: EmitFn;
  /**
   * Unattended/headless run (issue #218/#258): no interactive user is present,
   * so the tool degrades to a clear tool-error the model can proceed from
   * rather than blocking the run.
   */
  unattended?: boolean;
  /** Override the registry wait timeout (tests). */
  timeoutMs?: number;
}

export interface QuestionToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
  /**
   * True when the user explicitly declined to answer. Opencode halts the loop
   * on decline; FLUJO returns a clear tool result telling the model to stop and
   * end its turn (a genuine loop halt would need engine-seam changes — see the
   * plan's open question). Surfaced so callers can special-case if desired.
   */
  declined?: boolean;
}

/** Normalize the raw tool args into validated question specs, or return an error. */
function parseQuestions(args: Record<string, unknown>): { questions: QuestionSpec[] } | { error: string } {
  const raw = (args?.questions as unknown[]) ?? [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'question requires a non-empty "questions" array.' };
  }
  const questions: QuestionSpec[] = [];
  for (const item of raw) {
    const q = item as { prompt?: unknown; options?: unknown; multiple?: unknown; custom?: unknown };
    const prompt = typeof q.prompt === 'string' ? q.prompt.trim() : '';
    if (!prompt) return { error: 'each question requires a non-empty "prompt".' };
    const options = Array.isArray(q.options)
      ? q.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((o) => o.trim())
      : [];
    const multiple = q.multiple === true;
    // `custom` defaults to ON (matches opencode).
    const custom = q.custom !== false;
    const finalOptions = [...options];
    if (custom && !finalOptions.includes(CUSTOM_OPTION_LABEL)) {
      finalOptions.push(CUSTOM_OPTION_LABEL);
    }
    if (finalOptions.length === 0) {
      return { error: `question "${prompt}" needs at least one option.` };
    }
    questions.push({ prompt, options: finalOptions, multiple, custom });
  }
  return { questions };
}

/** Format the user's answers as prose the model can act on directly. */
export function formatAnswers(questions: QuestionSpec[], answers: string[][]): string {
  const parts = questions.map((q, i) => {
    const selected = answers[i] ?? [];
    return `"${q.prompt}" = "${selected.join(', ')}"`;
  });
  return (
    `User has answered your questions: ${parts.join('; ')}. ` +
    `You can now continue with the user's answers in mind.`
  );
}

/**
 * Execute a `question` tool call. Never throws — always resolves to an outcome
 * the caller turns into a tool-result message. Emits `run:awaiting_question`,
 * then blocks on the questionRegistry until the user answers/declines or the
 * request times out.
 */
export async function executeQuestionTool(
  args: Record<string, unknown>,
  ctx: QuestionToolContext,
): Promise<QuestionToolOutcome> {
  if (!ctx.conversationId) {
    return { success: false, error: 'The question tool is not available in this run.' };
  }
  const parsed = parseQuestions(args);
  if ('error' in parsed) {
    return { success: false, error: parsed.error };
  }
  const { questions } = parsed;

  // Headless / unattended: no interactive user — degrade to a clear tool error
  // instead of blocking the run (AC: denied/unanswered headless must not stall
  // silently).
  if (ctx.unattended) {
    log.info('question tool called in unattended run; returning a tool-error', {
      conversationId: ctx.conversationId,
    });
    return {
      success: false,
      error:
        'This is an unattended run with no user available to answer questions. ' +
        'Proceed using your best judgement without asking.',
    };
  }

  const questionId = crypto.randomUUID();
  log.info('Suspending for question', { conversationId: ctx.conversationId, questionId, count: questions.length });

  ctx.emit?.({
    type: 'run:awaiting_question',
    node: ctx.node,
    questionId,
    questions,
  });

  const result = await registerPendingQuestion(
    ctx.conversationId,
    questionId,
    questions,
    ctx.timeoutMs,
  );

  if (result.action === 'answer') {
    const prose = formatAnswers(questions, result.answers);
    log.info('question answered', { conversationId: ctx.conversationId, questionId });
    return { success: true, data: prose };
  }
  if (result.action === 'decline') {
    log.info('question declined', { conversationId: ctx.conversationId, questionId });
    return {
      success: true,
      declined: true,
      data:
        'The user declined to answer your question. Do not ask again; stop and end your turn.',
    };
  }
  // timeout
  log.warn('question timed out', { conversationId: ctx.conversationId, questionId });
  return {
    success: false,
    error: 'No answer was received in time. Proceed without the user\'s answer.',
  };
}
