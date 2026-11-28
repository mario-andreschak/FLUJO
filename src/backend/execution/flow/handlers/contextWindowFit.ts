// Fitting a request into the model's context window: the input budget, overflow detection, and making oversized tool results recoverable before a refit.
import { ExecutionError } from '../errors';
import { wireHasRunResourceUri } from './compactForWire';
import OpenAI from 'openai';
import { estimateWireInputTokens } from './wireTokenEstimate';
import { normalizeMaxTokens, type Model } from '@/shared/types/model';
import { isContextOverflowText } from '@/backend/services/model/adapters/contextOverflow';
import {
  writeRunResource,
  listRunResources,
} from '@/backend/services/runResources';
import { buildReadResourceTool, READ_RESOURCE_TOOL_NAME } from './runResourceTools';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';
import {
  commitFlowDurableMutation,
  rethrowFlowExecutionAuthorityError,
  type FlowDurableMutationContext,
} from '@/backend/execution/flow/executionAuthority';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/handlers/contextWindowFit');

/**
 * Build the resource-aware truncation-marker lookup (issue #168): captured
 * run resources for oversized PRIOR tool results/args, keyed by the producing
 * tool_call_id. Only `tool-result` / `tool-args` captures carry a toolCallId
 * and are relevant here. Best-effort — any failure yields `undefined` and the
 * adapter falls back to plain truncation. The store index is cached, so this
 * is cheap per call.
 */
export async function buildRunResourceMarkers(
  conversationId: string
): Promise<Map<string, ToolResourceMarker> | undefined> {
  try {
    const entries = await listRunResources(conversationId);
    let markers: Map<string, ToolResourceMarker> | undefined;
    for (const entry of entries) {
      const id = entry.producedBy?.toolCallId;
      if (!id) continue;
      const source = entry.producedBy.source;
      if (source !== 'tool-result' && source !== 'tool-args') continue;
      if (!markers) markers = new Map();
      const slot = markers.get(id) ?? {};
      if (source === 'tool-result') slot.result = entry;
      else slot.args = entry;
      markers.set(id, slot);
    }
    return markers;
  } catch (error) {
    log.warn(`Failed to build run-resource markers for conversation ${conversationId}`, error);
    return undefined;
  }
}

/**
 * Head chars kept when an oversized tool result is shrunk on the emergency
 * context-overflow retry (see generateCompletion). Also the threshold above
 * which a result is considered "oversized" for on-the-fly capture, so the two
 * stay consistent: anything the refit will truncate is first made recoverable.
 */
export const OVERFLOW_TOOL_RESULT_HEAD_CHARS = 2000;

/**
 * Guardrail reserved from advertised context windows for provider framing and
 * tokenizer-estimation variance. This is not a tokenizer: payload estimates
 * below are deliberately conservative character-based approximations.
 */
const OUTGOING_INPUT_SAFETY_TOKENS = 4096;

/**
 * Output caps are optional for some adapters. When a model advertises a
 * context window but no cap is configured, reserve this conservative amount
 * instead of assuming that the provider will generate no output.
 */
const UNSPECIFIED_OUTPUT_TOKEN_RESERVE = 8192;

export function resolveOutgoingInputBudget(
  contextWindow: number | undefined,
  maxTokens: number | undefined
): number | undefined {
  if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return undefined;

  const outputReserve = normalizeMaxTokens(maxTokens)
    ?? Math.min(UNSPECIFIED_OUTPUT_TOKEN_RESERVE, Math.floor(contextWindow! / 4));
  const safety = Math.min(OUTGOING_INPUT_SAFETY_TOKENS, Math.floor(contextWindow! / 20));
  const budget = Math.floor(
    (contextWindow as number) - outputReserve - safety
  );
  // A configured window is a hard bound. An impossible output reservation
  // must fail closed, never turn into the "unknown/unbounded" fast path.
  return Math.max(0, budget);
}

/** Estimate the complete provider payload using the same conservative
 * character-based convention as summarizing compaction. */
export function estimateOutgoingInputTokens(
  messages: readonly OpenAI.ChatCompletionMessageParam[],
  tools?: OpenAI.ChatCompletionFunctionTool[],
  model?: Pick<Model, 'provider' | 'adapter' | 'name'>
): number {
  return estimateWireInputTokens(messages, tools, model);
}

/**
 * True when a provider error is a context-window overflow (the request had
 * more prompt tokens than the model accepts), as opposed to any other API
 * failure. Matches the several wordings providers use ("maximum context
 * length", OpenAI's `context_length_exceeded`, OpenRouter's "reduce the
 * length", etc.) across the message, the error code/type, and the raw
 * provider body. Deliberately conservative: only these overflow-specific
 * phrases, so a generic 400 never triggers the (lossy) refit retry.
 */
