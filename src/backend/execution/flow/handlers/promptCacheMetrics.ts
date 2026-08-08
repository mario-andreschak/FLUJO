/**
 * promptCacheMetrics.ts — measure provider prompt-cache effectiveness, and
 * attribute misses to a cause.
 *
 * Every stateless Chat Completions turn re-sends tools plus the messages array.
 * Conventional wires put system instructions first; the GPT-5.6 explicit-cache
 * path puts node-specific instructions after an explicitly marked conversation
 * prefix. Providers bill cache re-reads separately, so on a healthy agentic loop
 * `prompt_tokens_details.cached_tokens` should climb after the first turn. When
 * it doesn't, the useful question is WHICH cacheable segment stopped being
 * byte-identical.
 *
 * So this module records a fingerprint of each cacheable prefix segment per
 * conversation and reports, per call, what drifted since the previous call:
 *
 *   drift: 'first'  — no prior call on this conversation, a miss is expected
 *   drift: 'none'   — prefix byte-identical; a low hit ratio here is the
 *                     provider's doing (too-short prefix, cache eviction,
 *                     request routed to a cold machine), not ours
 *   drift: 'tools'  — the tool block changed. Worst case: tools serialize AHEAD
 *                     of everything, so the ENTIRE prefix is invalidated
 *   drift: 'system' — a LEADING system message changed. Everything from that
 *                     message on is fresh; a deliberately late system message
 *                     is outside the explicit cached prefix and is not drift
 *   drift: 'both'
 *
 * Deliberately observation-only: nothing here changes a request. The per-
 * conversation fingerprint map is in-process and bounded, so it costs nothing on
 * a restart beyond one 'first'-classified call.
 */

import { createLogger } from '@/utils/logger';
import type OpenAI from 'openai';

const log = createLogger('backend/flow/execution/handlers/promptCacheMetrics');

/** FNV-1a 32-bit hash, base36-encoded. Stable, dependency-free, edge-safe. */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export type PrefixDrift = 'first' | 'none' | 'tools' | 'system' | 'history' | 'both';

export interface PrefixFingerprint {
  /** Hash of the serialized tool block (undefined when no tools are sent). */
  tools?: string;
  /** Hash of all system-message content (undefined when there is none). */
  system?: string;
  /** Whether every system message is at the beginning or end of the wire. */
  systemPosition?: 'leading' | 'trailing' | 'mixed';
  /** Tool count and serialized length, for a readable log line. */
  toolCount: number;
  toolChars: number;
  /**
   * Per-message hash of the cacheable wire array, in order. Deliberately late
   * system messages are excluded because the explicit breakpoint precedes them.
   *
   * Hashing only tools + system was misleading: FLUJO rewrites the wire history on
   * every turn — compactForWire rewrites old oversized tool results into
   * `flujo://run/...` pointers, collapseNodeOutputs drops other nodes' settled
   * exchanges, scopeMessagesForInput narrows to a node's input mode,
   * stripHandoffPlumbing removes handoff turns — and each of those breaks the
   * prefix from the rewritten message onward. Reporting `drift: 'none'` for those
   * turns hid the single largest source of real cache misses.
   */
  messageHashes: string[];
  /** Total serialized length of the message array. */
  messageChars: number;
}

/** Hash one wire message in the exact shape it is serialized. */
const hashMessage = (m: OpenAI.ChatCompletionMessageParam): string => shortHash(JSON.stringify(m));

/**
 * Fingerprint the cacheable prefix of a request. Everything is hashed in the exact
 * shape it goes on the wire (post-sanitize, post-sort, post-compaction), because
 * that is what the provider hashes.
 */
export function fingerprintPrefix(
  messages: OpenAI.ChatCompletionMessageParam[],
  tools: OpenAI.ChatCompletionFunctionTool[] | undefined,
): PrefixFingerprint {
  const toolJson = tools && tools.length > 0 ? JSON.stringify(tools) : '';
  const systemMessages = messages.filter(message => message.role === 'system');
  const firstNonSystem = messages.findIndex(message => message.role !== 'system');
  const leadingSystemCount = firstNonSystem === -1 ? messages.length : firstNonSystem;
  let trailingSystemCount = 0;
  for (let index = messages.length - 1; index >= 0 && messages[index].role === 'system'; index--) {
    trailingSystemCount++;
  }
  const systemPosition = systemMessages.length === 0
    ? undefined
    : leadingSystemCount === systemMessages.length
      ? 'leading' as const
      : trailingSystemCount === systemMessages.length
        ? 'trailing' as const
        : 'mixed' as const;
  const cacheableMessages = systemPosition === 'trailing'
    ? messages.slice(0, messages.length - trailingSystemCount)
    : messages;
  const systemContent = systemMessages.length > 0
    ? JSON.stringify(systemMessages.map(message => message.content))
    : undefined;

  return {
    ...(toolJson ? { tools: shortHash(toolJson) } : {}),
    ...(systemContent != null ? { system: shortHash(systemContent) } : {}),
    ...(systemPosition ? { systemPosition } : {}),
    toolCount: tools?.length ?? 0,
    toolChars: toolJson.length,
    messageHashes: cacheableMessages.map(hashMessage),
    messageChars: JSON.stringify(messages).length,
  };
}

