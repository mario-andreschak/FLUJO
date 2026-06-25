import { BaseNode } from '../temp_pocket';
import { createLogger } from '@/utils/logger';
import {
  SharedState,
  SubflowNodeParams,
  SubflowNodePrepResult,
  SubflowNodeExecResult,
  FINAL_RESPONSE_ACTION,
  ERROR_ACTION,
} from '../types';
import { FEATURES } from '@/config/features';
import { FlujoChatMessage } from '@/shared/types/chat';

const log = createLogger('backend/execution/flow/nodes/SubflowNode');

// The synthetic user message the run loop appends after a handoff. It must not
// leak into a subflow as "the task", so it is stripped from the passed history.
const HANDOFF_CONTINUE_MESSAGE = 'The handoff was successful. Continue';

/** True when a message carries real (non-empty) content. */
function hasContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.length > 0;
  return false;
}

/**
 * Build the message list handed to a subflow from the parent conversation.
 *
 * A subflow runs another flow as a continuation of this conversation, so it
 * needs the genuine exchange — but NOT FLUJO's internal plumbing, which would
 * confuse the child's model (or be invalid against its own toolset):
 *   - drop system messages (the child's StartNode injects its own),
 *   - drop tool-result messages,
 *   - drop assistant messages that made tool calls (handoff or otherwise): they
 *     are mid-action turns whose results we're also dropping, so keeping their
 *     prose would dangle. In the router case this drops the "I'll hand this off"
 *     turn, leaving the history ending on the user's task so the child model
 *     responds to it naturally rather than prefilling an assistant turn,
 *   - drop the synthetic "...Continue" handoff nudge,
 *   - drop processNodeId (parent node ids don't exist in the child flow),
 *   - keep user messages and prose-only assistant messages with real content.
 */
function sanitizeForSubflow(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  const out: FlujoChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'tool') continue;
    if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim() === HANDOFF_CONTINUE_MESSAGE) {
      continue;
    }
    if (msg.role === 'assistant' && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
      continue;
    }
    if (!hasContent(msg.content)) continue;
    const { processNodeId, ...rest } = msg as any;
    out.push({ ...rest });
  }
  return out;
}

/**
 * A node that runs another flow as a subroutine via the flow-as-callable
 * keystone (runFlow, ephemeral mode), then folds the subflow's output back into
 * the parent conversation and hands off to its successor.
 *
 * Input mapping (v1): an explicit `promptTemplate` property wins; otherwise the
 * subflow receives the parent conversation's latest message text.
 * Output mapping (v1): the subflow's final assistant text is appended to the
 * parent transcript as an assistant message attributed to this node, and set as
 * the parent's lastResponse.
 *
 * Isolation: the subflow runs in ephemeral state (nothing persisted to the
 * conversations store) at runDepth+1, so runFlow's depth guard stops infinite
 * recursion.
 */
export class SubflowNode extends BaseNode {
  async prep(sharedState: SharedState, node_params?: SubflowNodeParams): Promise<SubflowNodePrepResult> {
    const subflowId = node_params?.properties?.subflowId;
    const promptTemplate = node_params?.properties?.promptTemplate?.trim();

    // An explicit promptTemplate is an override: send exactly that as the
    // subflow's single user prompt. Otherwise, pass the sanitized parent
    // conversation so the subflow continues with genuine context.
    const prepResult: SubflowNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'subflow',
      subflowId,
      depth: (sharedState.runDepth ?? 0) + 1,
      parentRunId: sharedState.conversationId,
    };
    if (promptTemplate) {
      prepResult.inputText = promptTemplate;
    } else {
      prepResult.messages = sanitizeForSubflow(sharedState.messages);
    }

    log.info('prep() completed', {
      subflowId,
      depth: prepResult.depth,
      mode: promptTemplate ? 'promptTemplate' : 'history',
      historyCount: prepResult.messages?.length,
    });
    return prepResult;
  }

  async execCore(prepResult: SubflowNodePrepResult, _node_params?: SubflowNodeParams): Promise<SubflowNodeExecResult> {
    if (!prepResult.subflowId) {
      return { success: false, error: 'Subflow node has no flow selected (subflowId is empty).' };
    }

    // Lazy import breaks the static cycle:
    // SubflowNode -> runFlow -> FlowExecutor -> PocketflowEngine -> FlowConverter -> nodes
    const { runFlow } = await import('../runFlow');

    log.info('execCore() running subflow', { subflowId: prepResult.subflowId, depth: prepResult.depth });
    const result = await runFlow({
      flowId: prepResult.subflowId,
      // Either a promptTemplate override (single prompt) or the sanitized parent
      // history. prep sets exactly one of these.
      ...(prepResult.messages ? { messages: prepResult.messages } : { prompt: prepResult.inputText ?? '' }),
      mode: 'ephemeral',
      flujo: true,
      requireApproval: false, // headless: subflows never pause for approval
      debug: false,
      depth: prepResult.depth,
      parentRunId: prepResult.parentRunId,
    });

    if (result.status === 'error') {
      return {
        success: false,
        error: result.error?.message || 'Subflow execution failed',
        errorDetails: result.error?.details,
        subStatus: result.status,
      };
    }
    return { success: true, outputText: result.outputText, subStatus: result.status };
  }

  async post(
    prepResult: SubflowNodePrepResult,
    execResult: SubflowNodeExecResult,
    sharedState: SharedState,
    node_params?: SubflowNodeParams,
  ): Promise<string> {
    if (FEATURES.ENABLE_EXECUTION_TRACKER && Array.isArray(sharedState.trackingInfo.nodeExecutionTracker)) {
      sharedState.trackingInfo.nodeExecutionTracker.push({
        nodeType: 'SubflowNode',
        nodeId: node_params?.id || 'unknown',
        nodeName: node_params?.properties?.name || 'Subflow Node',
        timestamp: new Date().toISOString(),
      });
    }

    if (!execResult.success) {
      log.error('Subflow failed', { subflowId: prepResult.subflowId, error: execResult.error });
      sharedState.lastResponse = {
        success: false,
        error: execResult.error || 'Subflow execution failed',
        errorDetails: execResult.errorDetails,
      };
      return ERROR_ACTION;
    }

    // Fold the subflow's output into the parent transcript as an assistant
    // message attributed to this node, and expose it as the latest response.
    const outputText = execResult.outputText ?? '';
    const assistantMessage: FlujoChatMessage = {
      role: 'assistant',
      content: outputText,
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      processNodeId: node_params?.id,
    };
    sharedState.messages.push(assistantMessage);
    sharedState.lastResponse = outputText;

    // Hand off to the single linear successor, else end the flow.
    const actions = this.successors instanceof Map
      ? Array.from(this.successors.keys())
      : Object.keys(this.successors || {});
    if (actions.length > 0) {
      const action = actions[0];
      log.info(`post() completed, handing off via action: ${action}`);
      return action;
    }
    log.info('post() completed, no successor → FINAL_RESPONSE_ACTION');
    return FINAL_RESPONSE_ACTION;
  }

  _clone(): BaseNode {
    return new SubflowNode();
  }
}
