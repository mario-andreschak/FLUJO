/**
 * Saved Human step requests and the answers to them (#1095).
 *
 * A waiting step is frozen into `SharedState.humanTask` with a digest of exactly what
 * the person sees. An answer is checked here before it is saved: an accepting answer
 * must repeat that digest, typed answers must fit the questions, the deadline must not
 * have passed, and a second, different answer loses to the first. Everything in this
 * module only reads and changes the given state; callers save it.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FlujoFunctionToolCall } from '@/shared/types/openai';
import {
  HUMAN_STEP_TOOL_NAME,
  acceptOutcome,
  checkHumanAnswer,
  declineOutcome,
  type HumanAnswer,
  type HumanOutcome,
  type HumanTaskCallArguments,
  type HumanTaskView,
} from '@/utils/shared/humanStep';
import type { HumanTaskDecision, HumanTaskState, SharedState } from './types';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** SHA-256 of a value's canonical JSON, so the same content always has the same digest. */
export function contentDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex')}`;
}

export function humanTaskView(task: HumanTaskState): HumanTaskView {
  return {
    requestId: task.requestId,
    nodeId: task.nodeId,
    mode: task.mode,
    title: task.title,
    prompt: task.prompt,
    ...(task.candidate !== undefined ? { candidate: task.candidate } : {}),
    ...(task.format ? { format: task.format } : {}),
    ...(task.fields ? { fields: task.fields } : {}),
  };
}

/** The digest of what the person sees, read again from the saved request. */
export function humanTaskDigest(task: HumanTaskState): string {
  return contentDigest(humanTaskView(task));
}

/** The pending call a waiting step shows, carrying its view, digest and deadline. */
export function humanTaskCall(task: HumanTaskState): FlujoFunctionToolCall {
  const args: HumanTaskCallArguments = { ...humanTaskView(task), digest: task.digest, expiresAt: task.expiresAt };
  return { id: task.toolCallId, type: 'function', function: { name: HUMAN_STEP_TOOL_NAME, arguments: JSON.stringify(args) } };
}

export interface HumanTaskReceipt {
  requestId: string;
  decisionId: string;
  outcome: HumanOutcome;
  decidedAt: string;
}

export type HumanDecisionResult =
  | { kind: 'recorded'; receipt: HumanTaskReceipt }
  /** The same answer arrived again. Nothing changed; here is the first receipt. */
  | { kind: 'repeat'; receipt: HumanTaskReceipt }
  | { kind: 'refused'; status: 404 | 409 | 410 | 422; error: string; fieldErrors?: Record<string, string> };

function receiptOf(task: HumanTaskState, decision: HumanTaskDecision): HumanTaskReceipt {
  return { requestId: task.requestId, decisionId: decision.decisionId, outcome: decision.outcome, decidedAt: decision.decidedAt };
}

export interface HumanDecisionInput {
  /** Find the request by its call id (chat, approvals) or its request id (API). */
  toolCallId?: string;
  requestId?: string;
  accept: boolean;
  answer?: HumanAnswer;
  channel: HumanTaskDecision['channel'];
  now?: Date;
}

/**
 * Whether a conversation still waits for this step, or holds an answer it has not used
 * yet. A run that ended (cancelled, failed, finished) waits for nothing any more.
 */
export function isHumanTaskOpen(state: Pick<SharedState, 'humanTask' | 'status'> | undefined, requestId: string): boolean {
  return state?.humanTask?.requestId === requestId
    && (state.status === 'awaiting_tool_approval' || state.status === 'running');
}

/** The waiting Human step this answer is for, if any. */
export function findHumanTask(state: Pick<SharedState, 'humanTask'>, ids: { toolCallId?: string; requestId?: string }): HumanTaskState | undefined {
  const task = state.humanTask;
  if (!task) return undefined;
  if (ids.toolCallId !== undefined && task.toolCallId !== ids.toolCallId) return undefined;
  if (ids.requestId !== undefined && task.requestId !== ids.requestId) return undefined;
  return task;
}

/**
 * Check an answer and save it on the state. Accepting needs the digest the person saw,
 * and the content they saw must still be what is saved. Declining needs neither,
 * because it is always safe. The first decision wins: the same answer again returns
 * its receipt, a different one is refused.
 */