export function isContextOverflowError(error?: ExecutionError): boolean {
  if (!error || error.type !== 'model') return false;
  const details = (error.details ?? {}) as Record<string, unknown>;
  let providerText = '';
  try {
    providerText = JSON.stringify(details.providerError ?? '');
  } catch {
    /* circular/huge body — the message + code below are enough to decide */
  }
  return isContextOverflowText(
    `${error.message ?? ''} ${String(details.code ?? '')} ${String(details.type ?? '')} ${providerText}`,
  );
}

/**
 * Arm the synthetic `read_resource` tool when the wire references a run
 * resource URI but the offered tools don't yet expose read_resource — so a
 * `flujo://run/...` marker introduced by compaction is actually
 * dereferenceable. Dispatch is by-name (processToolCalls), so a late-added
 * tool still executes. The tool block is re-sorted by name to stay byte-stable
 * turn to turn (prefix cache, #89). Returns the tools unchanged when no arming
 * is needed.
 *
 * SAFETY NET ONLY as of the prefix-cache work: ProcessNode.prep now arms
 * read_resource up front for any step that could ever mint a run-resource URI
 * (MCP tools present, write_resource offered, resource nodes wired, native
 * resources exposed), so by the time compaction can produce a marker the tool
 * is already in the block and this is a no-op. It stays as a backstop for
 * non-ProcessNode callers and for conversations resumed from before that
 * change — but note that when it DOES fire it reshapes the tool block
 * mid-conversation and costs a full prefix-cache miss on that turn.
 */
export function ensureReadResourceArmed(
  apiMessages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined
): OpenAI.ChatCompletionFunctionTool[] | undefined {
  if (
    !wireHasRunResourceUri(apiMessages) ||
    (tools ?? []).some((t) => t.type === 'function' && t.function.name === READ_RESOURCE_TOOL_NAME)
  ) {
    return tools;
  }
  const def = buildReadResourceTool();
  const readTool: OpenAI.ChatCompletionFunctionTool = {
    type: 'function',
    function: {
      name: def.name,
      description: def.description || `Tool: ${def.name}`,
      parameters: def.inputSchema as Record<string, unknown>,
    },
  };
  return [...(tools ?? []), readTool].sort((a, b) =>
    a.type === 'function' && b.type === 'function'
      ? a.function.name < b.function.name
        ? -1
        : a.function.name > b.function.name
          ? 1
          : 0
      : 0
  );
}

/**
 * Emergency context-overflow recovery: make every oversized tool result on
 * the wire recoverable so it can be shrunk to a dereferenceable
 * `flujo://run/...` URI on the retry. Any oversized result whose tool_call_id
 * is NOT already backed by a captured resource is written to the run-resource
 * store on the fly and added to a fresh (augmented) markers map — so it can be
 * read back with `read_resource` instead of being lossily discarded. This
 * covers results that auto-capture missed (disabled, or produced before the
 * setting was on). Best-effort: any store failure just leaves that result
 * unmarked (it will be lossily truncated). Returns the markers map to use for
 * the refit.
 */
export async function captureOversizedToolResultsForRefit(
  conversationId: string,
  apiMessages: OpenAI.ChatCompletionMessageParam[],
  existing: Map<string, ToolResourceMarker> | undefined,
  nodeId?: string,
  durableContext: FlowDurableMutationContext = {},
): Promise<Map<string, ToolResourceMarker> | undefined> {
  let markers: Map<string, ToolResourceMarker> | undefined = existing ? new Map(existing) : undefined;
  for (const msg of apiMessages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (msg.content.length <= OVERFLOW_TOOL_RESULT_HEAD_CHARS) continue;
    const callId = msg.tool_call_id;
    if (markers?.get(callId)?.result?.uri) continue; // already recoverable
    const content = msg.content;
    try {
      const written = await commitFlowDurableMutation(durableContext, () => writeRunResource({
          conversationId,
          mimeType: 'text/plain',
          kind: 'text',
          data: { text: content },
          producedBy: { source: 'tool-result', nodeId, toolCallId: callId },
        }),
      );
      if ('skipped' in written) {
        log.warn(`Emergency capture of oversized tool result skipped (${written.skipped}); it will be lossily truncated`);
        continue;
      }
      if (!markers) markers = new Map();
      const slot = markers.get(callId) ?? {};
      slot.result = written;
      markers.set(callId, slot);
    } catch (error) {
      rethrowFlowExecutionAuthorityError(error);
      log.warn('Emergency capture of oversized tool result failed; it will be lossily truncated', error);
    }
  }
  return markers;
}
