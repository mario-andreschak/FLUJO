import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { StorageKey } from '@/shared/types/storage';
import { FlujoChatMessage } from '@/shared/types/chat';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';
import {
  getPendingApproval,
  putPendingApproval,
  removePendingApproval,
} from '@/backend/services/scheduler/pendingApprovals';
import { updateRunRecord } from '@/backend/services/scheduler/runHistory';
import { resolvePendingQuestion, declinePendingQuestion } from '@/backend/services/questionRegistry';
import type { SharedState } from '@/backend/execution/flow/types';

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
  /** Issue #246: when true, save an "always" rule so future calls to the same
   *  tool are auto-resolved without user intervention. */
  always?: boolean;
  /** Issue #247: optional rejection feedback carried back to the model. */
  feedback?: string;
}

function pendingToolCallsMeta(state: SharedState): Array<{ id: string; name: string }> {
  return (state.pendingToolCalls ?? []).map(tc => ({
    id: tc.id,
    name: tc.type === 'function' ? tc.function.name : String(tc.type),
  }));
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
 * approvalId (== the paused run's conversationId). Body:
 *   { "action": "approve" | "deny", "toolCallId"?: "<id>" }
 * When `toolCallId` is omitted every pending tool call is resolved with the
 * same action. `deny` maps to the existing reject semantics.
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
  } catch (error) {
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
  log.info('Resolving approval', { requestId, approvalId: id, action: body.action, toolCallId: body.toolCallId });

  try {
    const entry = await getPendingApproval(id);
    if (!entry) {
      return json({ error: `No pending approval with id "${id}"` }, 404);
    }

    const storageKey = `conversations/${entry.conversationId}` as StorageKey;
    const state = await loadConversationState(entry.conversationId);
    if (!state || state.status !== 'awaiting_tool_approval' || !state.pendingToolCalls) {
      // Already resolved (or the conversation is gone): idempotent no-op.
      await removePendingApproval(id).catch(() => { /* best-effort */ });
      return json({ error: 'This approval is no longer awaiting a decision' }, 404);
    }

    // Which pending tool call(s) to resolve.
    const targetIds = body.toolCallId
      ? [body.toolCallId]
      : state.pendingToolCalls.map(tc => tc.id);

    const appendedMessages: FlujoChatMessage[] = [];
    for (const toolCallId of targetIds) {
      const decision = await applyApprovalDecision(state, toolCallId, mappedAction, body.always, body.feedback);
      if (decision.outcome === 'tool_not_found') {
        if (body.toolCallId) {
          return json({ error: `Pending tool call with ID ${toolCallId} not found` }, 404);
        }
        continue; // snapshot drift — skip
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
      await putPendingApproval({ ...entry, pendingToolCalls: remaining });
      return json({
        status: 'awaiting_tool_approval',
        approvalId: id,
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
      state.requireApproval ?? true,
      false, // flujodebug
      entry.conversationId
    );

    // Determine the terminal outcome and reconcile the run-history record.
    const finalState = await loadConversationState(entry.conversationId);

    if (finalState?.status === 'awaiting_tool_approval') {
      // The resumed run paused again on a later tool: keep it in the inbox.
      const remaining = pendingToolCallsMeta(finalState);
      await putPendingApproval({ ...entry, pendingToolCalls: remaining });
      return json({
        status: 'awaiting_tool_approval',
        approvalId: id,
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
    await removePendingApproval(id);

    return json({
      status: finalStatus,
      approvalId: id,
      conversationId: entry.conversationId,
    });
  } catch (error) {
    log.error('Error resolving approval', {
      requestId,
      approvalId: id,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    });
    return json({ error: 'Internal server error resolving approval' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
