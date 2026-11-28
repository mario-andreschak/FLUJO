import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { StorageKey } from '@/shared/types/storage';
import { FlujoChatMessage } from '@/shared/types/chat';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { applyApprovalDecision, refusedHumanStepAnswer } from '@/backend/execution/flow/resumeAfterApproval';
import type { HumanAnswer } from '@/utils/shared/humanStep';
import { findDelegatedHumanTask } from '@/backend/execution/flow/humanTask';
import { answerHumanTask, continueAnsweredHumanTask } from '@/backend/services/humanTasks/answerHumanTask';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';
import {
  approvalReceiptOf,
  findPendingApprovalByReceipt,
  putPendingApproval,
  removePendingApproval,
  type PendingApprovalEntry,
} from '@/backend/services/scheduler/pendingApprovals';
import { updateRunRecord } from '@/backend/services/scheduler/runHistory';
import { resolvePendingQuestion, declinePendingQuestion } from '@/backend/services/questionRegistry';
import type { SharedState } from '@/backend/execution/flow/types';
import {
  getPersonaFlowDispatch,
  resumePersonaFlowDispatch,
} from '@/backend/services/enduringAgents/personaDispatcher';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getSchedulerService } from '@/backend/services/scheduler';
import { requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';
import { findLiveApproval, resolvePendingApproval, type LiveApprovalListing } from '@/backend/execution/flow/toolApprovalRegistry';

const log = createLogger('app/api/approvals/[id]/route');

/** Final assistant output is truncated to this many chars in run history. */
const MAX_STORED_OUTPUT_CHARS = 4096;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ApprovalActionBody {
  action: 'approve' | 'deny' | 'question-answer' | 'question-decline';
  /** Issue #258: the pending question to answer/decline (question-* actions). */
  questionId?: string;
  /** Issue #258: one array of selected labels per question, in order. */
  answers?: string[][];
  /** Optional: resolve one specific pending tool call. Omit to resolve all. */
  toolCallId?: string;
  /** A Human step's answer: the digest the person saw and the typed or changed value (#1095). */
  human?: HumanAnswer;
}

function pendingToolCallsMeta(state: SharedState): Array<{ id: string; name: string }> {
  return (state.pendingToolCalls ?? []).map(tc => ({
    id: tc.id,
    name: tc.type === 'function' ? tc.function.name : String(tc.type),
  }));
}

/**
 * The calls of the receipt's batch that still wait. Empty when the receipt is
 * for a batch that was already decided, so an old receipt can never decide a
 * later batch (#1284).
 */
function waitingCallsOfBatch(entry: PendingApprovalEntry, state: SharedState): string[] {
  const batch = new Set(entry.pendingToolCalls.map((call) => call.id));
  return (state.pendingToolCalls ?? []).filter((call) => batch.has(call.id)).map((call) => call.id);
}

/**
 * Answer a call a running agent SDK or sub-flow waits on (a live wait, #1284).
 * The run is still going and does the rest; this only hands it the decision,
 * exactly like the chat card's /respond. The receipt names one call and stops
 * working once it is answered.
 */
async function answerLiveApproval(
  request: NextRequest,
  approvalId: string,
  live: LiveApprovalListing,
  toolCallId: string | undefined,
  action: 'approve' | 'reject',
): Promise<Response> {
  if (toolCallId && toolCallId !== live.toolCall.id) {
    return json({ error: `Pending tool call with ID ${toolCallId} not found` }, 404);
  }
  const state = FlowExecutor.conversationStates.get(live.conversationId) ?? await loadConversationState(live.conversationId);
  if (!state || isPersonaOwnedConversationState(state)) {
    const notLoopback = assertLocalRequest(request, { strictLoopback: true });
    if (notLoopback) return notLoopback;
  }
  if (state?.personaArchived) return json({ error: 'An anonymized Persona archive is read-only.' }, 409);
  if (isPersonaOwnedConversationState(state) && !state?.personaAttribution) {
    return json({ error: 'Persona conversation attribution is incomplete; refusing an unfenced approval.' }, 409);
  }
  if (!resolvePendingApproval(live.conversationId, live.toolCall.id, action === 'approve')) {
    return json({ error: 'This approval is no longer awaiting a decision' }, 404);
  }
  log.info('Answered a live approval from the inbox', { approvalId, conversationId: live.conversationId, action });
  return json({ status: 'running', approvalId, conversationId: live.conversationId, live: true });
}

function deriveOutputText(state: SharedState | undefined): string | undefined {
  if (!state) return undefined;
  const last = state.messages[state.messages.length - 1];
  const text =
    last && last.role === 'assistant' && typeof last.content === 'string' ? last.content : undefined;
  if (!text) return undefined;
  return text.length > MAX_STORED_OUTPUT_CHARS
    ? `${text.slice(0, MAX_STORED_OUTPUT_CHARS)}…`
    : text;
}

/**
 * POST /api/approvals/:id  (issue #115)
 *
 * Resolve a paused HEADLESS run from the approval inbox. `:id` is the
 * approvalId that GET /api/approvals lists: an opaque receipt for one batch of
 * waiting tool calls (entries saved before #1284 use the conversationId).
 * Body:
 *   { "action": "approve" | "deny", "toolCallId"?: "<id>" }
 * When `toolCallId` is omitted every call of that batch that still waits is
 * resolved with the same action; calls the run makes after it continues are
 * never included. `deny` maps to the existing reject semantics. A receipt
 * stops working once its batch is decided; a later batch has a new one.
 * A live wait (`live: true` in the listing) names one call of a running agent
 * or sub-flow; answering it hands the run the decision and returns at once.
 *
 * The tool decision is applied via the SAME helper the interactive chat
 * `/respond` route uses (applyApprovalDecision), then the run is resumed via
 * processChatCompletion — so a resumed scheduled run behaves exactly like a
 * resumed chat run. On completion the earlier `needs_approval` run-history
 * record is reconciled to its final outcome and the inbox entry cleared.
 *
 * Idempotent: a run that is no longer awaiting approval (already resolved, or
 * deleted) returns 404 rather than resolving twice.
 *
 * Gated behind the same unlock check as the rest of the API — these endpoints
 * resume real, side-effecting tool execution, so callers must be trusted.
 */
async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { id } = await params;
  const requestId = `approval-${Date.now()}`;

  let body: ApprovalActionBody;
  try {
    body = await request.json();
    const valid = ['approve', 'deny', 'question-answer', 'question-decline'];
    if (!body || !valid.includes(body.action)) {
      throw new Error('Invalid request body. Required: action ("approve", "deny", "question-answer" or "question-decline").');
    }
    if (body.human !== undefined && (!body.human || typeof body.human !== 'object' || Array.isArray(body.human))) {
      throw new Error('human must be an object with the digest and the answer.');
    }
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    return json(
      { error: 'Invalid request body', details: error instanceof Error ? error.message : 'Unknown error' },
      400
    );
  }

  // Model-initiated question (issue #258). `:id` is the conversationId. The run
  // is still live and BLOCKED inside the question tool executor via the
  // in-request blocking-promise (questionRegistry) — resolving/declining it
  // unblocks the turn so the tool result flows back into the same tool loop.
  // No disk-serialized approval entry or processChatCompletion re-entry needed.
  if (body.action === 'question-answer' || body.action === 'question-decline') {
    if (!body.questionId) {
      return json({ error: 'questionId is required for question actions' }, 400);
    }
    const questionState = FlowExecutor.conversationStates.get(id)
      ?? await loadConversationState(id);
    if (!questionState || isPersonaOwnedConversationState(questionState)) {
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    if (isPersonaOwnedConversationState(questionState) && !questionState?.personaAttribution) {
      return json({ error: 'Persona conversation attribution is incomplete; refusing an unfenced response.' }, 409);
    }
    const resolved = body.action === 'question-answer'
      ? resolvePendingQuestion(id, body.questionId, body.answers ?? [])
      : declinePendingQuestion(id, body.questionId);
    if (!resolved) {
      return json({ error: `No pending question "${body.questionId}" for conversation "${id}"` }, 404);
    }
    log.info('Resolved headless question', { requestId, conversationId: id, questionId: body.questionId, action: body.action });
    return json({ status: 'running', conversationId: id, questionId: body.questionId }, 200);
  }

  const mappedAction: 'approve' | 'reject' = body.action === 'approve' ? 'approve' : 'reject';
  const humanContext = { answer: body.human, channel: 'approvals' as const };
  log.info('Resolving approval', { requestId, approvalId: id, action: body.action, toolCallId: body.toolCallId });

  try {
    const candidateEntry = await findPendingApprovalByReceipt(id);
    if (!candidateEntry) {
      const live = findLiveApproval(id);
      if (live) return await answerLiveApproval(request, id, live, body.toolCallId, mappedAction);
      return json({ error: `No pending approval with id "${id}"` }, 404);
    }

    return await withConversationExecutionLock(candidateEntry.conversationId, async () => {
    // Re-read both receipt and conversation under the conversation lease. A
    // pre-lock snapshot must never authorize legacy tool execution after the
    // Persona deletion workflow has anonymized the durable state.
    const entry = await findPendingApprovalByReceipt(id);
    if (!entry || entry.conversationId !== candidateEntry.conversationId) {
      return json({ error: `No pending approval with id "${id}"` }, 404);
    }

    const storageKey = `conversations/${entry.conversationId}` as StorageKey;
    const state = await loadConversationState(entry.conversationId);
    if (!state || isPersonaOwnedConversationState(state)) {
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    if (state?.personaArchived) {
      return json({ error: 'An anonymized Persona archive is read-only.' }, 409);
    }
    if (isPersonaOwnedConversationState(state) && !state?.personaAttribution) {
      return json({ error: 'Persona conversation attribution is incomplete; refusing an unfenced approval.' }, 409);
    }
    if (entry.resumeDispatchId) {
      const resumedDispatch = await getPersonaFlowDispatch(entry.resumeDispatchId);
      if (
        resumedDispatch
        && (
          resumedDispatch.state === 'queued'
          || resumedDispatch.state === 'running'
          || (
            resumedDispatch.state === 'waiting'
            && resumedDispatch.waitingReason !== 'approval'
          )
        )
      ) {
        return json({
          status: resumedDispatch.state,
          approvalId: id,
          conversationId: entry.conversationId,
          dispatchId: resumedDispatch.id,
        }, 202);
      }
    }
    if (!state || state.status !== 'awaiting_tool_approval' || !state.pendingToolCalls) {
      if (state?.personaAttribution && state.status !== 'awaiting_tool_approval') {
        const { personaId, activityId, behaviorRevisionId } = state.personaAttribution;
        const terminalState = state.status === 'completed'
          || state.status === 'error'
          || state.status === 'capped';
        if (terminalState && activityId && behaviorRevisionId) {
          const finalStatus: 'completed' | 'error' =
            state.status === 'completed' ? 'completed' : 'error';
          await getSchedulerService().completeApprovedPersonaRun({
            executionId: entry.plannedExecutionId,
            runId: entry.runId,
            status: finalStatus,
            finishedAt: new Date().toISOString(),
            outputText: deriveOutputText(state),
            usage: state.usage,
            error: finalStatus === 'completed'
              ? undefined
              : `Run ended with status "${state.status}" after approval`,
            conversationId: entry.conversationId,
            firedAt: entry.createdAt,
            triggerSummary: entry.triggerSummary,
            personaAttribution: { personaId, activityId, behaviorRevisionId },
            terminalPublication: entry.terminalPublication,
          });
          await removePendingApproval(entry.approvalId);
          return json({
            status: finalStatus,
            approvalId: id,
            conversationId: entry.conversationId,
            recovered: true,
          });
        }
        // A prior approve request may have durably resumed the Persona dispatch
        // and returned 202. Retrying while its state is still running/debug
        // waiting is an acknowledgement, not a terminal error or stale prune.
        if (!terminalState) {
          return json({
            status: state.status ?? 'running',
            approvalId: id,
            conversationId: entry.conversationId,
          }, 202);
        }
      } else if (!state && entry.terminalPublication) {
        // The Persona approval receipt is recovery state. Keep it until the
        // dispatcher/projection recreates a readable state or an explicit
        // deletion tombstone makes terminalization a no-op.
        return json({
          status: 'recovering',
          approvalId: id,
          conversationId: entry.conversationId,
        }, 202);
      }
      // Already resolved (or the conversation is gone): idempotent no-op.
      await removePendingApproval(entry.approvalId).catch(() => { /* best-effort */ });
      return json({ error: 'This approval is no longer awaiting a decision' }, 404);
    }

    // Which pending tool call(s) to resolve: only calls of the receipt's batch,
    // captured here under the conversation lock.
    const waiting = waitingCallsOfBatch(entry, state);
    if (waiting.length === 0) {
      // The receipt is for a batch that was already decided, for example in the
      // chat. Point the inbox at the batch that waits now, under a new receipt.
      await putPendingApproval({ ...entry, pendingToolCalls: pendingToolCallsMeta(state) });
      return json({ error: 'This approval is no longer awaiting a decision' }, 404);
    }
    if (body.toolCallId && !waiting.includes(body.toolCallId)) {
      return json({ error: `Pending tool call with ID ${body.toolCallId} not found` }, 404);
    }
    const targetIds = body.toolCallId ? [body.toolCallId] : waiting;

    // Human steps of sub-flows this run only shows: answer each where it was asked.
    const delegated = targetIds.map((toolCallId) => findDelegatedHumanTask(state, { toolCallId }));
    if (delegated.some(Boolean)) {
      if (!delegated.every(Boolean) || (mappedAction === 'approve' && delegated.length > 1)) {
        return json({ error: 'Answer each sub-flow step on its own: send its toolCallId.' }, 400);
      }
      const receipts = [];
      for (const task of delegated) {
        const answered = await answerHumanTask({
          requestId: task!.requestId, accept: mappedAction === 'approve', answer: body.human ?? {}, channel: 'approvals',
          conversationId: task!.conversationId, fromThisComputer: assertLocalRequest(request, { strictLoopback: true }) === null,
        });
        if (answered.kind === 'refused') return json({ error: answered.error, fieldErrors: answered.fieldErrors }, answered.status);
        continueAnsweredHumanTask(answered);
        receipts.push(answered.receipt);
      }
      return json({ status: 'decided', approvalId: id, conversationId: entry.conversationId, receipts }, 202);
    }

    if (state.personaAttribution) {
      const { personaId, activityId, behaviorRevisionId } = state.personaAttribution;
      if (!activityId || !behaviorRevisionId) {
        return json({
          error: 'Persona conversation attribution is incomplete; refusing an unfenced approval resume.',
        }, 409);
      }
      for (const toolCallId of targetIds) {
        const refused = refusedHumanStepAnswer(state, toolCallId, mappedAction, humanContext);
        if (refused) return json({ error: refused.error, fieldErrors: refused.fieldErrors }, refused.status);
      }
      const dispatch = await resumePersonaFlowDispatch({
        personaId,
        activityId,
        behaviorRevisionId,
        conversationId: entry.conversationId,
        reason: 'approval',
        flowInputPatch: {
          messages: state.messages,
          requireApproval: requireApprovalOf(state.requireApproval),
          debug: state.debugMode ?? false,
          continueDebug: false,
          userTurn: false,
        },
        prepare: async ({ installExecutionAuthority }) => {
          installExecutionAuthority(state);
          const appendedMessages: FlujoChatMessage[] = [];
          for (const toolCallId of targetIds) {
            const decision = await applyApprovalDecision(
              state,
              toolCallId,
              mappedAction,
              humanContext,
            );
            if (decision.outcome === 'tool_not_found') {
              if (body.toolCallId) {
                throw new Error(`Pending tool call with ID ${toolCallId} disappeared during resume.`);
              }
              continue;
            }
            if (decision.outcome === 'human_refused') throw new Error(decision.error);
            appendedMessages.push(...decision.appendedMessages);
            if (decision.outcome === 'ready') break;
          }
          FlowExecutor.conversationStates.set(entry.conversationId, state);
          await persistConversationState(storageKey, state);
          await appendRawForState(
            state,
            appendedMessages.map((message) => ({ type: 'message', message })),
          );
          return state.status === 'awaiting_tool_approval' ? 'yield' : 'resume';
        },
      });
      const resumedEntry = {
        ...entry,
        resumeDispatchId: dispatch.id,
        resumeRequestedAt: new Date().toISOString(),
      };
      // This receipt closes the crash gap between a durable resume and terminal
      // scheduler projection. GET/retry can now consult the exact dispatch.
      await putPendingApproval(resumedEntry);

      if (dispatch.state === 'queued' || dispatch.state === 'running') {
        return json({
          status: dispatch.state,
          approvalId: id,
          conversationId: entry.conversationId,
          dispatchId: dispatch.id,
        }, 202);
      }
      const finalState = await loadConversationState(entry.conversationId);
      if (finalState?.status === 'awaiting_tool_approval') {
        const remaining = pendingToolCallsMeta(finalState);
        const saved = await putPendingApproval({ ...resumedEntry, pendingToolCalls: remaining });
        return json({
          status: 'awaiting_tool_approval',
          approvalId: approvalReceiptOf(saved),
          conversationId: entry.conversationId,
          pendingToolCalls: remaining,
          dispatchId: dispatch.id,
        });
      }
      if (
        dispatch.state !== 'completed'
        && dispatch.state !== 'error'
        && dispatch.state !== 'cancelled'
      ) {
        return json({
          status: dispatch.state,
          approvalId: id,
          conversationId: entry.conversationId,
          dispatchId: dispatch.id,
        }, 202);
      }
      const finalStatus: 'completed' | 'error' =
        finalState?.status === 'completed' && dispatch.state === 'completed'
          ? 'completed'
          : 'error';
      const outputText = deriveOutputText(finalState);
      await getSchedulerService().completeApprovedPersonaRun({
        executionId: entry.plannedExecutionId,
        runId: entry.runId,
        status: finalStatus,
        finishedAt: new Date().toISOString(),
        outputText,
        usage: finalState?.usage,
        conversationId: entry.conversationId,
        firedAt: entry.createdAt,
        triggerSummary: entry.triggerSummary,
        personaAttribution: {
          personaId,
          activityId,
          behaviorRevisionId,
        },
        error: finalStatus === 'completed'
          ? undefined
          : dispatch.error?.message
            ?? `Run ended with status "${finalState?.status ?? dispatch.state}" after approval`,
        terminalPublication: entry.terminalPublication,
      });
      await removePendingApproval(entry.approvalId);
      return json({
        status: finalStatus,
        approvalId: id,
        conversationId: entry.conversationId,
        dispatchId: dispatch.id,
      });
    }

    for (const toolCallId of targetIds) {
      // Check every Human step answer first, so a refusal leaves the whole batch untouched.
      const refused = refusedHumanStepAnswer(state, toolCallId, mappedAction, humanContext);
      if (refused) return json({ error: refused.error, fieldErrors: refused.fieldErrors }, refused.status);
    }
    const appendedMessages: FlujoChatMessage[] = [];
    for (const toolCallId of targetIds) {
      const decision = await applyApprovalDecision(state, toolCallId, mappedAction, humanContext);
      if (decision.outcome === 'tool_not_found') {
        if (body.toolCallId) {
          return json({ error: `Pending tool call with ID ${toolCallId} not found` }, 404);
        }
        continue; // snapshot drift — skip
      }
      if (decision.outcome === 'human_refused') {
        return json({ error: decision.error, fieldErrors: decision.fieldErrors }, decision.status);
      }
      appendedMessages.push(...decision.appendedMessages);
      if (decision.outcome === 'ready') {
        break; // batch drained
      }
    }

    // Persist the mutation and fold appended messages into the log.
    FlowExecutor.conversationStates.set(entry.conversationId, state);
    await persistConversationState(storageKey, state);
    await appendRawForState(state, appendedMessages.map(m => ({ type: 'message', message: m })));

    // Still awaiting (a specific toolCallId was resolved but others remain).
    if (state.status === 'awaiting_tool_approval') {
      const remaining = pendingToolCallsMeta(state);
      const saved = await putPendingApproval({ ...entry, pendingToolCalls: remaining });
      return json({
        status: 'awaiting_tool_approval',
        approvalId: approvalReceiptOf(saved),
        conversationId: entry.conversationId,
        pendingToolCalls: remaining,
      });
    }

    // Batch drained → resume the run (identical mechanism to chat /respond).
    const flow = await flowService.getFlow(state.flowId);
    if (!flow) {
      log.error(`Flow not found for resume`, { requestId, flowId: state.flowId });
      return json({ error: `Flow definition not found for ID ${state.flowId}` }, 500);
    }
    const simulatedRequestData: ChatCompletionRequest = {
      model: `flow-${flow.name}`,
      messages: state.messages,
    };
    log.info('Resuming paused headless run after approval', { requestId, conversationId: entry.conversationId });
    await processChatCompletion(
      simulatedRequestData,
      true, // flujo
      requireApprovalOf(state.requireApproval),
      false, // flujodebug
      entry.conversationId
    );

    // Determine the terminal outcome and reconcile the run-history record.
    const finalState = await loadConversationState(entry.conversationId);

    if (finalState?.status === 'awaiting_tool_approval') {
      // The resumed run paused again on a later tool: keep it in the inbox,
      // under a new receipt for the new batch.
      const remaining = pendingToolCallsMeta(finalState);
      const saved = await putPendingApproval({ ...entry, pendingToolCalls: remaining });
      return json({
        status: 'awaiting_tool_approval',
        approvalId: approvalReceiptOf(saved),
        conversationId: entry.conversationId,
        pendingToolCalls: remaining,
      });
    }

    const finalStatus: 'completed' | 'error' =
      finalState?.status === 'completed' ? 'completed' : 'error';
    const outputText = deriveOutputText(finalState);
    await updateRunRecord(entry.plannedExecutionId, entry.runId, {
      status: finalStatus,
      finishedAt: new Date().toISOString(),
      outputText,
      usage: finalState?.usage,
      error:
        finalStatus === 'completed'
          ? undefined
          : `Run ended with status "${finalState?.status ?? 'unknown'}" after approval`,
      pendingApproval: undefined,
    });
    await removePendingApproval(entry.approvalId);

    return json({
      status: finalStatus,
      approvalId: id,
      conversationId: entry.conversationId,
    });
    });
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    log.error('Error resolving approval', {
      requestId,
      approvalId: id,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return json({ error: 'Internal server error resolving approval' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
