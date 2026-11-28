/**
 * One way to answer a Human step (#1095), shared by the answer API, the chat answer
 * route, the approval inbox and MCP Tasks.
 *
 * The answer always goes to the run that asked, even when a person sees the step in a
 * parent that waits for its sub-flow. An ordinary run saves the answer and replies at
 * once; the caller then lets the run go on in the background. A Persona's run only
 * changes through its dispatcher, so its answer is checked, then recorded and used
 * there with fresh authority before this replies.
 */
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import { bindToCurrentWorkspace } from '@/utils/workspace';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { decideHumanTask, findDelegatedHumanTask, type HumanTaskReceipt } from '@/backend/execution/flow/humanTask';
import type { HumanTaskDecision, SharedState } from '@/backend/execution/flow/types';
import { isAcceptingOutcome, type HumanAnswer } from '@/utils/shared/humanStep';
import { continueHumanTask, type HumanTaskContinuation } from './continueHumanTask';
import { getHumanTaskEntry, syncHumanTaskEntry, updateHumanTaskEntry } from './humanTaskIndex';

const log = createLogger('backend/services/humanTasks/answerHumanTask');

/** Sub-flows nest at most this deep when FLUJO looks for the run that asked. */
const MAX_CHAIN = 16;

export interface HumanTaskAnswerInput {
  requestId: string;
  accept: boolean;
  answer: HumanAnswer;
  channel: HumanTaskDecision['channel'];
  /** Where the caller saw the step. Used when the step list has no entry for it. */
  conversationId?: string;
  /** Whether the request comes from this computer itself. A Persona's step needs that. */
  fromThisComputer: boolean;
}

export type HumanTaskAnswerResult =
  | {
    kind: 'saved';
    /** The run that asked and now holds the answer. */
    conversationId: string;
    receipt: HumanTaskReceipt;
    /** The same answer arrived before; this is its first receipt. */
    repeat: boolean;
    /** `decided`: saved, the run goes on next. `applied`: the run already used it. */
    status: 'decided' | 'applied';
    /** Set when the answer was used before this returned (a Persona's run). */
    continued?: HumanTaskContinuation;
  }
  | { kind: 'refused'; status: 403 | 404 | 409 | 410 | 422; error: string; fieldErrors?: Record<string, string>; code?: string };

const notLocal = (): HumanTaskAnswerResult => ({
  kind: 'refused', status: 403, error: 'Forbidden: this endpoint only accepts local requests.',
});
const notWaiting = (requestId: string): HumanTaskAnswerResult => ({
  kind: 'refused', status: 404, error: `No Human step "${requestId}" is waiting for an answer.`,
});

function ownsRequest(state: SharedState, requestId: string): boolean {
  return state.humanTask?.requestId === requestId
    || !!state.humanTaskLog?.some((record) => record.requestId === requestId);
}

/**
 * The conversation that asked this step: the step list says, or the caller's hint,
 * followed down through sub-flow parents that only show a child's step.
 */
export async function findHumanTaskOwner(requestId: string, hint?: string): Promise<string | undefined> {
  let conversationId = (await getHumanTaskEntry(requestId))?.conversationId ?? hint;
  for (let depth = 0; conversationId && depth < MAX_CHAIN; depth += 1) {
    const state = await loadConversationState(conversationId).catch(() => undefined);
    if (!state || ownsRequest(state, requestId)) return conversationId;
    const delegated = findDelegatedHumanTask(state, { requestId });
    if (!delegated) return conversationId;
    conversationId = delegated.conversationId;
  }
  return conversationId;
}

function appliedRepeat(state: SharedState, conversationId: string, input: HumanTaskAnswerInput): HumanTaskAnswerResult | undefined {
  const applied = state.humanTaskLog?.find((record) => record.requestId === input.requestId);
  if (!applied) return undefined;
  // The step already used its answer. A client that lost the reply gets the receipt
  // back when it asks for the same thing; a different answer is too late.
  return isAcceptingOutcome(applied.outcome) === input.accept
    ? {
      kind: 'saved', conversationId, repeat: true, status: 'applied',
      receipt: { requestId: input.requestId, decisionId: applied.decisionId, outcome: applied.outcome, decidedAt: applied.decidedAt },
    }
    : { kind: 'refused', status: 409, error: 'This step already has a different answer.' };
}

