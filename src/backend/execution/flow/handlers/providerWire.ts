// Builds the provider wire for one completion: compaction, limits, tool shaping and image budgets on the wire only.
import { createLogger } from '@/utils/logger';
import { createHash } from 'node:crypto';
import { ModelCallResult } from '../types/modelHandler';
import { FlujoChatMessage } from '@/shared/types/chat';
import { Result } from '../errors';
import { createModelError } from '../errorFactory';
import { toApiMessages } from '../buildNodeContext';
import { compactForWire, couldCompact } from './compactForWire';
import {
  emergencyRefitMessages,
  EMERGENCY_CONTEXT_REFIT_MARKER,
} from './emergencyContextRefit';
import {
  cloneModelInputSnapshot,
  markModelInputMessages,
  recordContextCompaction,
} from './modelInputCompaction';
import OpenAI from 'openai';
import {
  hydrateRunResourceMedia,
  materializeRunResourceMediaPaths,
} from '@/backend/services/model/mediaHandoff';
import { adaptMediaInputsForModel } from '@/backend/services/chatAttachments/modelInput';
import { prepareImageInput } from './prepareImageInput';
import { type Model } from '@/shared/types/model';
import { resolveModelAdapter } from '@/shared/types/model/provider';
import {
  CODEX_EMERGENCY_COMPACTION_MARKER,
  CodexInputLimitError,
  refitCodexMessagesForInputLimit,
} from '@/backend/services/model/adapters/codexInputCompaction';
import { trimTools } from './trimToolBlock';
import {
  writeRunResource,
  listRunResources,
} from '@/backend/services/runResources';
import { parseDataUrl } from '@/backend/services/model/adapters/messageUtils';
import { commitFlowDurableMutation } from '@/backend/execution/flow/executionAuthority';
import { historyKeepRecentMessages, toolDescriptionCap } from './modelHandlerSettings';
import {
  captureOversizedToolResultsForRefit,
  ensureReadResourceArmed,
  estimateOutgoingInputTokens,
  OVERFLOW_TOOL_RESULT_HEAD_CHARS,
  resolveOutgoingInputBudget,
} from './contextWindowFit';
import type { GenerateCompletionOptions } from './modelCompletionContract';

const log = createLogger('backend/flow/execution/handlers/providerWire');

/**
 * Returns true for adapters/providers that require the wire to end with a
 * user or tool role. Anthropic's API (and every proxy that forwards to it,
 * including OpenRouter and Requesty) does NOT support "assistant prefill" —
 * passing a trailing role:"assistant" message causes a 400.
 *
 * OpenAI itself permits a trailing assistant turn for steering (prefill),
 * but only on its own endpoints. We therefore guard on provider identity.
 */
function requiresUserLastMessage(model: { adapter?: string; provider?: string }): boolean {
  return (
    model.adapter === 'anthropic' ||
    model.provider === 'openrouter' ||
    model.provider === 'requesty' ||
    // Anthropic-OpenAI-format endpoint also rejects trailing assistant
    (model.provider === 'anthropic' && model.adapter === 'openai')
  );
}

/** The provider wire one completion sends, with what the attempt and its retries reuse. */
export type PreparedProviderWire = {
  apiMessages: OpenAI.ChatCompletionMessageParam[];
  /** Canonical message id behind each wire message (undefined for injected ones). */
  apiSourceIds: Array<string | undefined>;
  sanitizedTools: OpenAI.ChatCompletionFunctionTool[] | undefined;
  modelInputForArchive: ReturnType<typeof cloneModelInputSnapshot>;
  keepRecentMessages: number;
  inputBudget: number | undefined;
  /** Hydrates and budgets wire images; the overflow retry calls it with a smaller cap. */
  prepareImages: (wire: OpenAI.ChatCompletionMessageParam[], maxImageTokens?: number) => Promise<OpenAI.ChatCompletionMessageParam[]>;
};