/**
 * Index of the first message that differs from the previous call, or -1 when one
 * array is a pure prefix of the other.
 *
 * A pure prefix is NOT drift: appending the next turn is exactly what prompt
 * caching absorbs, and trailing truncation (the user-last-message strip) leaves the
 * cached prefix intact too. Only a change at a position both requests share breaks
 * the cache — and it breaks it from that position onward, which is why the index
 * matters more than the boolean.
 */
export function firstDivergentIndex(prev: string[], next: string[]): number {
  const shared = Math.min(prev.length, next.length);
  for (let i = 0; i < shared; i++) {
    if (prev[i] !== next[i]) return i;
  }
  return -1;
}

/**
 * Derive OpenAI's `prompt_cache_key` from the prefix fingerprint.
 *
 * OpenAI's automatic prompt cache is sharded: a lookup only finds a warm entry if
 * the request lands on the machine that holds it, and without a cache key the
 * routing hash is derived from the prompt prefix alone. Supplying a key that is
 * IDENTICAL for every request sharing a prefix — and different otherwise — is what
 * makes routing land consistently.
 *
 * So the key is derived from the tool block, not from the conversation. Two
 * different conversations running the same flow step send the same (large) tool
 * block and should therefore share a warm cache; keying on conversationId would
 * have split them apart and defeated the point. The system message is only used
 * when there are no tools, because it re-renders per turn (resource pills,
 * ${var:}) and would otherwise make the key unstable turn to turn.
 */
export function derivePromptCacheKey(
  fp: PrefixFingerprint,
  options?: { conversationId?: string; preferConversation?: boolean },
): string | undefined {
  if (fp.tools) return `flujo-t${fp.tools}`;
  // With the GPT-5.6 late-instruction strategy, the reusable prefix is the
  // conversation rather than the node-specific system message. Keep no-tool
  // calls for that conversation on one cache shard even as nodes change.
  if (options?.preferConversation && options.conversationId) {
    return `flujo-c${shortHash(options.conversationId)}`;
  }
  if (fp.system) return `flujo-s${fp.system}`;
  return undefined;
}

/**
 * In-process last-fingerprint-per-conversation. Bounded by simple FIFO eviction —
 * this is diagnostics, so losing an old entry only costs one 'first'
 * classification. Keyed by conversation so parallel lanes of the same run that
 * share a conversationId are compared against each other, which is exactly the
 * behaviour we want to see (they SHOULD share a warm prefix).
 */
const MAX_TRACKED_CONVERSATIONS = 200;
const lastPrefix = new Map<string, PrefixFingerprint>();

export interface DriftReport {
  drift: PrefixDrift;
  /**
   * Index of the first message whose bytes changed since the previous call, or -1
   * when the history was only appended to. Deliberately late system instructions
   * are excluded because they occur after the explicit cache boundary.
   */
  divergedAt: number;
  /** How many leading messages were byte-identical, i.e. how far the cache reaches. */
  stableMessages: number;
  totalMessages: number;
}

/** Compare against the previous call on this conversation and record the new one. */
export function classifyDrift(
  conversationId: string | undefined,
  fp: PrefixFingerprint,
): DriftReport {
  const total = fp.messageHashes.length;

  if (!conversationId) {
    return { drift: 'first', divergedAt: -1, stableMessages: 0, totalMessages: total };
  }

  const prev = lastPrefix.get(conversationId);

  // Refresh insertion order so active conversations are not evicted first.
  lastPrefix.delete(conversationId);
  if (lastPrefix.size >= MAX_TRACKED_CONVERSATIONS) {
    const oldest = lastPrefix.keys().next();
    if (!oldest.done) lastPrefix.delete(oldest.value);
  }
  lastPrefix.set(conversationId, fp);

  if (!prev) {
    return { drift: 'first', divergedAt: -1, stableMessages: 0, totalMessages: total };
  }

  const diverged = firstDivergentIndex(prev.messageHashes, fp.messageHashes);
  const stable = diverged === -1 ? Math.min(prev.messageHashes.length, total) : diverged;

  const toolsChanged = prev.tools !== fp.tools;
  const systemChanged =
    prev.system !== fp.system &&
    prev.systemPosition !== 'trailing' &&
    fp.systemPosition !== 'trailing';
  // A rewrite anywhere PAST the system message — compaction, collapse, scope
  // change, handoff strip. Distinguished from 'system' so the two causes can be
  // fixed independently: they need completely different remedies.
  const historyRewritten = diverged > 0;

  const drift: PrefixDrift =
    toolsChanged && (systemChanged || historyRewritten)
      ? 'both'
      : toolsChanged
        ? 'tools'
        : systemChanged
          ? 'system'
          : historyRewritten
            ? 'history'
            : 'none';

  return { drift, divergedAt: diverged, stableMessages: stable, totalMessages: total };
}