function guard(state: SharedState, input: HumanTaskAnswerInput): HumanTaskAnswerResult | undefined {
  if (isPersonaOwnedConversationState(state) && !input.fromThisComputer) return notLocal();
  if (state.personaArchived) return { kind: 'refused', status: 409, error: 'An anonymized Persona archive is read-only.' };
  if (isPersonaOwnedConversationState(state) && !state.personaAttribution) {
    return { kind: 'refused', status: 409, error: 'Persona conversation attribution is incomplete; refusing an unfenced answer.' };
  }
  return undefined;
}

/** A Persona's step: checked, then recorded and used by its dispatcher with fresh authority. */
async function answerThroughDispatcher(conversationId: string, input: HumanTaskAnswerInput): Promise<HumanTaskAnswerResult> {
  let continued: HumanTaskContinuation;
  try {
    continued = await continueHumanTask(conversationId, {
      requestId: input.requestId,
      answer: { accept: input.accept, answer: input.answer, channel: input.channel },
    });
  } catch (error) {
    log.warn('A Persona did not take a Human step answer', { conversationId, requestId: input.requestId, error });
    return {
      kind: 'refused', status: 409, code: 'persona_unavailable',
      error: `The Persona cannot take this answer right now: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (continued.status === 'refused') {
    const { status, error, fieldErrors } = continued.refusal;
    return { kind: 'refused', status, error, ...(fieldErrors ? { fieldErrors } : {}) };
  }
  if (continued.status === 'blocked') return { kind: 'refused', status: 409, error: continued.reason };
  const state = await loadConversationState(conversationId).catch(() => undefined);
  if (continued.status === 'idle' || continued.status === 'busy') {
    return (state && appliedRepeat(state, conversationId, input)) ?? notWaiting(input.requestId);
  }
  if (!continued.receipt) return { kind: 'refused', status: 409, error: 'The Persona did not take the answer. Try again.' };
  return {
    kind: 'saved', conversationId, receipt: continued.receipt, repeat: false,
    status: state?.humanTask?.requestId === input.requestId ? 'decided' : 'applied', continued,
  };
}

/**
 * Check and save an answer. An accepting answer needs the digest of what the person
 * saw; typed answers must fit; the first decision wins (the same answer again returns
 * its receipt, a different one is refused); after the deadline the answer is refused.
 */
export async function answerHumanTask(input: HumanTaskAnswerInput): Promise<HumanTaskAnswerResult> {
  const conversationId = await findHumanTaskOwner(input.requestId, input.conversationId);
  if (!conversationId) return { kind: 'refused', status: 404, error: `No Human step "${input.requestId}".` };
  const preview = await loadConversationState(conversationId);
  if (!preview) {
    return input.fromThisComputer ? notWaiting(input.requestId) : notLocal();
  }
  const refusedEarly = guard(preview, input);
  if (refusedEarly) return refusedEarly;
  if (isPersonaOwnedConversationState(preview)) return answerThroughDispatcher(conversationId, input);

  return withConversationExecutionLock(conversationId, async (): Promise<HumanTaskAnswerResult> => {
    const state = await loadConversationState(conversationId);
    if (!state) return notWaiting(input.requestId);
    const refused = guard(state, input);
    if (refused) return refused;
    const result = decideHumanTask(state, {
      requestId: input.requestId, accept: input.accept, answer: input.answer, channel: input.channel,
    });
    if (result.kind === 'refused') {
      if (result.status === 404) return appliedRepeat(state, conversationId, input) ?? notWaiting(input.requestId);
      return { kind: 'refused', status: result.status, error: result.error, ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) };
    }
    if (result.kind === 'recorded') {
      FlowExecutor.conversationStates.set(conversationId, state);
      await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
      await syncHumanTaskEntry(() => updateHumanTaskEntry(input.requestId, {
        status: 'decided', outcome: result.receipt.outcome, decisionId: result.receipt.decisionId, decidedAt: result.receipt.decidedAt,
      }), 'decided');
    }
    return { kind: 'saved', conversationId, receipt: result.receipt, repeat: result.kind === 'repeat', status: 'decided' };
  });
}

/**
 * Let the run use a saved answer, without making the caller wait for the run. A
 * failure here is harmless: the answer is saved and the minute sweep picks it up.
 */
export function continueAnsweredHumanTask(result: Extract<HumanTaskAnswerResult, { kind: 'saved' }>): void {
  if (result.continued || result.status === 'applied') return;
  const run = bindToCurrentWorkspace(async () => {
    try {
      const continued = await continueHumanTask(result.conversationId, { requestId: result.receipt.requestId });
      log.info('Continued after a Human step answer', { requestId: result.receipt.requestId, status: continued.status });
    } catch (error) {
      log.warn('Could not continue after a Human step answer; the sweep tries again', { requestId: result.receipt.requestId, error });
    }
  });
  void run();
}
