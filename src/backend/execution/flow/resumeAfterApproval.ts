import { createLogger } from '@/utils/logger';
import { SharedState } from '@/backend/execution/flow/types';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlujoChatMessage } from '@/shared/types/chat';
import { decodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { applyToolRepeatGuard, TOOL_REPEAT_TEMPERATURE } from './toolRepeatGuard';
import type { HumanAnswer } from '@/utils/shared/humanStep';
import { approvalActionFor, decideHumanTask, type HumanTaskReceipt } from './humanTask';
import type { HumanTaskDecision } from './types';

const log = createLogger('backend/execution/flow/resumeAfterApproval');

/**
 * Shared tool-approval decision logic (issue #115).
 *
 * Extracted (behavior-preserving) from the chat `/respond` route so BOTH the
 * interactive chat approval path and the headless approval inbox
 * (POST /api/approvals/:id) apply a decision to a paused run identically —
 * execute (approve) or reject one pending tool call, append the resulting
 * message(s), and flip the run back to `running` once the batch is drained.
 *
 * This mutates the given, already-loaded and already-validated SharedState in
 * place and returns the messages it appended so the caller can persist the
 * state, fold the messages into the append-only conversation log, and then
 * resume execution (the resume itself stays in each caller so the chat path
 * keeps its exact processChatCompletion invocation).
 *
 * Precondition: the caller has verified `sharedState.status ===
 * 'awaiting_tool_approval'` and `sharedState.pendingToolCalls` is set.
 */
export type ApprovalDecisionOutcome =
  /** No pending tool call with the given id — caller should 404. */
  | { outcome: 'tool_not_found' }
  /** Decision applied; other calls in the batch still need a decision. */
  | { outcome: 'awaiting'; appendedMessages: FlujoChatMessage[] }
  /** Decision applied and the batch is drained; the run is ready to resume. */
  | { outcome: 'ready'; appendedMessages: FlujoChatMessage[] }
  /** A Human step refused the answer; it keeps waiting. Reply with this status. */
  | { outcome: 'human_refused'; status: 404 | 409 | 410 | 422; error: string; fieldErrors?: Record<string, string> };

/** What a Human step's answer carries besides approve or reject (#1095). */
export interface HumanDecisionContext {
  answer?: HumanAnswer;
  channel: HumanTaskDecision['channel'];
}

/**
 * Check, and on success save, a person's answer to a waiting Human step. An answer
 * that was already saved (for example by POST /api/human-tasks before a crash) is
 * taken as it is when the action matches it.
 */
function recordHumanStepAnswer(
  sharedState: Pick<SharedState, 'humanTask'>,
  toolCallId: string,
  action: 'approve' | 'reject',
  human: HumanDecisionContext | undefined,
): { refused?: Extract<ApprovalDecisionOutcome, { outcome: 'human_refused' }>; receipt?: HumanTaskReceipt } {
  const task = sharedState.humanTask!;
  if (task.decision && approvalActionFor(task.decision) === action) return {};
  const result = decideHumanTask(sharedState, {
    toolCallId, accept: action === 'approve', answer: human?.answer, channel: human?.channel ?? 'chat',
  });
  if (result.kind === 'refused') {
    return { refused: { outcome: 'human_refused', status: result.status, error: result.error,
      ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}) } };
  }
  return { receipt: result.receipt };
}

async function cancelledUiForToolCall(
  sharedState: SharedState,
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall,
  reason: string,
): Promise<FlujoChatMessage['ui']> {
  const decoded = decodeToolName(toolCall.function.name, sharedState.toolNameMap);
  if (!decoded) return undefined;
  let invocationArgs: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(toolCall.function.arguments);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      invocationArgs = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed call has no safe downstream forwarding identity.
  }
  const link = await ModelHandler.resolveToolUiLink(
    decoded.server,
    decoded.tool,
    undefined,
    decoded.uiResourceUri,
    invocationArgs,
  );
  return link ? { ...link, cancelledReason: reason, isError: true } : undefined;
}

/**
 * Check a Human step answer without saving it, for callers that must refuse before
 * they hand the run to someone else (a Persona dispatcher). Undefined means it fits.
 */
export function refusedHumanStepAnswer(
  sharedState: Pick<SharedState, 'humanTask'>,
  toolCallId: string,
  action: 'approve' | 'reject',
  human: HumanDecisionContext | undefined,
): Extract<ApprovalDecisionOutcome, { outcome: 'human_refused' }> | undefined {
  if (sharedState.humanTask?.toolCallId !== toolCallId) return undefined;
  return recordHumanStepAnswer({ humanTask: structuredClone(sharedState.humanTask) }, toolCallId, action, human).refused;
}

