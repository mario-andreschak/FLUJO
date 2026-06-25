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

/** Best-effort plain-text view of a (possibly multipart) message content. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
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

    let inputText = promptTemplate || '';
    if (!inputText && sharedState.messages.length > 0) {
      const last = sharedState.messages[sharedState.messages.length - 1];
      inputText = messageText(last.content);
    }

    const prepResult: SubflowNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'subflow',
      subflowId,
      inputText,
      depth: (sharedState.runDepth ?? 0) + 1,
      parentRunId: sharedState.conversationId,
    };
    log.info('prep() completed', { subflowId, depth: prepResult.depth, inputLength: inputText.length });
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
      prompt: prepResult.inputText,
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
