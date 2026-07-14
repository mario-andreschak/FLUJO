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
import { EmitFn } from '@/shared/types/execution/events';

const log = createLogger('backend/execution/flow/nodes/SubflowNode');

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
 *   - drop processNodeId (parent node ids don't exist in the child flow),
 *   - keep user messages and prose-only assistant messages with real content.
 */
function sanitizeForSubflow(messages: FlujoChatMessage[]): FlujoChatMessage[] {
  const out: FlujoChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'tool') continue;
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
 * Narrow a sanitized transcript to just the most recent user instruction
 * ('latest-message' inputMode, issue #74). An orchestrator that hands off to a
 * worker subflow on every loop iteration would otherwise re-send the entire
 * accumulated history — including already-finished tasks — causing the worker
 * to re-anchor on the earliest/loudest task. Scoping to the last user message
 * pins each invocation to the current task. Falls back to the full sanitized
 * list when there is no user message (unusual, but keeps the subflow fed).
 */
function latestUserMessage(sanitized: FlujoChatMessage[]): FlujoChatMessage[] {
  for (let i = sanitized.length - 1; i >= 0; i--) {
    if (sanitized[i].role === 'user') {
      return [sanitized[i]];
    }
  }
  return sanitized;
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
    // Back-compat: a promptTemplate saved before the explicit 'isolated' mode
    // existed used to override the history unconditionally. Preserve that by
    // treating "has a promptTemplate but no explicit inputMode" as isolated.
    const inputMode =
      node_params?.properties?.inputMode ?? (promptTemplate ? 'isolated' : 'full-history');
    const showSteps = node_params?.properties?.outputMode !== 'final-only';

    // 'isolated' mode sends `promptTemplate` as the subflow's single user prompt,
    // ignoring the parent conversation. Otherwise, pass the parent conversation so
    // the subflow continues with genuine context — either the full sanitized
    // history (default) or, in 'latest-message' mode, just the most recent user
    // instruction so each invocation is scoped to the current task (issue #74).
    const prepResult: SubflowNodePrepResult = {
      nodeId: node_params?.id || '',
      nodeType: 'subflow',
      subflowId,
      depth: (sharedState.runDepth ?? 0) + 1,
      parentRunId: sharedState.conversationId,
      showSteps,
      // The engine attaches the run's emit to sharedState for the duration of
      // this step; capturing it here lets execCore forward the child run's
      // events onto the PARENT conversation's channel, nested by depth.
      emit: sharedState.emit,
      nodeName: node_params?.properties?.name,
    };
    if (inputMode === 'isolated') {
      // Isolated mode sends a single authored prompt. When this node opted into
      // `allowCallerPrompt` (issue #96) and an upstream routing model passed a
      // `prompt` via the handoff tool, that caller prompt OVERRIDES the authored
      // `promptTemplate` (which becomes the default/fallback). The transient
      // handoffInput is single-shot and node-id-scoped: only apply it when it
      // targets THIS node, and clear it once inspected so it can never leak to a
      // later node or a subsequent turn.
      const allowCallerPrompt = node_params?.properties?.allowCallerPrompt === true;
      const pendingInput = sharedState.handoffInput;
      if (pendingInput && pendingInput.targetNodeId === node_params?.id) {
        sharedState.handoffInput = undefined; // consume on read
        if (allowCallerPrompt && pendingInput.prompt.trim()) {
          prepResult.inputText = pendingInput.prompt;
          log.info('Using caller-supplied prompt for isolated subflow', { nodeId: node_params?.id });
        } else {
          prepResult.inputText = promptTemplate ?? '';
        }
      } else {
        prepResult.inputText = promptTemplate ?? '';
      }
    } else {
      const sanitized = sanitizeForSubflow(sharedState.messages);
      prepResult.messages = inputMode === 'latest-message' ? latestUserMessage(sanitized) : sanitized;
    }

    // Child-flow display name for subflow:start attribution (best-effort).
    if (subflowId) {
      try {
        const { flowService } = await import('@/backend/services/flow/index');
        const flow = await flowService.getFlow(subflowId);
        if (flow?.name) prepResult.subflowName = flow.name;
      } catch {
        /* attribution only — never block the run on a name lookup */
      }
    }

    log.info('prep() completed', {
      subflowId,
      depth: prepResult.depth,
      mode: inputMode,
      historyCount: prepResult.messages?.length,
      showSteps,
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

    // Fold the child run's events into the PARENT conversation (outputMode
    // 'steps', the default): every child event is forwarded through the
    // parent's emit with depth + 1 — nested live view AND, via the bus tap,
    // nested persistence in the parent's log. The child itself stays ephemeral
    // and persists nothing of its own. The child's run boundaries are
    // translated to subflow:start / subflow:done (a raw child run:done on the
    // parent channel would terminate the parent's SSE streams mid-run).
    // Wrappers COMPOSE: a grandchild's events pass through two wrappers and
    // arrive at depth 2.
    const parentEmit = prepResult.emit;
    const nodeRef = {
      nodeId: prepResult.nodeId,
      nodeName: prepResult.nodeName,
      nodeType: 'subflow',
    };
    const subflowId = prepResult.subflowId;
    const childEmit: EmitFn | undefined =
      parentEmit && prepResult.showSteps
        ? (raw) => {
            const depth = (raw.depth ?? 0) + 1;
            if (raw.type === 'run:start') {
              parentEmit({
                type: 'subflow:start',
                node: nodeRef,
                subflowId,
                subflowName: prepResult.subflowName,
                depth,
              });
              return;
            }
            if (raw.type === 'run:done') {
              parentEmit({ type: 'subflow:done', node: nodeRef, subflowId, status: raw.status, depth });
              return;
            }
            if (raw.type === 'message') {
              // Stamp depth onto the message payload too: live consumers and
              // the log projection key nested display off message.depth.
              parentEmit({ ...raw, depth, message: { ...raw.message, depth } });
              return;
            }
            parentEmit({ ...raw, depth });
          }
        : undefined;

    log.info('execCore() running subflow', {
      subflowId: prepResult.subflowId,
      depth: prepResult.depth,
      showSteps: prepResult.showSteps,
      foldingEvents: !!childEmit,
    });
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
      ...(childEmit ? { emit: childEmit } : {}),
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
