import { createHash, randomUUID } from 'crypto';
import type OpenAI from 'openai';
import type { StorageKey } from '@/shared/types/storage';
import type {
  EmitFn,
  RawExecutionEvent,
  RecoveryCheckpointPhase,
  RecoveryCheckpointRef,
  RecoveryClassification,
  RecoveryFailureCategory,
  RecoveryFailureDetails,
  RecoveryRecord,
  RecoveryToolEffect,
} from '@/shared/types/execution/events';
import type { SharedState } from './types';
import { appendRawForState, flushConversationLog } from './conversationLog';
import { persistConversationState } from './persistConversationState';

const RECOVERY_OWNER_ID = randomUUID();
const UNKNOWN_TOOL_EFFECT_WARNING =
  'A tool may have produced an external side effect before execution stopped. Automatic replay is disabled; restart the turn or confirm the effect before retrying.';

export function recoveryOwnerId(): string {
  return RECOVERY_OWNER_ID;
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  const candidate = error as { message?: unknown; error?: unknown } | null;
  if (typeof candidate?.message === 'string') return candidate.message;
  if (typeof candidate?.error === 'string') return candidate.error;
  return 'Execution failed.';
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Central recovery classifier. It is deliberately conservative: only bounded,
 * side-effect-free provider/transport failures are marked retryable. */
export function classifyRecoveryFailure(error: unknown): {
  classification: 'retryable_failure' | 'permanent_failure';
  failure: RecoveryFailureDetails;
  retryAfterAt?: number;
} {
  const root = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const details = (root.details && typeof root.details === 'object'
    ? root.details
    : root.errorDetails && typeof root.errorDetails === 'object'
      ? root.errorDetails
      : root) as Record<string, unknown>;
  const status = numberField(details.status) ?? numberField(details.statusCode);
  const code = stringField(details.code) ?? stringField(details.type) ?? stringField(root.code);
  const message = safeMessage(error);
  const normalized = `${code ?? ''} ${message}`.toLowerCase();

  let category: RecoveryFailureCategory = 'unknown';
  let retryable = false;
  if (status === 429 || /rate.?limit|too many requests/.test(normalized)) {
    category = 'rate_limit';
    retryable = true;
  } else if (/context.{0,12}(limit|length|window)|maximum context/.test(normalized)) {
    category = 'context_limit';
  } else if (/input.{0,12}(limit|length|too large)|request.{0,12}too large/.test(normalized)) {
    category = 'input_limit';
  } else if (/session.{0,12}(lost|expired|invalid)|thread.{0,12}(lost|expired|not found)/.test(normalized)) {
    category = 'session_loss';
  } else if (/empty response|no response content|response was empty/.test(normalized)) {
    category = 'model_empty_response';
    retryable = true;
  } else if (/truncated response|unexpected end|premature end/.test(normalized)) {
    category = 'model_truncated_response';
    retryable = true;
  } else if (/tool/.test(normalized)) {
    category = 'tool_failure';
  } else if (
    status === 408 || status === 502 || status === 503 || status === 504 ||
    /timeout|timed out|econnreset|econnrefused|socket|network|fetch failed|connection closed/.test(normalized)
  ) {
    category = 'transport_failure';
    retryable = true;
  } else if (status !== undefined || /provider|model|api/.test(normalized)) {
    category = 'provider_failure';
    retryable = status === undefined || status >= 500;
  }

  const retryAfterMs =
    numberField(details.retryAfterMs) ??
    (numberField(details.retryAfter) !== undefined ? numberField(details.retryAfter)! * 1000 : undefined);
  return {
    classification: retryable ? 'retryable_failure' : 'permanent_failure',
    failure: { category, message, code, status, retryable },
    retryAfterAt: retryAfterMs !== undefined ? Date.now() + Math.max(0, retryAfterMs) : undefined,
  };
}

export function initializeRecovery(state: SharedState, runId: string): RecoveryRecord {
  const now = Date.now();
  const existing = state.recovery;
  if (existing?.runId === runId) {
    existing.classification = 'running';
    existing.ownerId = RECOVERY_OWNER_ID;
    existing.ownerHeartbeatAt = now;
    existing.updatedAt = now;
    existing.terminalAt = undefined;
    existing.failure = undefined;
    existing.retryAfterAt = undefined;
    existing.manualActionRequired = false;
    existing.sideEffectWarning = undefined;
    state.recovery = existing;
    return existing;
  }
  const record: RecoveryRecord = {
    version: 1,
    runId,
    attemptId: randomUUID(),
    attempt: 1,
    classification: 'running',
    parentRunId: state.parentRunId,
    ownerId: RECOVERY_OWNER_ID,
    ownerHeartbeatAt: now,
    startedAt: now,
    updatedAt: now,
  };
  state.recovery = record;
  return record;
}

export function fingerprintRecoveryInput(state: SharedState, nodeId?: string): string {
  const messages = (state.messages ?? []).slice(-8).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    toolCalls: (message as { tool_calls?: unknown }).tool_calls,
    toolCallId: (message as { tool_call_id?: string }).tool_call_id,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ flowId: state.flowId, nodeId, messages }))
    .digest('hex');
}

