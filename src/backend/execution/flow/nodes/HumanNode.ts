import { randomUUID } from 'node:crypto';
import { BaseNode } from '../pocketflow';
import { createLogger } from '@/utils/logger';
import {
  ERROR_ACTION,
  FINAL_RESPONSE_ACTION,
  HUMAN_APPROVAL_ACTION,
  type HumanNodeParams,
  type HumanTaskState,
  type SharedState,
} from '../types';
import type { FlujoChatMessage } from '@/shared/types/chat';
import { resolveRunVars, isValidRunVarName } from '@/utils/shared/resolveRunVars';
import { resolveRunResourceRefs } from '../resolveRunResourceRefs';
import { resolvePromptDynamicReferences } from '@/backend/utils/resolveDynamicReferences';
import { defaultConditionTarget, messageText, recordVariableSource, selectConditionedEdge } from '@/utils/shared/edgeConditions';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import {
  DEFAULT_HUMAN_OUTPUT_VARIABLE,
  DEFAULT_HUMAN_REJECTED_TEXT,
  DEFAULT_HUMAN_TIMED_OUT_TEXT,
  DEFAULT_HUMAN_TIMEOUT_MINUTES,
  HUMAN_STEP_APPROVED_RESULT,
  HUMAN_STEP_REJECTED_RESULT,
  HUMAN_STEP_TIMED_OUT_RESULT,
  MAX_HUMAN_TEXT_CHARS,
  acceptOutcome,
  humanStepIssues,
  isAcceptingOutcome,
  humanRouteOf,
} from '@/utils/shared/humanStep';
import { contentDigest, humanTaskCall, humanTaskDigest } from '../humanTask';
import { syncHumanTaskEntry, updateHumanTaskEntry } from '@/backend/services/humanTasks/humanTaskIndex';

const log = createLogger('backend/flow/execution/nodes/HumanNode');

/** How many Human step answers a conversation keeps on record. */
const MAX_HUMAN_TASK_LOG = 20;

function fail(sharedState: SharedState, message: string, code: string): string {
  sharedState.lastResponse = { success: false, error: message, errorDetails: { message, type: 'flow_error', code } };
  return ERROR_ACTION;
}

/**
 * Human step (#1095): the run stops here until a person approves, fills in a few
 * answers or changes a result, then goes on.
 *
 * The first visit freezes what the person will see into `sharedState.humanTask`,
 * shows it as one pending `human_step` call and returns the approval action. runFlow
 * then saves the run and stops, exactly as for a tool approval, so nothing is held
 * while the person decides. The answer is checked and saved by `decideHumanTask`
 * (humanTask.ts). The run then comes back to this node, which applies the saved
 * answer once: it answers the call, writes the result variable and picks the next step.
 * Nothing before this node runs again.
 */
export class HumanNode extends BaseNode<HumanNodeParams, SharedState, Record<string, never>, Record<string, never>> {
  async prep(): Promise<Record<string, never>> {
    return {};
  }

  async execCore(): Promise<Record<string, never>> {
    return {};
  }

  async post(
    _prepResult: unknown,
    _execResult: unknown,
    sharedState: SharedState,
    node_params?: HumanNodeParams,
  ): Promise<string> {
    const nodeId = node_params?.id || 'unknown';
    const properties = node_params?.properties ?? {};
    const existing = sharedState.humanTask?.nodeId === nodeId ? sharedState.humanTask : undefined;

    if (existing && !existing.decision) {
      // Still waiting: show the same request again rather than asking anew.
      sharedState.pendingToolCalls = [humanTaskCall(existing)];
      return HUMAN_APPROVAL_ACTION;
    }
    if (existing?.decision) return this.applyDecision(existing, sharedState, node_params);

    const issues = humanStepIssues(properties);
    if (issues.length > 0) {
      return fail(sharedState, `Human step "${properties.name || nodeId}": ${issues[0].message}`, issues[0].code);
    }
    const task = await this.openRequest(sharedState, nodeId, node_params);
    if (typeof task === 'string') return fail(sharedState, task, 'human_step_too_long');

    if (getHarnessExecution()) {
      // An evaluation has nobody to ask, and nothing it does has a real effect.
      task.decision = {
        decisionId: randomUUID(),
        outcome: acceptOutcome(task.mode),
        ...(task.mode === 'edit' ? { value: task.candidate ?? '', valueDigest: contentDigest(task.candidate ?? '') } : {}),
        ...(task.mode === 'input' ? { value: {}, valueDigest: contentDigest({}) } : {}),
        decidedAt: new Date().toISOString(),
        channel: 'evaluation',
      };
      sharedState.messages.push(this.callMessage(task));
      sharedState.humanTask = task;
      return this.applyDecision(task, sharedState, node_params);
    }

    sharedState.messages.push(this.callMessage(task));
    sharedState.humanTask = task;
    sharedState.pendingToolCalls = [humanTaskCall(task)];
    log.info('Waiting for a person', { nodeId, requestId: task.requestId, mode: task.mode });
    return HUMAN_APPROVAL_ACTION;
  }

