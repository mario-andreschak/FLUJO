// One smaller retry wire after a provider rejected a request for context length.
import { createLogger } from '@/utils/logger';
import { compactForWire } from './compactForWire';
import {
  emergencyRefitMessages,
  EMERGENCY_CONTEXT_REFIT_MARKER,
} from './emergencyContextRefit';
import { markModelInputMessages, recordContextCompaction } from './modelInputCompaction';
import { imageTokens } from './wireTokenEstimate';
import { type Model } from '@/shared/types/model';
import { archiveContextForRefit } from './archiveContextForRefit';
import { assertFlowExecutionCurrent, rethrowFlowExecutionAuthorityError } from '@/backend/execution/flow/executionAuthority';
import {
  captureOversizedToolResultsForRefit,
  ensureReadResourceArmed,
  estimateOutgoingInputTokens,
  OVERFLOW_TOOL_RESULT_HEAD_CHARS,
} from './contextWindowFit';
import type { GenerateCompletionOptions } from './modelCompletionContract';
import type { PreparedProviderWire } from './providerWire';

const log = createLogger('backend/flow/execution/handlers/contextOverflowRetry');

/** The rejected wire and what the first preparation produced for it. */
export type ContextOverflowRefitInput = Pick<PreparedProviderWire,
  'apiMessages' | 'apiSourceIds' | 'sanitizedTools' | 'modelInputForArchive'
  | 'keepRecentMessages' | 'inputBudget' | 'prepareImages'> & {
  modelId: string;
  model: Model;
  opts: GenerateCompletionOptions | undefined;
};

/**
 * After a provider rejected a request as too long, builds one materially
 * smaller retry wire: every oversized tool result (recent ones included)
 * becomes a resource-backed excerpt, images get a smaller budget, and the
 * structurally safe emergency refit runs when that is still not enough.
 * Undefined when nothing on the wire can shrink; the caller then keeps the
 * provider's error.
 */
