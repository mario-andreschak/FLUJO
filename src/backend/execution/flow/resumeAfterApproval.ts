import { createLogger } from '@/utils/logger';
import { SharedState } from '@/backend/execution/flow/types';
import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { FlujoChatMessage } from '@/shared/types/chat';
import { decodeToolName } from '@/backend/execution/flow/handlers/toolNamespace';
import { extractResource, evaluatePermission } from '@/backend/execution/flow/permissionEngine';
import { SavedPermissionRule } from '@/shared/types/permissions';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';

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
  | { outcome: 'ready'; appendedMessages: FlujoChatMessage[] };

export async function applyApprovalDecision(
  sharedState: SharedState,
  toolCallId: string,
  action: 'approve' | 'reject',
  always?: boolean,
  feedback?: string   // Issue #247: optional rejection feedback for the model
): Promise<ApprovalDecisionOutcome> {
  const pending = sharedState.pendingToolCalls ?? [];
  const toolCallToProcess = pending.find(tc => tc.id === toolCallId);
  if (!toolCallToProcess) {
    return { outcome: 'tool_not_found' };
  }

  // Messages appended by this decision; folded into the append-only
  // conversation log by the caller after the state is saved.
  const appendedMessages: FlujoChatMessage[] = [];

  // Issue #246: if the user clicked "Always Allow" or "Always Deny", save a new
  // SavedPermissionRule to the conversation's savedPermissionRules so future calls
  // to the same tool are auto-resolved without an approval prompt.
  if (always) {
    const decoded = decodeToolName(toolCallToProcess.function.name, sharedState.toolNameMap);
    if (decoded) {
      let callArgs: Record<string, unknown> = {};
      try { callArgs = JSON.parse(toolCallToProcess.function.arguments); } catch { /* best effort */ }
      const resource = extractResource(callArgs);
      const savedEffect = action === 'approve' ? 'allow' : 'deny';
      const newRule: SavedPermissionRule = {
        action: decoded.tool,
        // Save with the actual extracted resource so re-evaluations hit the same bucket;
        // use '*' as the fallback so the rule covers the whole tool when no resource
        // could be extracted.
        resource: resource === '*' ? '*' : resource,
        effect: savedEffect,
        savedAt: Date.now(),
        server: decoded.server,
        tool: decoded.tool,
      };
      sharedState.savedPermissionRules = [
        ...(sharedState.savedPermissionRules ?? []),
        newRule,
      ];
      log.info(`Saved ${savedEffect} rule for ${decoded.tool} on ${decoded.server} (resource: ${resource})`);

      // Re-evaluate remaining pending calls: any that are now covered by a saved
      // rule are auto-resolved (no further user action needed).
      if (sharedState.pendingToolCalls && sharedState.pendingToolCalls.length > 0) {
        const remaining = sharedState.pendingToolCalls.filter(tc => tc.id !== toolCallId);
        const stillPending: OpenAI.ChatCompletionMessageToolCall[] = [];
        for (const tc of remaining) {
          const tcDecoded = decodeToolName(tc.function.name, sharedState.toolNameMap);
          if (!tcDecoded) { stillPending.push(tc); continue; }
          let tcArgs: Record<string, unknown> = {};
          try { tcArgs = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
          const tcResource = extractResource(tcArgs);
          const tcEffect = evaluatePermission(
            sharedState.permissionRules ?? [],
            sharedState.savedPermissionRules ?? [],
            tcDecoded.server,
            tcDecoded.tool,
            tcResource,
          );
          if (tcEffect === 'allow') {
            // Auto-approve and process
            const autoResult = await ModelHandler.processToolCalls({
              toolCalls: [tc],
              toolNameMap: sharedState.toolNameMap,
              mcpNodes: sharedState.currentMCPNodes,
              permissionRules: sharedState.permissionRules,
              savedPermissionRules: sharedState.savedPermissionRules,
            });
            if (autoResult.success) {
              const msgs = autoResult.value.toolCallMessages.map(m => ({
                ...m,
                id: (m as Partial<FlujoChatMessage>).id || uuidv4(),
                timestamp: (m as Partial<FlujoChatMessage>).timestamp || Date.now(),
                processNodeId: (m as Partial<FlujoChatMessage>).processNodeId || sharedState.currentNodeId,
              }));
              sharedState.messages.push(...msgs);
              appendedMessages.push(...msgs);
            } else {
              stillPending.push(tc);
            }
          } else if (tcEffect === 'deny') {
            // Auto-deny
            const deniedMsg: FlujoChatMessage = {
              id: uuidv4(),
              role: 'tool',
              tool_call_id: tc.id,
              content: `Permission denied (always deny rule): ${tc.function.name}`,
              timestamp: Date.now(),
            };
            sharedState.messages.push(deniedMsg);
            appendedMessages.push(deniedMsg);
          } else {
            stillPending.push(tc);
          }
        }
        sharedState.pendingToolCalls = stillPending;
      }
    }
  }

  if (action === 'approve') {
    log.info(`Approving tool call ${toolCallId} (${toolCallToProcess.function.name})`);
    // Process *only* the approved tool call.
    const toolProcessingResult = await ModelHandler.processToolCalls({
      toolCalls: [toolCallToProcess],
      toolNameMap: sharedState.toolNameMap,
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
      sharedState.pendingToolCalls = (sharedState.pendingToolCalls ?? []).filter(tc => tc.id !== toolCallId);
    }
  } else {
    // action === 'reject'
    log.info(`Rejecting tool call ${toolCallId} (${toolCallToProcess.function.name})`);
    const rejectionMessage: FlujoChatMessage = {
      role: 'tool',
      tool_call_id: toolCallId,
      // Issue #247: when the user supplies a reason, carry it back to the model
      // so it can adjust; otherwise preserve the exact original fixed string.
      content: feedback
        ? `User rejected this tool call: ${feedback}`
        : `User rejected tool call: ${toolCallToProcess.function.name}`,
      id: uuidv4(),
      timestamp: Date.now(),
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
