import type OpenAI from 'openai';
import { createLogger } from '@/utils/logger';
import { RUN_RESOURCE_SCHEME } from '@/shared/types/runResources';
import type { ToolResourceMarker } from '@/backend/services/model/adapters/types';

const log = createLogger('backend/execution/flow/handlers/compactForWire');

/**
 * Wire-only history compaction for request/response adapters (issue: OpenAI-path
 * context bloat). Agentic loops re-send the whole growing message array every
 * turn; a single fat tool result (a file download, a big search dump) then rides
 * along on every subsequent request. Over dozens of tool iterations that is the
 * dominant source of fresh (non-cached) prompt tokens.
 *
 * This runs on the ALREADY-STRIPPED wire view (`toApiMessages` output), right
 * before the adapter call in ModelHandler. It NEVER touches the threaded history
 * persisted in SharedState — only the bytes put on the wire this turn.
 *
 * Design constraints (all non-negotiable):
 *
 *  1. Tool-pair integrity. The OpenAI chat spec requires every assistant
 *     `tool_calls` turn to be followed by a matching `role:"tool"` result, and
 *     rejects a `tool` message with no preceding call. So compaction NEVER drops,
 *     adds, or reorders a message — it only SHRINKS the `content` of messages
 *     that are already on the wire. Same array length, same order, same roles.
 *     (This also keeps the debugger's `sent` set — buildNodeContext — faithful:
 *     which messages reach the model is unchanged; only their size shrinks.)
 *
 *  2. Prefix-cache stability. Re-compacting the whole prefix every turn would
 *     destroy the provider prompt cache — the exact thing keeping cost down. So
 *     the last `keepRecentMessages` are kept verbatim and everything OLDER is
 *     compacted by a deterministic, position-independent rule. An already-
 *     compacted old message produces byte-identical output next turn, so the
 *     stable prefix stays cache-warm; only the one message that crosses the
 *     recent/old boundary each turn changes.
 *
 *  3. Recoverability (no silent data loss). Tier-0 truncation of a tool result
 *     is only performed when the FULL content is still retrievable — i.e. the
 *     result was auto-captured as a run resource (issue #168), so the excerpt
 *     can carry a `flujo://run/...` URI the model dereferences via `read_resource`
 *     (which ModelHandler auto-arms whenever the compacted wire references one).
 *     Without a captured resource, an oversized result is left INLINE unless the
 *     caller opts into lossy truncation. Binary results are already stubbed to
 *     URIs at capture time (capture.ts), so they arrive here small.
 *
 * Two tiers, both pure text transforms (no model call, no store lookup):
 *   - Tier 0: shrink oversized OLD `role:"tool"` results to a head excerpt +
 *     (when captured) a dereferenceable `flujo://run/...` marker.
 *   - Tier 1: drop the assistant's own prose from OLD assistant turns that ALSO
 *     carry tool_calls (the "thinking before the call" — rarely needed once the
 *     tool has run; not tool data, so never resource-backed). The tool_calls
 *     themselves are preserved, so pairing holds.
 */
export interface CompactForWireOptions {
  /** Messages from the end kept verbatim (never compacted). Default 12. */
  keepRecentMessages?: number;
  /** Head chars kept when an old tool result is truncated. Default 2000. */
  toolResultHeadChars?: number;
  /** Drop assistant prose from old assistant turns that also have tool_calls. Default true. */
  dropOldAssistantProse?: boolean;
  /** Whether this model can use the synthetic read_resource tool. Default true. */
  canUseTools?: boolean;
  /**
   * Captured run resources keyed by producing tool_call_id (issue #168). When a
   * truncated tool result has a `.result` entry here, its URI is embedded so the
   * model can read the full content back via `read_resource`. Built by
   * ModelHandler.buildRunResourceMarkers.
   */
  resourceMarkers?: Map<string, ToolResourceMarker>;
  /**
   * Truncate oversized OLD tool results even when NO captured resource backs
   * them (unrecoverable — the tail is discarded). Default false: without a
   * marker the result is left inline rather than silently losing data.
   */
  allowLossyTruncation?: boolean;
  /**
   * Emergency context-overflow fit: ALSO shrink oversized tool results in the
   * RECENT tail, not just old ones (and bypass the "nothing old enough" fast
   * path). Normally the recent tail is kept verbatim for prefix-cache
   * stability, but when a request has already overflowed the model's context
   * window the cache is moot — fitting the request is all that matters. Used
   * by ModelHandler only on the retry after a context-length error. Default
   * false. See ModelHandler.generateCompletion. Tier 1 (old assistant prose)
   * is unaffected — it never touches the recent tail either way.
   */
  compactRecentToolResults?: boolean;
}