export async function applyApprovalDecision(
  sharedState: SharedState,
  toolCallId: string,
  action: 'approve' | 'reject',
  human?: HumanDecisionContext,
): Promise<ApprovalDecisionOutcome> {
  const pending = sharedState.pendingToolCalls ?? [];
  const toolCallToProcess = pending.find(tc => tc.id === toolCallId);
  if (!toolCallToProcess) {
    return { outcome: 'tool_not_found' };
  }

  // Messages appended by this decision; folded into the append-only
  // conversation log by the caller after the state is saved.
  const appendedMessages: FlujoChatMessage[] = [];

  if (sharedState.humanTask?.toolCallId === toolCallId) {
    // A Human step applies the answer itself when it resumes, like a Static wait.
    const { refused } = recordHumanStepAnswer(sharedState, toolCallId, action, human);
    if (refused) return refused;
    log.info(`Recording an answer for a Human step: ${action} ${toolCallId}`);
    sharedState.pendingToolCalls = pending.filter(tc => tc.id !== toolCallId);
  } else if (sharedState.staticHold?.toolCallId === toolCallId) {
    // A Static node acts on this itself when it resumes: it holds the capture, error
    // and routing rules for the entry, and it answers the waiting call.
    log.info(`Recording a decision for a Static node's wait: ${action} ${toolCallId}`);
    sharedState.staticHold.decision = action === 'approve' ? 'approved' : 'rejected';
    sharedState.pendingToolCalls = pending.filter(tc => tc.id !== toolCallId);
  } else if (action === 'approve') {
    log.info(`Approving tool call ${toolCallId} (${toolCallToProcess.function.name})`);
    // Process *only* the approved tool call.
    const toolProcessingResult = await ModelHandler.processToolCalls({
      toolCalls: [toolCallToProcess],
      toolNameMap: sharedState.toolNameMap,
      offeredToolNames: sharedState.offeredToolNames,
      mcpNodes: sharedState.currentMCPNodes, // Issue #239: native resource tools
    });

    if (!toolProcessingResult.success) {
      log.error(`Internal tool processing failed after approval for ${toolCallId}`, {
        error: toolProcessingResult.error,
      });
      const errorMessage: FlujoChatMessage = {
        role: 'tool',
        tool_call_id: toolCallId,
        content: `Error processing approved tool call ${toolCallToProcess.function.name}: ${toolProcessingResult.error?.message || 'Unknown error'}`,
        id: uuidv4(),
        timestamp: Date.now(),
      };
      sharedState.messages.push(errorMessage);
      appendedMessages.push(errorMessage);
      sharedState.pendingToolCalls = (sharedState.pendingToolCalls ?? []).filter(tc => tc.id !== toolCallId);
    } else {
      log.info(
        `Adding ${toolProcessingResult.value.toolCallMessages.length} tool result message(s) after approval`
      );
      const toolResultMessages: FlujoChatMessage[] = toolProcessingResult.value.toolCallMessages.map(
        msg => ({
          ...msg,
          id: (msg as Partial<FlujoChatMessage>).id || uuidv4(),
          timestamp: (msg as Partial<FlujoChatMessage>).timestamp || Date.now(),
          processNodeId: (msg as Partial<FlujoChatMessage>).processNodeId || sharedState.currentNodeId,
        })
      );
      sharedState.messages.push(...toolResultMessages);
      appendedMessages.push(...toolResultMessages);
      const logicalRunId = sharedState.logicalRunId ?? 'approval-resume';
      const guardState = sharedState.toolRepeatGuard?.logicalRunId === logicalRunId
        ? sharedState.toolRepeatGuard
        : { logicalRunId, entries: [] };
      sharedState.toolRepeatGuard = guardState;
      const repeatDecision = applyToolRepeatGuard(
        guardState,
        toolProcessingResult.value.processedToolCalls,
      );
      if (repeatDecision.raiseTemperature) {
        sharedState.temperatureOverrideOnce = TOOL_REPEAT_TEMPERATURE;
      }
      for (const content of repeatDecision.hints) {
        const hint: FlujoChatMessage = {
          role: 'user',
          content,
          id: uuidv4(),
          timestamp: Date.now(),
          processNodeId: sharedState.currentNodeId,
          injected: true,
        };
        sharedState.messages.push(hint);
        appendedMessages.push(hint);
      }
      sharedState.pendingToolCalls = (sharedState.pendingToolCalls ?? []).filter(tc => tc.id !== toolCallId);
    }
  } else {
    // action === 'reject'
    log.info(`Rejecting tool call ${toolCallId} (${toolCallToProcess.function.name})`);
    const rejectionReason = 'tool denied';
    const ui = await cancelledUiForToolCall(
      sharedState,
      toolCallToProcess,
      rejectionReason,
    );
    const rejectionMessage: FlujoChatMessage = {
      role: 'tool',
      tool_call_id: toolCallId,
      content: rejectionReason,
      id: uuidv4(),
      timestamp: Date.now(),
      ...(ui ? { ui } : {}),
    };
    sharedState.messages.push(rejectionMessage);
    appendedMessages.push(rejectionMessage);
    sharedState.pendingToolCalls = (sharedState.pendingToolCalls ?? []).filter(tc => tc.id !== toolCallId);
  }

  // Drain check: once every pending call in the batch is handled, flip back to
  // running so the caller can resume the model.
  if (sharedState.pendingToolCalls && sharedState.pendingToolCalls.length === 0) {
    sharedState.status = 'running';
    sharedState.pendingToolCalls = undefined;
  }
  // Clear the stored last response before a potential resume.
  sharedState.lastResponse = undefined;

  return sharedState.status === 'awaiting_tool_approval'
    ? { outcome: 'awaiting', appendedMessages }
    : { outcome: 'ready', appendedMessages };
}
