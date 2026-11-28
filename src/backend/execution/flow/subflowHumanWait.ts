/**
 * How a Subflow step waits while one of its children waits for a person (#1095).
 *
 * A child flow with a Human step always runs saved, so it can stop and come back.
 * When it stops, its lane is marked `waiting`, the parent shows the child's step as
 * its own waiting call and stops too, so neither run holds a worker. The answer is
 * saved on the child; then the top waiting parent goes on, and its Subflow step
 * continues the child from where it stopped. Nothing a child did before its Human
 * step runs again.
 */
import type { FlujoFunctionToolCall } from '@/shared/types/openai';
import { flowMayWaitForPerson } from '@/utils/shared/flowApproval';
import { getHarnessExecution } from '@/backend/services/harness/executionScope';
import { delegatedHumanTasks, humanTaskCall, type DelegatedHumanTask } from './humanTask';
import { pinnedSubflowDefinition } from './subflowDependencies';
import type { SharedState, SubflowHumanWait, SubflowInvocationLane, SubflowNodePrepResult } from './types';
import type { Flow } from '@/shared/types/flow';

/** Whether a child run must be saved: it is asked to be, or its flow may wait for a person. */
export async function subflowChildIsSaved(
  prepResult: Pick<SubflowNodePrepResult, 'persistConversation'>,
  childFlow: () => Promise<Flow | null | undefined>,
): Promise<boolean> {
  if (prepResult.persistConversation) return true;
  if (getHarnessExecution()) return false;
  return flowMayWaitForPerson(await childFlow().catch(() => undefined), async (id) => {
    const { flowService } = await import('@/backend/services/flow/index');
    return flowService.getFlow(id);
  });
}

/** Whether any child of this plan may wait for a person, so the visit must be saved and joinable later. */
export async function subflowPlanMayWait(
  prepResult: Pick<SubflowNodePrepResult, 'lanes' | 'persistConversation' | 'personaAttribution' | 'parentFlowSnapshot' | 'nodeId'>,
): Promise<boolean> {
  if (prepResult.persistConversation || getHarnessExecution()) return false;
  for (const subflowId of new Set((prepResult.lanes ?? []).map((lane) => lane.subflowId))) {
    const needs = await subflowChildIsSaved({ persistConversation: false }, async () => {
      const pinned = pinnedSubflowDefinition(prepResult, subflowId).flowDefinition;
      if (pinned) return pinned;
      const { flowService } = await import('@/backend/services/flow/index');
      return flowService.getFlow(subflowId);
    });
    if (needs) return true;
  }
  return false;
}

/**
 * The Human steps a stopped child waits for: its own, or those of its own children.
 * Undefined when the child stopped for anything else.
 */
export function humanWaitOfChild(
  child: Pick<SharedState, 'status' | 'humanTask' | 'pendingToolCalls' | 'currentNodeId' | 'activeSubflowInvocationByNode' | 'subflowInvocations'> | undefined,
  conversationId: string | undefined,
): SubflowHumanWait[] | undefined {
  if (!child || !conversationId || child.status !== 'awaiting_tool_approval') return undefined;
  const own = child.humanTask && !child.humanTask.decision ? [{
    requestId: child.humanTask.requestId,
    toolCallId: child.humanTask.toolCallId,
    conversationId,
    call: humanTaskCall(child.humanTask),
  }] : [];
  const nested = delegatedHumanTasks(child).flatMap((task) => {
    const call = child.pendingToolCalls?.find((pending) => pending.id === task.toolCallId) as FlujoFunctionToolCall | undefined;
    return call ? [{ requestId: task.requestId, toolCallId: task.toolCallId, conversationId, call }] : [];
  });
  const waits = [...own, ...nested];
  return waits.length > 0 ? waits : undefined;
}

/** Whether a waiting lane's child still only waits, so going there again would do nothing. */
export function childStillWaits(child: Parameters<typeof humanWaitOfChild>[0]): boolean {
  return Boolean(child?.status === 'awaiting_tool_approval' && child.humanTask && !child.humanTask.decision);
}

/** Mark a lane as waiting for the given steps. */
export function markLaneWaiting(lane: SubflowInvocationLane, waits: SubflowHumanWait[]): void {
  lane.status = 'waiting';
  lane.humanTasks = waits.map(({ requestId, toolCallId }) => ({ requestId, toolCallId }));
  lane.outputText = undefined;
  lane.outputMedia = undefined;
  lane.error = undefined;
  lane.updatedAt = Date.now();
}

/** What a caller that cannot wait (a sub-flow called as a tool) is told. */
export function waitingText(waits: SubflowHumanWait[]): string {
  const titles = waits.map(({ call }) => {
    try {
      return String((JSON.parse(call.function.arguments) as { title?: unknown }).title ?? '');
    } catch {
      return '';
    }
  }).filter(Boolean);
  return `The sub-flow is waiting for a person${titles.length ? ` (${titles.map((title) => `"${title}"`).join(', ')})` : ''}. `
    + 'It goes on by itself once the step is answered in FLUJO.';
}

/**
 * A new message replaces a wait, also one for sub-flow children: the Subflow step's
 * visit is let go (its waiting lanes count as cancelled), so the next visit starts
 * fresh. Returns the child steps the caller must end.
 */
export function releaseWaitingSubflows(state: SharedState): DelegatedHumanTask[] {
  const waits = delegatedHumanTasks(state);
  if (waits.length === 0) return waits;
  const invocation = state.subflowInvocations?.[waits[0].invocationId];
  if (invocation) {
    for (const lane of invocation.lanes) {
      if (lane.status !== 'waiting') continue;
      lane.status = 'cancelled';
      lane.humanTasks = undefined;
      lane.error = 'Replaced by a new message.';
      lane.updatedAt = Date.now();
    }
    invocation.status = 'blocked';
    invocation.updatedAt = Date.now();
    if (state.activeSubflowInvocationByNode?.[invocation.parentNodeId] === invocation.id) {
      delete state.activeSubflowInvocationByNode[invocation.parentNodeId];
    }
  }
  if (state.status === 'awaiting_tool_approval') {
    state.status = 'running';
    state.pendingToolCalls = undefined;
  }
  return waits;
}

/**
 * Re-entering a Subflow step whose children waited: the waiting calls it showed are
 * dropped, because the step now looks at each child again and asks anew if needed.
 */
export function clearDelegatedWaits(state: SharedState): void {
  const delegated = new Set(delegatedHumanTasks(state).map((task) => task.toolCallId));
  if (delegated.size === 0 || !state.pendingToolCalls?.every((call) => delegated.has(call.id))) return;
  state.pendingToolCalls = undefined;
  if (state.status === 'awaiting_tool_approval') state.status = 'running';
}
