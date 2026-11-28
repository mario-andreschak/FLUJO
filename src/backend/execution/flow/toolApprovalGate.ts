import type OpenAI from 'openai';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import {
  listPendingToolCalls,
  registerPendingApproval,
  withdrawPendingApproval,
} from '@/backend/execution/flow/toolApprovalRegistry';
import { CALL_TOOL_TOOL_NAME } from '@/backend/execution/flow/toolLoading/deferredTools';
import { approvalSettingNow } from '@/backend/execution/flow/approvalSetting';

/**
 * FLUJO's one tool-approval gate (#1284, docs/architecture/tool-approval-single-gate-proposal.md).
 *
 * Every tool call FLUJO runs for a model passes here or through runFlow's
 * pause for approval, and both ask the person through the same card and the
 * same /respond route. Nothing else may approve, deny or remember a decision:
 * `flujo/single-tool-approval-gate` fails lint when other code tries.
 */

/** Only `true` turns approval on. A missing value (older conversations) is off. */
export function requireApprovalOf(value: boolean | null | undefined): boolean {
  return value === true;
}

/**
 * How long a run that cannot pause waits for a live answer (an agent SDK that
 * owns its tool loop, or a sub-flow). The wait holds a model process, so it
 * ends on its own: the tool does not run, the run ends with a plain message,
 * and the conversation is free again. Sending a message asks again.
 */
export const LIVE_APPROVAL_WAIT_MS = 30 * 60 * 1000;

/** Nobody answered a live approval request in time. The tool did not run. */
export class ToolApprovalWaitExpiredError extends Error {
  readonly code = 'approval_wait_expired';
  constructor(readonly toolName: string, waitedMs: number) {
    const minutes = Math.max(1, Math.round(waitedMs / 60_000));
    super(`Nobody answered the approval request for "${toolName}" within ${minutes} minute${minutes === 1 ? '' : 's'}, so it did not run. Send a message to ask again.`);
    this.name = 'ToolApprovalWaitExpiredError';
  }
}

/** Approval is required, but this run has nobody who could answer. The tool did not run. */
export class ToolApprovalUnavailableError extends Error {
  readonly code = 'approval_required';
  constructor(readonly toolName: string, reason: string) {
    super(`Headless run requires approval for tool "${toolName}" but no approver is available (${reason}).`);
    this.name = 'ToolApprovalUnavailableError';
  }
}

export interface ToolApprovalCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LiveDecisionOptions {
  signal?: AbortSignal;
  waitMs?: number;
}

function announce(conversationId: string): void {
  executionEventBus.emitterFor(conversationId)({
    type: 'run:awaiting_approval',
    pendingToolCalls: listPendingToolCalls(conversationId),
  });
}

/**
 * Show one call on the conversation's approval card and wait for the answer.
 * Resolves true (approved) or false (rejected). Rejects when the wait expires
 * or the run stops; the card is taken back then and the tool never runs.
 */
export function waitForLiveToolDecision(
  conversationId: string,
  toolCall: OpenAI.ChatCompletionMessageFunctionToolCall,
  options: LiveDecisionOptions = {},
): Promise<boolean> {
  const { signal } = options;
  const waitMs = options.waitMs ?? LIVE_APPROVAL_WAIT_MS;
  return new Promise<boolean>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('The run stopped before approval.'));
      return;
    }
    const stopWaiting = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const withdraw = (error: unknown) => {
      if (!withdrawPendingApproval(conversationId, toolCall.id)) return;
      stopWaiting();
      announce(conversationId);
      reject(error);
    };
    const onAbort = () => withdraw(signal?.reason ?? new Error('The run stopped before approval.'));
    // The answer always arrives later, from the /respond route, the approval
    // inbox (which lists this wait under its own receipt) or a cancel.
    registerPendingApproval(conversationId, toolCall, (approved) => {
      stopWaiting();
      resolve(approved);
    }, Date.now() + waitMs);
    const timer = setTimeout(() => withdraw(new ToolApprovalWaitExpiredError(toolCall.function.name, waitMs)), waitMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    announce(conversationId);
  });
}

export interface LiveToolApprovalOptions extends LiveDecisionOptions {
  /** The conversation whose chat shows the card. Missing means nobody can answer. */
  conversationId?: string;
  /** The conversation's Require Tool Approval setting when this run started. */
  requireApproval: boolean;
  /**
   * A person may change the setting while this run goes on: each call then
   * reads the conversation's latest saved value (approvalSetting.ts). Only for
   * runs someone is watching; a headless run keeps the value it started with.
   */
  followSetting?: boolean;
  /** A flow step's own rule for a tool, when the step has one. */
  stepRequiresApproval?: (name: string) => boolean;
  /** No-approver outcome of a headless run; only `fail` changes anything here. */
  onApprovalRequired?: 'auto' | 'fail' | 'pause';
}

/**
 * The approval callback for runs that own their tool loop. Undefined when no
 * call can need approval. A call that needs approval but has nobody to ask
 * fails instead of running: the gate never says yes on its own.
 */
export function createLiveToolApproval(
  options: LiveToolApprovalOptions,
): ((call: ToolApprovalCall) => Promise<boolean>) | undefined {
  const follows = options.followSetting === true && Boolean(options.conversationId) && options.onApprovalRequired === undefined;
  if (!options.requireApproval && !options.stepRequiresApproval && !follows) return undefined;
  const settingNow = () => (follows ? approvalSettingNow(options.conversationId, options.requireApproval) : options.requireApproval);
  return async (call) => {
    // `call_tool` only forwards to a step tool, and that call asks this gate
    // itself with the real tool name and arguments (#1448). Asking twice would
    // show the person the wrapper instead of the tool.
    if (call.name === CALL_TOOL_TOOL_NAME) return true;
    const approvalOn = settingNow();
    if (!approvalOn && !options.stepRequiresApproval?.(call.name)) return true;
    if (options.onApprovalRequired === 'fail') {
      throw new ToolApprovalUnavailableError(call.name, 'approvalPolicy: fail');
    }
    if (!options.conversationId) {
      throw new ToolApprovalUnavailableError(call.name, 'this run has no conversation to ask in');
    }
    const toolCall: OpenAI.ChatCompletionMessageFunctionToolCall = {
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    };
    return waitForLiveToolDecision(options.conversationId, toolCall, options);
  };
}