  private callMessage(task: HumanTaskState): FlujoChatMessage {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [humanTaskCall(task)],
      id: randomUUID(),
      timestamp: Date.now(),
      processNodeId: task.nodeId,
    } as FlujoChatMessage;
  }

  /** Freeze what the person will see. Returns an error text when the content is too long to show. */
  private async openRequest(
    sharedState: SharedState,
    nodeId: string,
    node_params: HumanNodeParams | undefined,
  ): Promise<HumanTaskState | string> {
    const properties = node_params?.properties ?? {};
    const mode = properties.mode ?? 'approval';
    const referenceContext = { conversationId: sharedState.conversationId, flowId: sharedState.flowId, nodeId };
    const resolve = async (value: string | undefined): Promise<string> => {
      if (sharedState.executionExtensionContext) return value ?? '';
      const withResources = await resolveRunResourceRefs(
        resolveRunVars(value ?? '', sharedState.variables),
        sharedState.ephemeral ? undefined : sharedState.conversationId,
        sharedState.emit,
        { nodeId },
        sharedState,
      );
      return String(await resolvePromptDynamicReferences(withResources, referenceContext));
    };

    const review = properties.review ?? (mode === 'input' ? undefined : { source: 'last-assistant' as const });
    let candidate: string | undefined;
    if (review?.source === 'variable') {
      candidate = review.variable && isValidRunVarName(review.variable)
        ? String(sharedState.variables?.[review.variable] ?? '')
        : '';
    } else if (review) {
      const last = [...(sharedState.messages ?? [])].reverse().find((message) => message.role === 'assistant'
        && messageText(message.content).trim().length > 0);
      candidate = last ? messageText(last.content) : undefined;
    }
    if (candidate !== undefined && candidate.length > MAX_HUMAN_TEXT_CHARS) {
      return `Human step "${properties.name || nodeId}": the content to review is longer than ${MAX_HUMAN_TEXT_CHARS} characters.`;
    }

    const now = new Date();
    const timeoutMinutes = properties.timeoutMinutes ?? DEFAULT_HUMAN_TIMEOUT_MINUTES;
    const task: HumanTaskState = {
      requestId: randomUUID(),
      toolCallId: `call_human_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      nodeId,
      ...(sharedState.logicalRunId ? { logicalRunId: sharedState.logicalRunId } : {}),
      mode,
      title: (properties.title ?? '').trim() || (properties.name ?? '').trim() || node_params?.label || 'Human step',
      prompt: (await resolve(properties.prompt)).trim(),
      ...(candidate !== undefined ? { candidate } : {}),
      ...(review?.format ? { format: review.format } : {}),
      ...(mode === 'input' ? { fields: properties.fields ?? [] } : {}),
      outputVariable: properties.outputVariable ?? DEFAULT_HUMAN_OUTPUT_VARIABLE,
      onReject: properties.onReject ?? 'stop',
      onTimeout: properties.onTimeout ?? 'stop',
      ...(properties.rejectedText ? { rejectedText: properties.rejectedText } : {}),
      ...(properties.timedOutText ? { timedOutText: properties.timedOutText } : {}),
      digest: '',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + timeoutMinutes * 60_000).toISOString(),
    };
    task.digest = humanTaskDigest(task);
    return task;
  }

  /** Apply a saved answer exactly once and choose where the run goes next. */
  private async applyDecision(
    task: HumanTaskState,
    sharedState: SharedState,
    node_params: HumanNodeParams | undefined,
  ): Promise<string> {
    const decision = task.decision!;
    const accepted = isAcceptingOutcome(decision.outcome);
    const callResult = !accepted
      ? decision.outcome === 'timed_out' ? HUMAN_STEP_TIMED_OUT_RESULT : HUMAN_STEP_REJECTED_RESULT
      : task.mode === 'approval'
        ? HUMAN_STEP_APPROVED_RESULT
        : JSON.stringify({ outcome: decision.outcome, value: decision.value });
    sharedState.messages.push({
      role: 'tool', tool_call_id: task.toolCallId, content: callResult, id: randomUUID(), timestamp: Date.now(),
    } as FlujoChatMessage);

    sharedState.variables ??= {};
    const result = {
      requestId: task.requestId,
      decisionId: decision.decisionId,
      outcome: decision.outcome,
      ...(decision.value !== undefined ? { value: decision.value } : {}),
      candidateDigest: task.digest,
      ...(decision.valueDigest ? { valueDigest: decision.valueDigest } : {}),
      ...(task.mode === 'edit' && accepted ? { edited: decision.value !== task.candidate } : {}),
      decidedAt: decision.decidedAt,
    };
    Object.defineProperty(sharedState.variables, task.outputVariable, {
      value: JSON.stringify(result), configurable: true, enumerable: true, writable: true,
    });
    recordVariableSource(sharedState, task.outputVariable,
      decision.channel === 'expiry' || decision.channel === 'evaluation' ? 'rule' : 'person');

    sharedState.humanTaskLog = [
      ...(sharedState.humanTaskLog ?? []),
      {
        requestId: task.requestId,
        nodeId: task.nodeId,
        decisionId: decision.decisionId,
        outcome: decision.outcome,
        decidedAt: decision.decidedAt,
        channel: decision.channel,
        candidateDigest: task.digest,
        ...(decision.valueDigest ? { valueDigest: decision.valueDigest } : {}),
      },
    ].slice(-MAX_HUMAN_TASK_LOG);
    sharedState.humanTask = undefined;
    if (!sharedState.ephemeral && decision.channel !== 'evaluation') {
      await syncHumanTaskEntry(() => updateHumanTaskEntry(task.requestId, {
        status: 'applied',
        outcome: decision.outcome,
        decisionId: decision.decisionId,
        decidedAt: decision.decidedAt,
        finishedAt: new Date().toISOString(),
      }), 'applied');
    }
    log.info('Applied a person\'s answer', { nodeId: task.nodeId, requestId: task.requestId, outcome: decision.outcome });

    const ordered = node_params?.orderedOutgoingEdges ?? Array.from(this.successors.keys());
    const routes = node_params?.humanRoutes ?? {};
    const drawn = ordered.filter((edge) => routes[edge] === humanRouteOf(decision.outcome));
    // A connection drawn for this very answer (yes, no or timed out) is the author's choice.
    if (drawn.length > 0) return this.route(drawn, node_params, sharedState);

    const choice = decision.outcome === 'timed_out' ? task.onTimeout : task.onReject;
    if (!accepted && choice === 'stop') {
      const output = decision.outcome === 'timed_out'
        ? task.timedOutText || DEFAULT_HUMAN_TIMED_OUT_TEXT
        : task.rejectedText || DEFAULT_HUMAN_REJECTED_TEXT;
      sharedState.messages.push({ role: 'assistant', content: output, id: randomUUID(), timestamp: Date.now() } as FlujoChatMessage);
      sharedState.lastResponse = output;
      return FINAL_RESPONSE_ACTION;
    }

    // Otherwise the plain connections, the ones not drawn for a particular answer.
    return this.route(ordered.filter((edge) => routes[edge] === undefined), node_params, sharedState);
  }

  /** Take the first connection whose condition matches, or the only one when none has a condition. */
  private route(edges: string[], node_params: HumanNodeParams | undefined, sharedState: SharedState): string {
    const conditions = Object.fromEntries(Object.entries(node_params?.edgeConditions ?? {}).filter(([edge]) => edges.includes(edge)));
    if (Object.keys(conditions).length > 0) {
      return selectConditionedEdge(edges, conditions, sharedState.messages, defaultConditionTarget('human'), sharedState)
        ?? FINAL_RESPONSE_ACTION;
    }
    return edges.length > 0 ? edges[0] : 'default';
  }

  _clone(): BaseNode {
    return new HumanNode();
  }
}