export function decideHumanTask(state: Pick<SharedState, 'humanTask'>, input: HumanDecisionInput): HumanDecisionResult {
  const task = findHumanTask(state, input);
  if (!task) return { kind: 'refused', status: 404, error: 'This step is not waiting for an answer.' };
  const now = input.now ?? new Date();
  const outcome = input.accept ? acceptOutcome(task.mode) : declineOutcome(task.mode);
  let value: unknown;
  if (input.accept) {
    const digest = input.answer?.digest;
    if (typeof digest !== 'string' || !digest) {
      return { kind: 'refused', status: 409, error: 'Send the digest of what the person saw to accept this step.' };
    }
    if (digest !== task.digest || humanTaskDigest(task) !== task.digest) {
      return { kind: 'refused', status: 409, error: 'What this step shows has changed. Open it again and answer the current version.' };
    }
    const checked = checkHumanAnswer(task, input.answer?.value);
    if (!checked.ok) return { kind: 'refused', status: 422, error: checked.error, fieldErrors: checked.fieldErrors };
    value = checked.value;
  }
  const valueDigest = value === undefined ? undefined : contentDigest(value);
  const idempotencyKey = typeof input.answer?.idempotencyKey === 'string' && input.answer.idempotencyKey.trim()
    ? input.answer.idempotencyKey.trim().slice(0, 200)
    : undefined;

  if (task.decision?.outcome === 'timed_out') {
    return { kind: 'refused', status: 410, error: 'This step timed out before the answer arrived.' };
  }
  if (task.decision) {
    const same = idempotencyKey && task.decision.idempotencyKey
      ? idempotencyKey === task.decision.idempotencyKey
        && task.decision.outcome === outcome && task.decision.valueDigest === valueDigest
      : task.decision.outcome === outcome && task.decision.valueDigest === valueDigest;
    return same
      ? { kind: 'repeat', receipt: receiptOf(task, task.decision) }
      : { kind: 'refused', status: 409, error: 'This step already has a different answer.' };
  }
  if (now.getTime() >= Date.parse(task.expiresAt)) {
    return { kind: 'refused', status: 410, error: 'This step timed out before the answer arrived.' };
  }
  task.decision = {
    decisionId: randomUUID(),
    outcome,
    ...(value !== undefined ? { value, valueDigest } : {}),
    decidedAt: now.toISOString(),
    channel: input.channel,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
  return { kind: 'recorded', receipt: receiptOf(task, task.decision) };
}

/** Record a time-out on a step whose deadline passed with no answer. Never approves. */
export function expireHumanTask(state: Pick<SharedState, 'humanTask'>, now: Date = new Date()): HumanTaskReceipt | undefined {
  const task = state.humanTask;
  if (!task || task.decision || now.getTime() < Date.parse(task.expiresAt)) return undefined;
  task.decision = { decisionId: randomUUID(), outcome: 'timed_out', decidedAt: now.toISOString(), channel: 'expiry' };
  return receiptOf(task, task.decision);
}

/** The approve or reject action that carries a saved decision through the approval path. */
export function approvalActionFor(decision: HumanTaskDecision): 'approve' | 'reject' {
  return decision.outcome === 'approved' || decision.outcome === 'submitted' ? 'approve' : 'reject';
}

/** A sub-flow child's Human step that its parent waits for. The child owns the step and its answer. */
export interface DelegatedHumanTask {
  requestId: string;
  toolCallId: string;
  conversationId: string;
  invocationId: string;
  laneId: string;
}

/**
 * The Human steps of sub-flow children this parent waits for at its current step.
 * The parent shows each one's call; an answer always goes to the child that asked.
 */
export function delegatedHumanTasks(
  state: Pick<SharedState, 'currentNodeId' | 'activeSubflowInvocationByNode' | 'subflowInvocations'> | undefined,
): DelegatedHumanTask[] {
  const invocationId = state?.currentNodeId ? state.activeSubflowInvocationByNode?.[state.currentNodeId] : undefined;
  const invocation = invocationId ? state?.subflowInvocations?.[invocationId] : undefined;
  if (!invocation) return [];
  return invocation.lanes.flatMap((lane) => lane.status === 'waiting'
    ? (lane.humanTasks ?? []).map((task) => ({ ...task, conversationId: lane.conversationId, invocationId: invocation.id, laneId: lane.id }))
    : []);
}

/** The child step behind one of the parent's waiting calls, found by call id or request id. */
export function findDelegatedHumanTask(
  state: Parameters<typeof delegatedHumanTasks>[0],
  ids: { toolCallId?: string; requestId?: string },
): DelegatedHumanTask | undefined {
  return delegatedHumanTasks(state).find((task) =>
    (ids.toolCallId === undefined || task.toolCallId === ids.toolCallId)
    && (ids.requestId === undefined || task.requestId === ids.requestId));
}
