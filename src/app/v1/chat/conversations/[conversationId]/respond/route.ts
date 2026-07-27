import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState } from '@/backend/execution/flow/types';
import { StorageKey } from '@/shared/types/storage';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState } from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { resolvePendingApproval, listPendingToolCalls } from '@/backend/execution/flow/toolApprovalRegistry';
import { resolveElicitation } from '@/backend/services/mcp/elicitationRegistry';
import { applyApprovalDecision } from '@/backend/execution/flow/resumeAfterApproval';
import { processChatCompletion } from '@/app/v1/chat/completions/chatCompletionService';
import { ChatCompletionRequest } from '@/app/v1/chat/completions/requestParser';
import { flowService } from '@/backend/services/flow/index';
import { FlujoChatMessage } from '@/shared/types/chat';
import OpenAI from 'openai';

const log = createLogger('app/v1/chat/conversations/[conversationId]/respond/route');

type RespondRequestBody =
  | { action: 'approve' | 'reject'; toolCallId: string; always?: boolean; feedback?: string }
  | { action: 'elicitation-submit'; elicitationId: string; content: Record<string, string | number | boolean | string[]> }
  | { action: 'elicitation-cancel'; elicitationId: string };

export async function POST(
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
    const validActions = ['approve', 'reject', 'elicitation-submit', 'elicitation-cancel'];
    if (!requestBody.action || !validActions.includes(requestBody.action)) {
      throw new Error(`Invalid request body. action must be one of: ${validActions.join(', ')}`);
    }
    if ((requestBody.action === 'approve' || requestBody.action === 'reject') && !requestBody.toolCallId) {
      throw new Error('toolCallId is required for approve/reject actions');
    }
    if ((requestBody.action === 'elicitation-submit' || requestBody.action === 'elicitation-cancel') && !requestBody.elicitationId) {
      throw new Error('elicitationId is required for elicitation actions');
    }
  } catch (error) {
    log.warn('Invalid request body', { requestId, error: error instanceof Error ? error.message : error });
    return NextResponse.json({ error: 'Invalid request body', details: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 });
  }

  // --- Elicitation submit/cancel (in-request path: run is live, blocked in the handler) ---
  if (requestBody.action === 'elicitation-submit' || requestBody.action === 'elicitation-cancel') {
    const { action, elicitationId } = requestBody;
    const result = action === 'elicitation-submit'
      ? resolveElicitation(elicitationId, { action: 'accept', content: requestBody.content })
      : resolveElicitation(elicitationId, { action: 'cancel' });
    if (!result) {
      log.warn('No pending elicitation found', { requestId, conversationId, elicitationId });
      return NextResponse.json({ error: `No pending elicitation with ID ${elicitationId}` }, { status: 404 });
    }
    log.info('Resolved elicitation', { requestId, conversationId, action, elicitationId });
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

  try {
    const storageKey = `conversations/${conversationId}` as StorageKey;

    // 1. Load state (prefer memory, fallback to storage)
    const sharedState: SharedState | undefined = await loadConversationState(conversationId);

    // 2. Validate state
    if (!sharedState) {
      log.warn(`Conversation state not found`, { requestId, conversationId });
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    if (sharedState.status !== 'awaiting_tool_approval' || !sharedState.pendingToolCalls) {
      log.warn(`Conversation is not awaiting tool approval`, { requestId, conversationId, status: sharedState.status });
      return NextResponse.json({ error: 'Conversation is not awaiting tool approval' }, { status: 400 });
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
}