export async function refitWireAfterContextOverflow(
  input: ContextOverflowRefitInput,
): Promise<Pick<PreparedProviderWire, 'apiMessages' | 'apiSourceIds' | 'sanitizedTools'> | undefined> {
  const {
    modelId, model, opts, apiMessages, apiSourceIds, sanitizedTools, modelInputForArchive,
    keepRecentMessages, inputBudget, prepareImages,
  } = input;
  const beforeChars = JSON.stringify(apiMessages).length;
  let refitMarkers = opts?.runResourceMarkers;
  if (opts?.conversationId) {
    await assertFlowExecutionCurrent(opts.durableContext ?? {});
    refitMarkers = await captureOversizedToolResultsForRefit(
      opts.conversationId,
      apiMessages,
      refitMarkers,
      opts?.nodeId,
      opts?.durableContext,
    );
  }
  const refitMessages = compactForWire(apiMessages, {
    resourceMarkers: refitMarkers,
    // Same as the proactive refit above: read_resource is armed on the
    // retry, so the URI marker must be emitted regardless of how many
    // tools the original request carried (#338).
    canUseTools: true,
    compactRecentToolResults: true,
    allowLossyTruncation: false,
    toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
  });
  const reactiveChangedIndexes = refitMessages
    .map((message, index) => JSON.stringify(message) === JSON.stringify(apiMessages[index]) ? -1 : index)
    .filter(index => index >= 0);
  if (reactiveChangedIndexes.length > 0) {
    markModelInputMessages(
      modelInputForArchive,
      reactiveChangedIndexes.map(index => apiSourceIds[index]),
      'content-truncated',
      'Oversized content was shortened to a resource-backed marker after a provider context-length rejection.',
    );
    recordContextCompaction(modelInputForArchive, {
      kind: 'content-truncation',
      reason: 'One automatic retry after provider context rejection.',
      before: estimateOutgoingInputTokens(apiMessages, sanitizedTools, model),
      unit: 'tokens',
      truncatedMessages: reactiveChangedIndexes.length,
      injectedMarker: '[truncated',
    });
  }
  // A fixed 8192-token image cap cannot shrink an image already below
  // that cap. Provider tokenization may still reject that image (notably
  // on small windows); reduce its current pixel budget on the retry.
  const rejectedImageCosts = refitMessages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url')
      .map(part => imageTokens(part.image_url.url, part.image_url.detail)) : []);
  const retryImageTokens = rejectedImageCosts.length
    ? Math.max(1, Math.floor(rejectedImageCosts.reduce((least, cost) => Math.min(least, cost), 16384) / 2)) : 8192;
  let retryMessages = await prepareImages(refitMessages, retryImageTokens);
  let retryTools = ensureReadResourceArmed(refitMessages, sanitizedTools);
  // The provider has just said the request is too long, so the retry must
  // be materially smaller even when the catalogue window says it fits.
  const retryTarget = Math.min(inputBudget ?? Infinity, Math.max(
    1,
    Math.floor(estimateOutgoingInputTokens(apiMessages, sanitizedTools, model) * 0.7),
  ));
  let retryEstimate = estimateOutgoingInputTokens(retryMessages, retryTools, model);
  const priorSourceIds = apiSourceIds;
  let retrySourceIds = apiSourceIds;
  if (retryEstimate > retryTarget) {
    // Omitted decisions stay searchable. Without the archive the retry
    // keeps today's behaviour: canonical history is unchanged either way.
    let sourceArchiveUri: string | undefined;
    try {
      sourceArchiveUri = await archiveContextForRefit(
        apiMessages, apiSourceIds, opts?.conversationId, opts?.nodeId, opts?.durableContext,
      );
    } catch (error) {
      rethrowFlowExecutionAuthorityError(error);
      log.warn('Could not archive the rejected request before the smaller retry; retrying without it', { error });
    }
    if (sourceArchiveUri) {
      retryTools = ensureReadResourceArmed([{ role: 'assistant', content: sourceArchiveUri }], retryTools);
    }
    let emergency = emergencyRefitMessages(retryMessages, {
      target: retryTarget,
      measure: candidate => estimateOutgoingInputTokens(candidate, retryTools, model),
      keepRecentMessages,
      resourceMarkers: refitMarkers,
      sourceArchiveUri,
    });
    if (emergency.after > retryTarget && (retryTools?.length ?? 0) > 0) {
      retryTools = ensureReadResourceArmed(emergency.messages, undefined);
      emergency = emergencyRefitMessages(retryMessages, {
        target: retryTarget,
        measure: candidate => estimateOutgoingInputTokens(candidate, retryTools, model),
        keepRecentMessages,
        resourceMarkers: refitMarkers,
        sourceArchiveUri,
      });
    }
    if (emergency.after <= retryTarget) {
      markModelInputMessages(
        modelInputForArchive,
        emergency.omittedMessageIndexes.map(index => priorSourceIds[index]),
        'emergency-stripped',
        'Omitted from the retry wire after the provider rejected the original request for context length.',
      );
      markModelInputMessages(
        modelInputForArchive,
        emergency.truncatedMessageIndexes.map(index => priorSourceIds[index]),
        'content-truncated',
        'Content was explicitly truncated on the retry after a provider context-length rejection.',
      );
      recordContextCompaction(modelInputForArchive, {
        kind: 'emergency-refit',
        reason: 'One automatic retry after a provider context-length rejection.',
        before: estimateOutgoingInputTokens(apiMessages, sanitizedTools),
        after: emergency.after,
        unit: 'tokens',
        omittedMessages: emergency.omittedMessageIndexes.length,
        truncatedMessages: emergency.truncatedMessageIndexes.length,
        injectedMarker: EMERGENCY_CONTEXT_REFIT_MARKER,
      });
      retryMessages = emergency.messages;
      retrySourceIds = emergency.sourceMessageIndexes.map(index => (
        index === undefined ? undefined : priorSourceIds[index]
      ));
      retryEstimate = emergency.after;
    }
  }
  const afterChars = JSON.stringify(retryMessages).length;
  if (afterChars < beforeChars && retryEstimate <= retryTarget) {
    log.warn('Context-length overflow; retrying once with a compacted provider wire', {
      modelId,
      beforeChars,
      afterChars,
      retryEstimate,
      retryTarget,
    });
    try {
      opts?.onFinalWire?.(retryMessages, modelInputForArchive);
    } catch (error) {
      log.warn('Final-wire observer failed during overflow refit; continuing retry', { error });
    }
    return { apiMessages: retryMessages, apiSourceIds: retrySourceIds, sanitizedTools: retryTools };
  }
  log.warn('Context-length overflow but nothing on the wire left to compact; returning the original error', { modelId });
  return undefined;
}
