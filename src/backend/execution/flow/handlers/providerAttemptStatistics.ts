// Statistics for each provider attempt of one logical model call.
import { type Model } from '@/shared/types/model';
import { classifyStatisticsError, createStatisticsEvent, recordStatisticsEvent } from '@/backend/services/statistics';
import { statisticsAttemptId, statisticsCacheOutcomeFromUsage } from '@/backend/services/statistics/metadata';

/** Token usage a provider result reports (Chat Completions or Responses names), or undefined. */
export function usageFromProviderResult(value: unknown, contextWindow: number | undefined) {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as { usage?: Record<string, unknown> }).usage;
  if (!raw || typeof raw !== 'object') return undefined;
  const inputTokens = raw.prompt_tokens ?? raw.input_tokens;
  const outputTokens = raw.completion_tokens ?? raw.output_tokens;
  const totalTokens = raw.total_tokens;
  const promptDetails = raw.prompt_tokens_details as Record<string, unknown> | undefined;
  const inputDetails = raw.input_tokens_details as Record<string, unknown> | undefined;
  const cachedInputTokens = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens;
  const cacheWriteTokens = promptDetails?.cache_write_tokens ?? inputDetails?.cache_write_tokens;
  const numeric = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? candidate
    : undefined;
  const usage = {
    inputTokens: numeric(inputTokens),
    outputTokens: numeric(outputTokens),
    totalTokens: numeric(totalTokens),
    cachedInputTokens: numeric(cachedInputTokens),
    cacheWriteTokens: numeric(cacheWriteTokens),
    contextWindow,
  };
  return Object.values(usage).some(item => item !== undefined) ? usage : undefined;
}

/** One measured provider attempt, as the statistics record it. */
export type ProviderAttemptObservation = {
  durationMs: number;
  outcome: 'completed' | 'error' | 'cancelled';
  result?: unknown;
  error?: unknown;
  usage?: ReturnType<typeof usageFromProviderResult>;
};

/** The logical provider call the attempts belong to. */
export type ProviderAttemptContext = {
  runId?: string;
  nodeId?: string;
  /** Shared by every retry of one logical call; each attempt gets its own attempt id. */
  invocationId: string;
  /** The bound model's window, used when a result reports usage without one. */
  contextWindow?: number;
  /** The fallback member and credential currently in use. */
  routing: () => { model: Model; credentialId?: string };
};

/**
 * Records `model.attempt` statistics for one logical provider call. Attempts
 * are numbered in order. Recording never affects the provider call: any
 * failure is swallowed, and runs without a run id record nothing.
 */
export function createProviderAttemptRecorder(context: ProviderAttemptContext): (observation: ProviderAttemptObservation) => void {
  let providerAttemptOrdinal = 0;
  return (observation) => {
    if (!context.runId) return;
    try {
      const { model: routingModel, credentialId: opaqueCredentialId } = context.routing();
      const attemptOrdinal = ++providerAttemptOrdinal;
      const attemptUsage = observation.usage ?? usageFromProviderResult(observation.result, context.contextWindow)
        ?? (routingModel.contextWindow ? { contextWindow: routingModel.contextWindow } : undefined);
      recordStatisticsEvent(createStatisticsEvent({
        type: 'model.attempt',
        runId: context.runId,
        node: context.nodeId ? { id: context.nodeId } : undefined,
        model: { id: routingModel.id, name: routingModel.displayName || routingModel.name },
        provider: {
          id: routingModel.provider || routingModel.adapter || 'unknown',
          name: routingModel.adapter || routingModel.provider,
        },
        credentialId: opaqueCredentialId,
        attempt: attemptOrdinal,
        invocationId: context.invocationId,
        attemptId: statisticsAttemptId(context.invocationId, attemptOrdinal),
        outcome: observation.outcome,
        durationMs: observation.durationMs,
        // Provider phase == the measured provider/network call for THIS
        // attempt. Nothing is inferred when a boundary is unavailable.
        phases: { provider: observation.durationMs },
        errorClass: observation.outcome === 'error'
          ? classifyStatisticsError(observation.error)
          : undefined,
        // Cache semantics are only claimed for a completed call: a failed or
        // cancelled attempt reports no cache outcome at all.
        cacheOutcome: observation.outcome === 'completed'
          ? statisticsCacheOutcomeFromUsage(attemptUsage)
          : undefined,
        usage: attemptUsage,
      }));
    } catch {
      // Metadata instrumentation is never allowed to affect a provider call.
    }
  };
}
