import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { resolvePendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { cancelToolCall } from '@/backend/execution/flow/toolCancelRegistry';
import { resolveElicitation } from '@/backend/services/mcp/elicitationRegistry';
import { resolvePendingQuestion, declinePendingQuestion } from '@/backend/services/questionRegistry';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';
import { FlujoChatMessage } from '@/shared/types/chat';
import OpenAI from 'openai';
import {
  resumePersonaFlowDispatch,
  type PersonaFlowDispatchRecord,
} from '@/backend/services/enduringAgents/personaDispatcher';

const log = createLogger('app/v1/chat/conversations/[conversationId]/respond/route');

async function personaResumeResponse(
  dispatch: PersonaFlowDispatchRecord,
  conversationId: string,
) {
  const state = await loadConversationState(conversationId);
  if (dispatch.state === 'error' || dispatch.state === 'cancelled') {
    return NextResponse.json({
      error: dispatch.error?.message ?? (dispatch.state === 'cancelled'
        ? 'Persona execution was cancelled.'
        : 'Persona execution failed.'),
      code: dispatch.error?.code ?? `persona_dispatch_${dispatch.state}`,
      dispatch_id: dispatch.id,
    }, { status: dispatch.state === 'cancelled' ? 409 : 500 });
  }
  if (state?.status === 'paused_debug') {
    return NextResponse.json({
      status: 'paused_debug',
      conversation_id: conversationId,
      debugState: state,
      dispatch_id: dispatch.id,
    });
  }
  return NextResponse.json({
    status: state?.status ?? dispatch.outcome?.status ?? dispatch.state,
    conversation_id: conversationId,
    pendingToolCalls: state?.pendingToolCalls,
    messages: state?.messages,
    updatedAt: state?.updatedAt,
    dispatch_id: dispatch.id,
  }, { status: dispatch.state === 'queued' || dispatch.state === 'running' ? 202 : 200 });
}

type RespondRequestBody =
  | { action: 'approve' | 'reject'; toolCallId: string; always?: boolean; feedback?: string }
  | { action: 'elicitation-submit'; elicitationId: string; content: Record<string, string | number | boolean | string[]> }
  | { action: 'elicitation-cancel'; elicitationId: string }
  | { action: 'question-answer'; questionId: string; answers: string[][] }
  | { action: 'question-decline'; questionId: string }
  | { action: 'cancelToolCall'; toolCallId: string };

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;
  // Defense-in-depth localhost / DNS-rebinding guard (#143): approving a pending
  // tool call executes a local command (RCE-equivalent), so this is the
  // highest-value cross-origin target under /v1/chat/conversations.
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  const requestId = `conv-respond-${Date.now()}`;
  log.info('Handling POST request for conversation response (Approve/Reject)', { requestId, conversationId });

  if (!conversationId) {
    log.warn('Missing conversationId parameter', { requestId });
    return NextResponse.json({ error: 'Missing conversationId parameter' }, { status: 400 });
  }

  let requestBody: RespondRequestBody;
  try {
    requestBody = await request.json();
    const validActions = ['approve', 'reject', 'elicitation-submit', 'elicitation-cancel', 'question-answer', 'question-decline', 'cancelToolCall'];
    if (!requestBody.action || !validActions.includes(requestBody.action)) {
      throw new Error(`Invalid request body. action must be one of: ${validActions.join(', ')}`);
    }
    if ((requestBody.action === 'approve' || requestBody.action === 'reject' || requestBody.action === 'cancelToolCall') && !requestBody.toolCallId) {
      throw new Error('toolCallId is required for approve/reject/cancelToolCall actions');
    }
    if ((requestBody.action === 'elicitation-submit' || requestBody.action === 'elicitation-cancel') && !requestBody.elicitationId) {
      throw new Error('elicitationId is required for elicitation actions');
    }
    if ((requestBody.action === 'question-answer' || requestBody.action === 'question-decline') && !requestBody.questionId) {
      throw new Error('questionId is required for question actions');
    }
  } catch (error) {
    log.warn('Invalid request body', { requestId, error: error instanceof Error ? error.message : error });
    return NextResponse.json({ error: 'Invalid request body', details: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }

  // Resolve the owning state before touching any process-local control
  // registry. Question/elicitation/approval resolution and tool cancellation
  // can steer a live Persona Activity even though they do not write the
  // snapshot themselves, so the trusted boundary must precede those effects.
  const responseState = await loadConversationState(conversationId);
  if (isPersonaOwnedConversationState(responseState)) {
    const notLoopback = assertLocalRequest(request);
    if (notLoopback) return notLoopback;
  }
  if (responseState?.personaArchived) {
    return NextResponse.json(
      { error: 'An anonymized Persona archive is read-only.' },
      { status: 409 },
    );
  }
  if (isPersonaOwnedConversationState(responseState) && !responseState?.personaAttribution) {
    return NextResponse.json({
      error: 'Persona conversation attribution is incomplete; refusing an unfenced response.',
    }, { status: 409 });
  }

  // --- Cancel ONE in-flight tool call (issue #357) ---
  // Aborts just that call's MCP request; the run stays alive and continues with
  // a cancelled tool result, so the transcript stays well-formed. Already
  // finished calls are a race-safe 200 no-op.
  if (requestBody.action === 'cancelToolCall') {
    const cancelled = cancelToolCall(conversationId, requestBody.toolCallId);
    log.info('Cancel single tool call requested', { requestId, conversationId, toolCallId: requestBody.toolCallId, cancelled });
    return NextResponse.json({ cancelled, conversation_id: conversationId });
  }

  // --- Elicitation submit/cancel (in-request path: run is live, blocked in the handler) ---
  if (requestBody.action === 'elicitation-submit' || requestBody.action === 'elicitation-cancel') {
    const { action, elicitationId } = requestBody;
    const resolve = () => action === 'elicitation-submit'
      ? resolveElicitation(elicitationId, { action: 'accept', content: requestBody.content })
      : resolveElicitation(elicitationId, { action: 'cancel' });
    let result: ReturnType<typeof resolve>;
    if (action === 'elicitation-submit' && isPersonaOwnedConversationState(responseState)) {
      const authority = responseState?.executionAuthority;
      if (!authority?.commitWhileCurrent) {
        return NextResponse.json({
          error: 'Persona execution authority is unavailable; refusing an unfenced elicitation.',
        }, { status: 409 });
      }
      try {
        // Accepted elicitation can release a blocked MCP server into a local
        // side effect. Hold the Persona lease across the synchronous registry
        // resolution so deletion cannot enter at the promise-continuation gap.
        result = await authority.commitWhileCurrent(async () => resolve());
      } catch {
        return NextResponse.json({
          error: 'Persona execution authority expired before elicitation resolution.',
        }, { status: 409 });
      }
    } else {
      result = resolve();
    }
    if (!result) {
      log.warn('No pending elicitation found', { requestId, conversationId, elicitationId });
      return NextResponse.json({ error: `No pending elicitation with ID ${elicitationId}` }, { status: 404 });
    }
    log.info('Resolved elicitation', { requestId, conversationId, action, elicitationId });
    return NextResponse.json({ status: 'running', conversation_id: conversationId });
  }

  // --- Question answer/decline (issue #258; in-request blocking-promise path) ---
  if (requestBody.action === 'question-answer' || requestBody.action === 'question-decline') {
    const { action, questionId } = requestBody;
    const resolved = action === 'question-answer'
      ? resolvePendingQuestion(conversationId, questionId, requestBody.answers ?? [])
      : declinePendingQuestion(conversationId, questionId);
    if (!resolved) {
      log.warn('No pending question found', { requestId, conversationId, questionId });
      return NextResponse.json({ error: `No pending question with ID ${questionId}` }, { status: 404 });
    }
    log.info('Resolved question', { requestId, conversationId, action, questionId });
    return NextResponse.json({ status: 'running', conversation_id: conversationId });
  }

  const { action, toolCallId, feedback } = requestBody as { action: 'approve' | 'reject'; toolCallId: string; feedback?: string };
  log.info(`Processing response action`, { requestId, conversationId, action, toolCallId });

  // In-request agentic approval (Claude subscription): the run is still live and
  // blocked inside the adapter's canUseTool. Resolving the pending approval
  // unblocks it — the SDK then executes the tool and continues the loop within
  // the original (still-open) request. We must NOT execute the tool or resume
  // here (that's the normal pause/resume path below). The live SSE stream carries
  // ongoing events; we just report the remaining approval state.
  if (resolvePendingApproval(conversationId, toolCallId, action === 'approve', feedback)) {
    const remaining = listPendingToolCalls(conversationId);
    log.info('Resolved in-request tool approval', { requestId, conversationId, action, toolCallId, remaining: remaining.length });
    return NextResponse.json(
      remaining.length > 0
        ? { status: 'awaiting_tool_approval', conversation_id: conversationId, pendingToolCalls: remaining }
        : { status: 'running', conversation_id: conversationId }
    );
  }

  return withConversationExecutionLock(conversationId, async () => {
    try {
    const storageKey = `conversations/${conversationId}` as StorageKey;

    // 1. Re-load the authoritative state only after acquiring the same lease as
    // Persona anonymization. The earlier read guarded process-local registries;
    // it must not authorize this durable, side-effecting resume path.
    const sharedState: SharedState | undefined = await loadConversationState(conversationId);

    // 2. Validate state
    if (!sharedState) {
      log.warn(`Conversation state not found`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }
    if (isPersonaOwnedConversationState(sharedState)) {
      const notLoopback = assertLocalRequest(request);
      if (notLoopback) return notLoopback;
    }
    if (sharedState.personaArchived) {
      return NextResponse.json(
        { error: 'An anonymized Persona archive is read-only.' },
        { status: 409 },
      );
    }
    if (isPersonaOwnedConversationState(sharedState) && !sharedState.personaAttribution) {
      return NextResponse.json({
        error: 'Persona conversation attribution is incomplete; refusing an unfenced response.',
      }, { status: 409 });
    }

    if (sharedState.status !== 'awaiting_tool_approval' || !sharedState.pendingToolCalls) {
      log.warn(`Conversation is not awaiting tool approval`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: 'Conversation is not awaiting tool approval' }, { status: 400 });
    }

    // Persona-owned conversations are continuations of the Activity pinned in
    // persisted attribution. Apply the side-effecting decision only after the
    // dispatcher reacquires that exact Activity and supplies fresh authority.
    if (sharedState.personaAttribution) {
      const { personaId, activityId, behaviorRevisionId } = sharedState.personaAttribution;
      if (!activityId || !behaviorRevisionId) {
        return NextResponse.json({
          error: 'Persona conversation attribution is incomplete; refusing an unfenced resume.',
        }, { status: 409 });
      }
      if (!sharedState.pendingToolCalls.some((toolCall) => toolCall.id === toolCallId)) {
        return NextResponse.json({ error: `Pending tool call with ID ${toolCallId} not found` }, { status: 404 });
      }
      const always = (requestBody as {
        action: 'approve' | 'reject';
        toolCallId: string;
        always?: boolean;
      }).always;
      const dispatch = await resumePersonaFlowDispatch({
        personaId,
        activityId,
        behaviorRevisionId,
        conversationId,
        reason: 'approval',
        flowInputPatch: {
          messages: sharedState.messages,
          requireApproval: sharedState.requireApproval ?? true,
          debug: sharedState.debugMode ?? false,
          continueDebug: false,
          userTurn: false,
        },
        prepare: async ({ installExecutionAuthority }) => {
          installExecutionAuthority(sharedState);
          const decision = await applyApprovalDecision(
            sharedState,
            toolCallId,
            action,
            always,
            feedback,
          );
          if (decision.outcome === 'tool_not_found') {
            throw new Error(`Pending tool call with ID ${toolCallId} disappeared during resume.`);
          }
          sharedState.lastResponse = undefined;
          sharedState.lastError = undefined;
          sharedState.errorEventEmitted = false;
          FlowExecutor.conversationStates.set(conversationId, sharedState);
          await persistConversationState(storageKey, sharedState);
          await appendRawForState(
            sharedState,
            decision.appendedMessages.map((message) => ({ type: 'message', message })),
          );
          return sharedState.status === 'awaiting_tool_approval' ? 'yield' : 'resume';
        },
      });
      return personaResumeResponse(dispatch, conversationId);
    }

    // 3/4. Apply the decision (execute-or-reject the tool, drain the batch,
    // flip back to 'running' when done). Shared with the headless approval
    // inbox (POST /api/approvals/:id) via applyApprovalDecision so both paths
    // behave identically (issue #115).
    const always = (requestBody as { action: 'approve' | 'reject'; toolCallId: string; always?: boolean }).always;
    const decision = await applyApprovalDecision(sharedState, toolCallId, action, always, feedback);
    if (decision.outcome === 'tool_not_found') {
      log.warn(`Pending tool call not found`, { requestId, conversationId, toolCallId });
      return NextResponse.json({ error: `Pending tool call with ID ${toolCallId} not found` }, { status: 404 });
    }
    const appendedMessages: FlujoChatMessage[] = decision.appendedMessages;

    // 5. Save updated state
    sharedState.lastResponse = undefined; // Clear last response before potentially resuming
    // Issue #383: clear the stale error alongside lastResponse so a resumed
    // turn doesn't keep reporting the previous failure.
    sharedState.lastError = undefined;
    sharedState.errorEventEmitted = false;
    FlowExecutor.conversationStates.set(conversationId, sharedState); // Update memory map
    await persistConversationState(storageKey, sharedState); // Save to storage (trace stripped)
    // Fold this request's appended messages into the conversation log so the
    // projection reflects them even while the run stays paused for approval.
    await appendRawForState(sharedState, appendedMessages.map(m => ({ type: 'message', message: m })));
    log.info(`Saved updated state after processing tool response`, { requestId, conversationId, newStatus: sharedState.status });

    // 6a. Still awaiting approval for other tool calls in the same batch: just
    // report the remaining pending calls so the UI keeps prompting. No model
    // run yet — we resume only once every pending call has been handled.
    if (sharedState.status === 'awaiting_tool_approval') {
      log.info(`Still awaiting approval for remaining tool calls`, { requestId, conversationId, remaining: sharedState.pendingToolCalls?.length });
      return NextResponse.json({
        status: 'awaiting_tool_approval',
        conversation_id: conversationId,
        pendingToolCalls: sharedState.pendingToolCalls,
        messages: sharedState.messages,
        updatedAt: sharedState.updatedAt,
      });
    }

    // 6b. All pending calls handled → resume execution so the model is invoked
    // again with the tool results. The /respond route only appends the tool
    // result(s); without this the conversation would sit idle after approval
    // (the old polling that used to drive continuation was removed). Mirrors
    // the debug/continue route. The frontend already has the SSE stream open,
    // so live events flow; the returned response is the next natural stop point
    // (further approval, completion, debug pause, or error).
    const flow = await flowService.getFlow(sharedState.flowId);
    if (!flow) {
      log.error(`Flow definition not found for flowId ${sharedState.flowId}`, { requestId, conversationId });
      return NextResponse.json({ error: `Flow definition not found for ID ${sharedState.flowId}` }, { status: 500 });
    }

    const simulatedRequestData: ChatCompletionRequest = {
      model: `flow-${flow.name}`,
      messages: sharedState.messages,
    };

    log.info(`Resuming execution after tool response`, { requestId, conversationId });
    const response = await processChatCompletion(
      simulatedRequestData,
      true, // flujo
      // Got here via approval, so keep requiring approval for later calls unless
      // the run explicitly recorded otherwise.
      sharedState.requireApproval ?? true,
      false, // flujodebug param ignored on resume (debugMode already in state)
      conversationId
    );

    return response;

    } catch (error) {
      log.error('Error processing tool response action', {
        requestId,
        conversationId,
        action,
        toolCallId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error
      });
      return NextResponse.json({ error: 'Internal server error processing tool response' }, { status: 500 });
    }
  });
}

export const POST = withWorkspaceRoute(POST_handler);