async function persistRecoveryEvent(
  storageKey: StorageKey,
  state: SharedState,
  raw: RawExecutionEvent,
  emit?: EmitFn,
): Promise<void> {
  if (emit) {
    emit(raw);
    if (state.conversationId && !state.ephemeral) {
      await flushConversationLog(state.conversationId);
    }
  } else {
    await appendRawForState(state, [raw]);
  }
  await persistConversationState(storageKey, state);
}

export async function commitRecoveryCheckpoint(
  storageKey: StorageKey,
  state: SharedState,
  input: {
    phase: RecoveryCheckpointPhase;
    nodeId?: string;
    turnEntryNodeId?: string;
    safe: boolean;
    effectStatus?: RecoveryCheckpointRef['effectStatus'];
    tools?: RecoveryToolEffect[];
  },
  emit?: EmitFn,
): Promise<RecoveryCheckpointRef | undefined> {
  if (state.ephemeral) return undefined;
  const recovery = state.recovery ?? initializeRecovery(state, state.logicalRunId ?? randomUUID());
  const now = Date.now();
  const checkpoint: RecoveryCheckpointRef = {
    id: randomUUID(),
    phase: input.phase,
    nodeId: input.nodeId,
    turnEntryNodeId: input.turnEntryNodeId ?? recovery.lastSafeCheckpoint?.turnEntryNodeId ?? input.nodeId,
    attempt: recovery.attempt,
    inputFingerprint: fingerprintRecoveryInput(state, input.nodeId),
    safe: input.safe,
    effectStatus: input.effectStatus ?? 'none',
    parentRunId: state.parentRunId,
    lane: recovery.lane,
    tools: input.tools,
    createdAt: now,
  };
  recovery.currentCheckpoint = checkpoint;
  if (checkpoint.safe) recovery.lastSafeCheckpoint = checkpoint;
  recovery.ownerId = RECOVERY_OWNER_ID;
  recovery.ownerHeartbeatAt = now;
  recovery.updatedAt = now;
  if (!checkpoint.safe && checkpoint.effectStatus === 'unknown') {
    recovery.manualActionRequired = true;
    recovery.sideEffectWarning = UNKNOWN_TOOL_EFFECT_WARNING;
  }
  state.recovery = recovery;
  await persistRecoveryEvent(storageKey, state, { type: 'recovery:checkpoint', checkpoint }, emit);
  return checkpoint;
}

export function describeToolEffects(
  state: SharedState,
  toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[],
): RecoveryToolEffect[] {
  return toolCalls.map((call) => {
    const mapped = state.toolNameMap?.[call.function.name];
    const annotations = mapped?.annotations as {
      readOnlyHint?: boolean;
      idempotentHint?: boolean;
      destructiveHint?: boolean;
    } | undefined;
    const readOnly = annotations?.readOnlyHint === true;
    return {
      toolCallId: call.id,
      name: call.function.name,
      readOnly,
      idempotent: readOnly || annotations?.idempotentHint === true,
      destructive: annotations?.destructiveHint,
    };
  });
}