const DEFAULTS: Required<Omit<CompactForWireOptions, 'resourceMarkers'>> = {
  keepRecentMessages: 12,
  toolResultHeadChars: 2000,
  dropOldAssistantProse: true,
  canUseTools: true,
  allowLossyTruncation: false,
  compactRecentToolResults: false,
};

/** True when compaction could ever shrink this history; lets callers skip the copy. */
export function couldCompact(
  messages: OpenAI.ChatCompletionMessageParam[],
  opts?: CompactForWireOptions
): boolean {
  const keep = opts?.keepRecentMessages ?? DEFAULTS.keepRecentMessages;
  return messages.length > keep;
}

const AUTO_HYDRATED_MEDIA_PARTS = new Set([
  'image_url',
  'audio_url',
  'video_url',
  'file',
  'input_image',
  'input_audio',
  'input_video',
  'input_file',
]);

/**
 * Find a run-resource URI the model can actually see and pass to
 * `read_resource`. Structured media references are transport handles that are
 * hydrated into provider-native bytes before dispatch, so arming a tool for
 * those alone is both unnecessary and misleading.
 */
function hasModelReadableRunResourceUri(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(RUN_RESOURCE_SCHEME);
  if (Array.isArray(value)) return value.some(hasModelReadableRunResourceUri);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string' && AUTO_HYDRATED_MEDIA_PARTS.has(record.type)) {
    return false;
  }
  return Object.values(record).some(hasModelReadableRunResourceUri);
}

/** True when any model-readable message field references a run-resource URI. */
export function wireHasRunResourceUri(messages: OpenAI.ChatCompletionMessageParam[]): boolean {
  return messages.some(hasModelReadableRunResourceUri);
}

export function compactForWire(
  messages: OpenAI.ChatCompletionMessageParam[],
  opts?: CompactForWireOptions
): OpenAI.ChatCompletionMessageParam[] {
  const { keepRecentMessages, toolResultHeadChars, dropOldAssistantProse, canUseTools, allowLossyTruncation, compactRecentToolResults } = {
    ...DEFAULTS,
    ...opts,
  };
  const resourceMarkers = opts?.resourceMarkers;

  // Nothing old enough to compact: return the input untouched (identity — keeps
  // the fast path allocation-free and the cache prefix byte-identical). Skipped
  // in emergency mode, where even a short history can carry one fat NEW result.
  if (!compactRecentToolResults && messages.length <= keepRecentMessages) return messages;

  const oldCount = messages.length - keepRecentMessages;
  let savedChars = 0;

  const out = messages.map((msg, i) => {
    const isRecent = i >= oldCount;

    // Tier 0: oversized tool results. Tool result content is a string in the
    // OpenAI shape; only touch strings over the head threshold. OLD results are
    // always eligible; RECENT results only in emergency mode (context overflow).
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg.content.length <= toolResultHeadChars) return msg;
      if (isRecent && !compactRecentToolResults) return msg; // recent tail — verbatim

      const uri = resourceMarkers?.get(msg.tool_call_id)?.result?.uri;
      const head = msg.content.slice(0, toolResultHeadChars);
      const total = msg.content.length;
      const dropped = total - toolResultHeadChars;

      if (uri) {
        // Recoverable: point the model at the captured full content, naming the
        // size so it can judge whether reading the rest back is worth it.
        savedChars += dropped;
        return {
          ...msg,
          content:
            canUseTools
              ? `${head}\n…\n[tool result truncated for context — the full ${total}-character result ` +
                `is stored as run resource ${uri}; call read_resource with this uri to read all of it]`
              : `${head}\n…\n[tool result truncated for context — ${total} characters; full content is stored server-side]`,
        };
      }
      if (allowLossyTruncation) {
        savedChars += dropped;
        return { ...msg, content: `${head}\n…[truncated ${dropped} chars]` };
      }
      // No captured resource and lossy not allowed: keep it inline.
      return msg;
    }

    if (isRecent) return msg; // recent tail — verbatim (Tier 1 never touches it)

    // Tier 1: old assistant turn that made tool call(s) — drop its prose, keep
    // the calls. An assistant message with no tool_calls is a real answer/
    // conclusion and is left intact.
    if (
      dropOldAssistantProse &&
      msg.role === 'assistant' &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0 &&
      typeof msg.content === 'string' &&
      msg.content.length > 0
    ) {
      savedChars += msg.content.length;
      // Empty string (not null) — broadest provider compatibility for an
      // assistant turn that carries tool_calls.
      return { ...msg, content: '' };
    }

    return msg;
  });

  if (savedChars > 0) {
    log.debug('compactForWire trimmed history for the wire', {
      messages: messages.length,
      compactedOldest: oldCount,
      keptRecent: keepRecentMessages,
      approxCharsSaved: savedChars,
    });
  }

  return out;
}