/**
 * Builds the provider wire for one completion from the canonical messages:
 * materialized media, provider message rules, text compaction of old
 * content, Codex's input limit, sanitized and trimmed tool schemas, image
 * budgets and the context-window preflight. Only the wire changes; the
 * canonical conversation never does. Returns an error Result when the
 * request cannot fit.
 */
export async function prepareProviderWire(
  modelId: string,
  model: Model,
  messages: FlujoChatMessage[],
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
  opts: GenerateCompletionOptions | undefined,
): Promise<PreparedProviderWire | Result<ModelCallResult>> {
  // Create the request parameters - the adapters expect ChatCompletionMessageParam,
  // not FlujoChatMessage, so strip ALL FLUJO-internal fields (id, timestamp,
  // processNodeId, usage, ...) before sending — strict providers 400 on unknown
  // message fields. Also strips handoff plumbing (the handoff tool-call turn,
  // its result, the synthetic "Continue") from the WIRE view only — the threaded
  // history kept in SharedState is untouched. So a node handed off to sees a
  // clean conversation. See ~/.claude/plans/execution-core-v2.md.
  const messagesWithMaterializedMedia = await Promise.all(messages.map(async (message) => {
    if (!message.media?.length) return message;
    const media = await materializeRunResourceMediaPaths(
      message.media,
      <T>(task: () => Promise<T>) => commitFlowDurableMutation(opts?.durableContext ?? {}, task),
    );
    return media === message.media ? message : { ...message, media };
  }));
  const projectedSourceIndexes: Array<number | undefined> = [];
  const projectedMessages = toApiMessages(messagesWithMaterializedMedia,
    resolveModelAdapter(model.provider, model.adapter) === 'gemini', projectedSourceIndexes);
  // Antigravity CLI rejects unsupported attachments explicitly in its preflight.
  // Filtering them here would turn an image request into text before that
  // check and allow a response from a model that never received the image.
  let apiMessages: OpenAI.ChatCompletionMessageParam[] = resolveModelAdapter(model.provider, model.adapter) === 'antigravity-cli'
    ? projectedMessages
    : await adaptMediaInputsForModel(projectedMessages, model);
  let effectiveTools: OpenAI.ChatCompletionFunctionTool[] | undefined = tools;
  const modelInputForArchive = cloneModelInputSnapshot(opts?.modelInputForArchive);
  const inputSourceIds = opts?.wireMessageIds?.length === messagesWithMaterializedMedia.length
    ? opts.wireMessageIds
    : messagesWithMaterializedMedia.map(message => message.id);
  let apiSourceIds: Array<string | undefined> = projectedSourceIndexes.map(index => (
    index === undefined ? undefined : inputSourceIds[index]
  ));

  // Strip trailing assistant message(s) for providers that require the last
  // message to be user/tool role. This is a wire-only mutation — sharedState is
  // not affected. Trailing assistant turns arise from:
  //   1. scopeMessagesForInput (latest-message mode, settled conversation)
  //   2. stripHandoffPlumbing (handoff prose → plain assistant turn)
  //   3. SubflowNode framed-result push
  if (requiresUserLastMessage(model)) {
    while (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === 'assistant') {
      apiMessages = apiMessages.slice(0, -1);
      apiSourceIds = apiSourceIds.slice(0, -1);
      log.debug('Stripped trailing assistant message for provider that requires user-last wire', {
        provider: model.provider,
        adapter: model.adapter,
      });
    }
  }

  // Wire-only history compaction for request/response adapters. Agentic loops
  // re-send the whole growing history every turn; a single fat tool result
  // then rides along on every subsequent request and dominates fresh (non-
  // cached) prompt tokens. compactForWire shrinks oversized OLD tool results
  // and old assistant prose while keeping the recent tail verbatim and never
  // dropping a message (tool-pair integrity + prefix-cache stability). It
  // runs for every adapter; self-orchestrating adapters flatten this safer
  // generic wire afterward and still benefit from the bounded content.
  const keepRecentMessages = await historyKeepRecentMessages();
  const codexMayResume = model.adapter === 'codex-cli' && opts?.sessionResume && opts.codexSession;
  if (!codexMayResume && !opts?.executionExtensionContext && couldCompact(apiMessages, { keepRecentMessages })) {
    const beforeLosslessRefit = apiMessages;
    const compactedMessages = compactForWire(apiMessages, {
      keepRecentMessages,
      resourceMarkers: opts?.runResourceMarkers,
      // This caller arms read_resource immediately after shortening, even
      // when this step originally offered no other tools.
      canUseTools: true,
    });
    const changedIndexes = compactedMessages
      .map((message, index) => JSON.stringify(message) === JSON.stringify(beforeLosslessRefit[index]) ? -1 : index)
      .filter(index => index >= 0);
    if (changedIndexes.length > 0) {
      markModelInputMessages(
        modelInputForArchive,
        changedIndexes.map(index => apiSourceIds[index]),
        'content-truncated',
        'Old bulky content was shortened on the provider wire; any resource URI in the marker points to the exact source.',
      );
      recordContextCompaction(modelInputForArchive, {
        kind: 'content-truncation',
        reason: 'Old bulky wire content was shortened before dispatch.',
        before: beforeLosslessRefit.length,
        after: compactedMessages.length,
        unit: 'messages',
        truncatedMessages: changedIndexes.length,
        injectedMarker: '[truncated',
      });
    }
    apiMessages = compactedMessages;
    // Truncation embeds a `flujo://run/...` URI when the full result was
    // captured (issue #168). ProcessNode.prep arms `read_resource` by
    // scanning the PRE-compaction wire, so a URI first surfaced HERE would be
    // undereferenceable. Arm it now if compaction introduced a run-resource
    // reference the offered tools don't yet cover.
    effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
  }

  // Codex Exec has a hard aggregate stdin ceiling independent of a model's
  // advertised token window. Enforce it on the final generic wire so the
  // CLI never receives an oversized turn. This is an adapter-specific cap
  // layered on the provider-neutral context policy below.
  if (model.adapter === 'codex-cli' && !codexMayResume) {
    let codexRefit = refitCodexMessagesForInputLimit(apiMessages, {
      resourceMarkers: opts?.runResourceMarkers,
      keepRecentMessages,
    });
    if (codexRefit.capacityExceeded && opts?.conversationId && !opts.executionExtensionContext) {
      // A recent, uncaptured tool result is recoverable once its exact bytes
      // are persisted. The old transport guard ran before this recovery path.
      const markers = await captureOversizedToolResultsForRefit(
        opts.conversationId, apiMessages, opts.runResourceMarkers, opts.nodeId, opts.durableContext,
      );
      opts.runResourceMarkers = markers;
      // Materialize the URI on the wire too: merely teaching Codex's
      // normalizer about a marker would leave read_resource unarmed.
      const capturedMessages = compactForWire(apiMessages, {
        resourceMarkers: markers, canUseTools: true, compactRecentToolResults: true,
        allowLossyTruncation: false, toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
      });
      markModelInputMessages(modelInputForArchive, capturedMessages.flatMap((message, index) =>
        message === apiMessages[index] ? [] : [apiSourceIds[index]]), 'content-truncated',
      'Oversized tool content was stored exactly and replaced with a resource-backed excerpt before Codex dispatch.');
      apiMessages = capturedMessages;
      effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
      codexRefit = refitCodexMessagesForInputLimit(apiMessages, { resourceMarkers: markers, keepRecentMessages });
    }
    if (codexRefit.capacityExceeded) {
      return { success: false, error: createModelError('context_budget_exceeded',
        new CodexInputLimitError(codexRefit.finalCharacters).message,
        modelId, undefined, { inputCharacters: codexRefit.finalCharacters }) };
    }
    if (codexRefit.compacted && !codexRefit.capacityExceeded) {
      const priorSourceIds = apiSourceIds;
      markModelInputMessages(
        modelInputForArchive,
        codexRefit.omittedMessageIndexes.map(index => priorSourceIds[index]),
        'emergency-stripped',
        'Omitted from the Codex wire to stay below Codex Exec\'s hard input-character limit.',
      );
      markModelInputMessages(
        modelInputForArchive,
        codexRefit.truncatedMessageIndexes.map(index => priorSourceIds[index]),
        'content-truncated',
        'Content was explicitly truncated to stay below Codex Exec\'s hard input-character limit.',
      );
      recordContextCompaction(modelInputForArchive, {
        kind: 'emergency-refit',
        reason: 'Codex Exec hard character-limit preflight.',
        before: codexRefit.originalCharacters,
        after: codexRefit.finalCharacters,
        unit: 'characters',
        omittedMessages: codexRefit.omittedMessageIndexes.length,
        truncatedMessages: codexRefit.truncatedMessageIndexes.length,
        injectedMarker: CODEX_EMERGENCY_COMPACTION_MARKER,
      });
      apiMessages = codexRefit.messages;
      apiSourceIds = codexRefit.sourceMessageIndexes.map(index => (
        index === undefined ? undefined : priorSourceIds[index]
      ));
      effectiveTools = ensureReadResourceArmed(apiMessages, effectiveTools);
      log.warn('Refitted Codex input before the CLI hard character limit', {
        modelId,
        beforeCharacters: codexRefit.originalCharacters,
        afterCharacters: codexRefit.finalCharacters,
        omitted: codexRefit.omitted,
      });
    }
  }

  // Sanitize tool schemas for broad provider compatibility (handles string
  // properties with unsupported `format` values, etc.). Done once here so
  // every adapter receives clean tool definitions.
  let sanitizedTools: OpenAI.ChatCompletionFunctionTool[] | undefined;
  if (effectiveTools && effectiveTools.length > 0) {
    const { ToolHandler } = await import('./ToolHandler');
    sanitizedTools = effectiveTools.map(tool => {
      if (tool.type === 'function' && tool.function.parameters) {
        return {
          ...tool,
          function: {
            ...tool.function,
            parameters: ToolHandler.sanitizeSchema(tool.function.parameters)
          }
        };
      }
      return tool;
    });
  }

  // Shrink the serialized tool block. It is the largest fixed cost of a
  // tool-using step and stateless Chat Completions re-sends it on every turn of
  // the agentic loop, so bytes removed here are saved once per turn. Lossless
  // by default (schema bookkeeping keywords, titles that restate the property
  // name, template-literal indentation in descriptions); description CAPPING is
  // applied only when the user opted in via `toolDescriptionMaxChars`. Pure
  // function of its input, so the block stays byte-stable turn to turn (#89).
  if (sanitizedTools && sanitizedTools.length > 0) {
    const descriptionMaxChars = await toolDescriptionCap();
    const { tools: trimmed, beforeChars, afterChars } = trimTools(sanitizedTools, {
      descriptionMaxChars,
    });
    sanitizedTools = trimmed;
    if (afterChars < beforeChars) {
      log.debug('Tool block trimmed before send', {
        beforeChars,
        afterChars,
        savedChars: beforeChars - afterChars,
      });
    }
  }

  // A known context window lets us prevent a bad first request rather than
  // waiting for the provider to reject it. Only wire messages are refitted;
  // the persisted conversation remains unchanged. Models without usable
  // context metadata keep the historical reactive-overflow behavior.
  const inputBudget = resolveOutgoingInputBudget(
    model.contextWindow,
    opts?.maxTokens
  );
  const hasImages = apiMessages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url'));
  if (hasImages && !opts?.executionExtensionContext) {
    sanitizedTools = ensureReadResourceArmed([
      ...apiMessages, { role: 'user', content: 'flujo://run/image/original' },
    ], sanitizedTools);
  }
  const prepareImages = async (wire: OpenAI.ChatCompletionMessageParam[], maxImageTokens?: number) => {
    // The CLI owns its text-only attachment rejection. Do not decode an
    // unsupported image before that authoritative preflight can run.
    if (!hasImages || resolveModelAdapter(model.provider, model.adapter) === 'antigravity-cli') return wire;
    const hydrated = await hydrateRunResourceMedia(wire, opts?.nodeId, {
      strictOpenAiAudioFormats: model.adapter === 'openai' || model.adapter === 'openai-responses',
      commitDurableMutation: task => commitFlowDurableMutation(opts?.durableContext ?? {}, task),
    });
    return prepareImageInput(hydrated, {
      inputBudget, tools: sanitizedTools, model, maxImageTokens, shouldAbort: opts?.shouldAbort,
      preserve: async url => {
        if (maxImageTokens !== undefined) return undefined;
        if (opts?.executionExtensionContext || !opts?.conversationId) return undefined;
        const parsed = parseDataUrl(url);
        if (!parsed) return url.startsWith('flujo://run/') ? url : undefined;
        const name = 'original-image-' + createHash('sha256').update(url).digest('hex');
        const existing = (await listRunResources(opts.conversationId)).find(entry => entry.name === name);
        if (existing) return existing.uri;
        const saved = await commitFlowDurableMutation(opts.durableContext ?? {}, () => writeRunResource({
          conversationId: opts.conversationId!, name, mimeType: parsed.mimeType, kind: 'image',
          data: { base64: parsed.base64 }, producedBy: { source: 'image-input', nodeId: opts.nodeId },
        }));
        return 'skipped' in saved ? undefined : saved.uri;
      },
    });
  };
  apiMessages = await prepareImages(apiMessages);
  if (!opts?.executionExtensionContext) sanitizedTools = ensureReadResourceArmed(apiMessages, sanitizedTools);
  // A persisted Codex thread owns its accumulated context and native
  // compaction. Its adapter validates the compatible delta (or full fresh
  // fallback); measuring the entire transcript here rejects valid resumes.
  if (inputBudget !== undefined && !codexMayResume) {
    if (inputBudget === 0) return {
      success: false,
      error: createModelError('context_budget_exceeded',
        'The configured output limit leaves no room for input in the context window. Lower the output-token limit.', modelId),
    };
    let estimatedInputTokens = estimateOutgoingInputTokens(apiMessages, sanitizedTools, model);
    if (estimatedInputTokens > inputBudget) {
      // A constrained private run cannot introduce resource tools or persist
      // model content while recovering from an oversized provider request.
      if (opts?.executionExtensionContext) {
        return {
          success: false,
          error: createModelError('context_budget_exceeded',
            "The private execution request exceeds the model's context budget.", modelId),
        };
      }
      let budgetMarkers = opts?.runResourceMarkers;
      if (opts?.conversationId) {
        budgetMarkers = await captureOversizedToolResultsForRefit(
          opts.conversationId,
          apiMessages,
          budgetMarkers,
          opts?.nodeId,
          opts?.durableContext,
        );
      }
      const refittedMessages = compactForWire(apiMessages, {
        resourceMarkers: budgetMarkers,
        // The refit ARMS read_resource itself (ensureReadResourceArmed just
        // below), so a `flujo://run/...` marker minted here is always
        // dereferenceable — even for a step that was offered no tools at
        // all. Deriving this from the pre-arming tool list would suppress
        // the URI and make the refit silently unrecoverable (#338).
        canUseTools: true,
        compactRecentToolResults: true,
        toolResultHeadChars: OVERFLOW_TOOL_RESULT_HEAD_CHARS,
      });
      const refitChangedIndexes = refittedMessages
        .map((message, index) => JSON.stringify(message) === JSON.stringify(apiMessages[index]) ? -1 : index)
        .filter(index => index >= 0);
      if (refitChangedIndexes.length > 0) {
        markModelInputMessages(
          modelInputForArchive,
          refitChangedIndexes.map(index => apiSourceIds[index]),
          'content-truncated',
          'Oversized content was shortened to a resource-backed marker during context-budget preflight.',
        );
        recordContextCompaction(modelInputForArchive, {
          kind: 'content-truncation',
          reason: 'Resource-backed context-budget preflight.',
          before: estimatedInputTokens,
          unit: 'tokens',
          truncatedMessages: refitChangedIndexes.length,
          injectedMarker: '[truncated',
        });
      }
      const refittedTools = ensureReadResourceArmed(refittedMessages, sanitizedTools);
      estimatedInputTokens = estimateOutgoingInputTokens(refittedMessages, refittedTools, model);

      if (estimatedInputTokens <= inputBudget) {
        log.warn('Refitted outgoing model request to its advertised input budget', {
          modelId,
          estimatedInputTokens,
          inputBudget,
        });
        apiMessages = refittedMessages;
        sanitizedTools = refittedTools;
      } else {
        const priorSourceIds = apiSourceIds;
        let emergency = emergencyRefitMessages(refittedMessages, {
          target: inputBudget,
          measure: candidate => estimateOutgoingInputTokens(candidate, refittedTools, model),
          keepRecentMessages,
          resourceMarkers: budgetMarkers,
        });
        let emergencyTools = refittedTools;

        // Shed bulky optional schemas while retaining the resource reader
        // needed to recover every archived observation on this wire.
        if (emergency.after > inputBudget && (emergencyTools?.length ?? 0) > 0) {
          emergencyTools = ensureReadResourceArmed(emergency.messages, undefined);
          emergency = emergencyRefitMessages(refittedMessages, {
            target: inputBudget,
            measure: candidate => estimateOutgoingInputTokens(candidate, emergencyTools, model),
            keepRecentMessages,
            resourceMarkers: budgetMarkers,
          });
        }

        if (emergency.after <= inputBudget) {
          markModelInputMessages(
            modelInputForArchive,
            emergency.omittedMessageIndexes.map(index => priorSourceIds[index]),
            'emergency-stripped',
            'Omitted from the provider wire by FLUJO\'s deterministic context-budget safety refit.',
          );
          markModelInputMessages(
            modelInputForArchive,
            emergency.truncatedMessageIndexes.map(index => priorSourceIds[index]),
            'content-truncated',
            'Content was explicitly truncated by FLUJO\'s deterministic context-budget safety refit.',
          );
          recordContextCompaction(modelInputForArchive, {
            kind: 'emergency-refit',
            reason: emergencyTools
              ? 'Advertised model context-window preflight.'
              : 'Advertised model context-window preflight; oversized tool definitions were also withheld for this turn.',
            before: estimatedInputTokens,
            after: emergency.after,
            unit: 'tokens',
            omittedMessages: emergency.omittedMessageIndexes.length,
            truncatedMessages: emergency.truncatedMessageIndexes.length,
            injectedMarker: EMERGENCY_CONTEXT_REFIT_MARKER,
          });
          apiMessages = emergency.messages;
          apiSourceIds = emergency.sourceMessageIndexes.map(index => (
            index === undefined ? undefined : priorSourceIds[index]
          ));
          sanitizedTools = emergencyTools;
          log.warn('Emergency-refitted outgoing request to its advertised input budget', {
            modelId,
            beforeTokens: estimatedInputTokens,
            afterTokens: emergency.after,
            inputBudget,
            omitted: emergency.omitted,
            toolsWithheld: !emergencyTools && Boolean(refittedTools?.length),
          });
        } else {
          return {
            success: false,
            error: createModelError(
              'context_budget_exceeded',
              `Your instructions and unrecoverable tool state cannot fit inside the model's ${inputBudget}-token input budget.`,
              modelId,
              undefined,
              { estimatedInputTokens: emergency.after, inputBudget, contextWindow: model.contextWindow }
            )
          };
        }
      }
    }
  }

  return { apiMessages, apiSourceIds, sanitizedTools, modelInputForArchive, keepRecentMessages, inputBudget, prepareImages };
}
