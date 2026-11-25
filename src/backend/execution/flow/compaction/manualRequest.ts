import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ManualCompactionPreview } from '@/shared/types/contextCompaction';
import { estimateTokens, RETAINED_USER_SHARE, splitHistoryForCompaction } from '../handlers/summarizingCompaction';
import { requiredInstructionIds } from './standingInstructions';
import type { WireSummaryArtifact } from './types';

/** The budget compaction assumes when a model publishes no context window. */
const DEFAULT_PREVIEW_INPUT_BUDGET = 96_000;

/**
 * A person's explicit "/compact" for one conversation (#1225).
 *
 * FLUJO never rewrites the saved chat. A summary only changes what is sent to
 * the AI, and it is built right before a model call, where the exact view of
 * that step (node, model, tools) is known. So the request is a small marker:
 * the next model call summarizes even below the automatic threshold, and later
 * calls keep reusing that summary until the automatic threshold takes over.
 */
export interface ManualCompactionRequest {
  requestedAt: number;
  /** Set by the first model call after the request, whatever its outcome. */
  attemptedAt?: number;
}

export type ManualCompactionMode = 'force' | 'keep';

export function isManualCompactionRequest(value: unknown): value is ManualCompactionRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<ManualCompactionRequest>;
  return typeof request.requestedAt === 'number' && Number.isFinite(request.requestedAt)
    && (request.attemptedAt === undefined
      || (typeof request.attemptedAt === 'number' && Number.isFinite(request.attemptedAt)));
}

/**
 * `force`: the first model call after the request summarizes now.
 * `keep`: later calls reuse the summary made since the request, pinned at its
 * boundary, so no new summarizer call runs below the automatic threshold.
 */
export function manualCompactionMode(
  request: unknown,
  artifact?: Pick<WireSummaryArtifact, 'createdAt'>,
): ManualCompactionMode | undefined {
  if (!isManualCompactionRequest(request)) return undefined;
  if (request.attemptedAt === undefined) return 'force';
  return artifact && artifact.createdAt >= request.requestedAt ? 'keep' : undefined;
}

/** One forced attempt per request, so a request never lingers after it ran. */
export function markManualCompactionAttempted(
  request: ManualCompactionRequest,
  now: number,
): ManualCompactionRequest {
  return { requestedAt: request.requestedAt, attemptedAt: now };
}

/** What a summary right now would replace and keep, from the saved chat. */
export function previewManualCompaction(
  messages: readonly FlujoChatMessage[],
  keepTokens: number,
  inputBudgetTokens = DEFAULT_PREVIEW_INPUT_BUDGET,
): ManualCompactionPreview {
  const visible = messages.filter(message => message.role !== 'system' && message.role !== 'developer');
  const split = splitHistoryForCompaction([...messages], keepTokens);
  return {
    estimatedTokens: estimateTokens(visible),
    keepTokens,
    summarizedMessages: split.toSummarize.filter(message => message.role !== 'user').length,
    keptRecentMessages: split.toKeep.filter(message => message.role !== 'system' && message.role !== 'developer').length,
    keptEarlierUserMessages: split.protectedMessages.length,
    standingInstructions: requiredInstructionIds(split.protectedMessages).size,
    earlierUserMessagesFit: estimateTokens(split.protectedMessages) <= inputBudgetTokens * RETAINED_USER_SHARE,
  };
}