/** Drop a conversation's fingerprint (e.g. on delete) — purely housekeeping. */
export function forgetConversationPrefix(conversationId: string): void {
  lastPrefix.delete(conversationId);
}

/** Test seam: reset the in-process fingerprint map. */
export function __resetPrefixTracking(): void {
  lastPrefix.clear();
}

export interface CacheOutcome {
  conversationId?: string;
  nodeId?: string;
  model: string;
  provider?: string;
  adapter?: string;
  promptTokens: number;
  completionTokens: number;
  /** undefined ⇒ the provider does not report caching at all. */
  cachedTokens?: number;
  /** undefined ⇒ the provider does not report cache writes. */
  cacheWriteTokens?: number;
  drift: DriftReport;
  fingerprint: PrefixFingerprint;
}

/**
 * Log one call's cache outcome. Emitted at INFO because this is the number the
 * cost of a long agentic run turns on, and it is one line per model call.
 *
 * `hitRatio` is cached/prompt — the share of input tokens billed at the cached
 * discount. `freshTokens` is what was actually re-read at full price, which is
 * the figure to watch turn over turn.
 */
export function logCacheOutcome(o: CacheOutcome): void {
  const cached = o.cachedTokens;
  const hitRatio =
    cached == null || o.promptTokens === 0
      ? undefined
      : Math.round((cached / o.promptTokens) * 1000) / 1000;

  log.info('prompt-cache', {
    conversationId: o.conversationId,
    nodeId: o.nodeId,
    model: o.model,
    provider: o.provider,
    adapter: o.adapter ?? 'openai',
    promptTokens: o.promptTokens,
    completionTokens: o.completionTokens,
    // null (not undefined) so it survives JSON-serializing log transports and
    // stays distinguishable from "provider reports 0 cached".
    cachedTokens: cached ?? null,
    cacheWriteTokens: o.cacheWriteTokens ?? null,
    freshTokens: cached == null ? o.promptTokens : o.promptTokens - cached,
    hitRatio: hitRatio ?? null,
    // Why the miss, if there was one, and how far the cache still reached.
    prefixDrift: o.drift.drift,
    divergedAt: o.drift.divergedAt,
    stableMessages: o.drift.stableMessages,
    totalMessages: o.drift.totalMessages,
    toolCount: o.fingerprint.toolCount,
    toolChars: o.fingerprint.toolChars,
    messageChars: o.fingerprint.messageChars,
    toolsHash: o.fingerprint.tools ?? null,
    systemHash: o.fingerprint.system ?? null,
  });

  // The cases worth surfacing above debug noise: a tool-block change (full prefix
  // loss, and always a FLUJO bug rather than a provider behaviour), a history
  // rewrite (fixable by narrowing what compaction/collapse touch), and a provider
  // that silently reports no caching at all.
  if (o.drift.drift === 'tools' || o.drift.drift === 'both') {
    log.warn('prompt-cache: tool block changed mid-conversation — full prefix cache miss', {
      conversationId: o.conversationId,
      nodeId: o.nodeId,
      toolCount: o.fingerprint.toolCount,
      toolChars: o.fingerprint.toolChars,
    });
  } else if (o.drift.drift === 'history') {
    log.info('prompt-cache: wire history rewritten — cache lost from that message onward', {
      conversationId: o.conversationId,
      nodeId: o.nodeId,
      divergedAt: o.drift.divergedAt,
      stableMessages: o.drift.stableMessages,
      totalMessages: o.drift.totalMessages,
    });
  } else if (cached == null && o.promptTokens > 1024) {
    log.debug('prompt-cache: provider reported no cached_tokens for a cacheable-size prompt', {
      provider: o.provider,
      model: o.model,
      promptTokens: o.promptTokens,
    });
  }
}