export async function commitToolCheckpoint(
  storageKey: StorageKey,
  state: SharedState,
  toolCalls: OpenAI.ChatCompletionMessageFunctionToolCall[],
  phase: 'before' | 'completed' | 'unknown',
  emit?: EmitFn,
): Promise<void> {
  const tools = describeToolEffects(state, toolCalls);
  // Read-only tools can be retried safely and do not need an effect checkpoint.
  if (!tools.some((tool) => !tool.readOnly)) return;
  await commitRecoveryCheckpoint(storageKey, state, {
    phase: phase === 'before' ? 'tool:before' : phase === 'completed' ? 'tool:after' : 'tool:unknown',
    nodeId: state.currentNodeId,
    safe: phase === 'completed',
    effectStatus: phase === 'before' ? 'pending' : phase === 'completed' ? 'completed' : 'unknown',
    tools,
  }, emit);
}

export function setRecoveryTransition(
  state: SharedState,
  classification: RecoveryClassification,
  options: {
    failure?: RecoveryFailureDetails;
    retryAfterAt?: number;
    cancellationRequestedAt?: number;
    manualActionRequired?: boolean;
    sideEffectWarning?: string;
  } = {},
): RecoveryRecord {
  const recovery = state.recovery ?? initializeRecovery(state, state.logicalRunId ?? randomUUID());
  const now = Date.now();
  recovery.classification = classification;
  recovery.failure = options.failure;
  recovery.retryAfterAt = options.retryAfterAt;
  recovery.cancellationRequestedAt = options.cancellationRequestedAt ?? recovery.cancellationRequestedAt;
  recovery.manualActionRequired = options.manualActionRequired ?? recovery.manualActionRequired;
  recovery.sideEffectWarning = options.sideEffectWarning ?? recovery.sideEffectWarning;
  recovery.updatedAt = now;
  recovery.ownerHeartbeatAt = now;
  if (classification !== 'running' && classification !== 'paused') recovery.terminalAt = now;
  state.recovery = recovery;
  return recovery;
}

export async function commitRecoveryTransition(
  storageKey: StorageKey,
  state: SharedState,
  classification: RecoveryClassification,
  options: Parameters<typeof setRecoveryTransition>[2] = {},
  emit?: EmitFn,
): Promise<RecoveryRecord> {
  const recovery = setRecoveryTransition(state, classification, options);
  await persistRecoveryEvent(storageKey, state, { type: 'recovery:transition', recovery: { ...recovery } }, emit);
  return recovery;
}

/** A storage-loaded running record owned by another process is a durable crash
 * signal. Legacy records without owner metadata are left untouched. */
export async function reconcileInterruptedRecovery(
  storageKey: StorageKey,
  state: SharedState,
): Promise<boolean> {
  const recovery = state.recovery;
  if (
    state.status !== 'running' ||
    !recovery?.ownerId ||
    recovery.ownerId === RECOVERY_OWNER_ID
  ) {
    return false;
  }
  state.status = 'error';
  state.isCancelled = false;
  state.lastResponse = {
    success: false,
    error: 'Execution was interrupted before it reached a terminal boundary.',
  };
  const failure: RecoveryFailureDetails = {
    category: 'unclean_process_interruption',
    message: 'The process that owned this run is no longer active.',
    retryable: false,
  };
  await commitRecoveryTransition(storageKey, state, 'interrupted', {
    failure,
    manualActionRequired: true,
  });
  return true;
}

export function markDanglingToolEffectsUnknown(
  state: SharedState,
  classification: 'interrupted' | 'running' = 'interrupted',
): void {
  const recovery = state.recovery ?? initializeRecovery(state, state.logicalRunId ?? randomUUID());
  const now = Date.now();
  const checkpoint: RecoveryCheckpointRef = {
    id: randomUUID(),
    phase: 'tool:unknown',
    nodeId: state.currentNodeId,
    turnEntryNodeId: recovery.lastSafeCheckpoint?.turnEntryNodeId,
    attempt: recovery.attempt,
    inputFingerprint: fingerprintRecoveryInput(state, state.currentNodeId),
    safe: false,
    effectStatus: 'unknown',
    parentRunId: state.parentRunId,
    lane: recovery.lane,
    createdAt: now,
  };
  recovery.currentCheckpoint = checkpoint;
  recovery.classification = classification;
  recovery.failure = {
    category: 'tool_failure',
    message: 'A dangling tool call was repaired after interruption; its external effect is unknown.',
    retryable: false,
  };
  recovery.manualActionRequired = true;
  recovery.sideEffectWarning = UNKNOWN_TOOL_EFFECT_WARNING;
  recovery.updatedAt = now;
  recovery.terminalAt = classification === 'interrupted' ? now : undefined;
  state.recovery = recovery;
}
