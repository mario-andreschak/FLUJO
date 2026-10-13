/**
 * Per-(conversation, node) Claude Agent SDK session registry (issue #154).
 *
 * BACKGROUND. By default the Claude Subscription adapter spawns a fresh
 * `query()` (a new `claude` subprocess, no `resume`) for every node call and
 * re-sends the ENTIRE prior conversation flattened into one user message (see
 * `buildUserMessage` in claudeSubscriptionAdapter.ts). Only the `systemPrompt` +
 * tool definitions form a cacheable prefix, so cumulative input grows ~O(n^2)
 * with conversation length. The efficient fix is to REUSE the SDK session across
 * turns of the same single-node Flow via the SDK's `resume` option
 * (`options.resume?: string` loads a persisted session's history) and send only
 * the per-turn delta. That fix is now wired through this registry and gated by
 * the experimental `claudeSessionResume` setting.
 *
 * WHY A REGISTRY. A session is only safe to resume while the reusable prefix is
 * stable: each Process/MCP node has its OWN systemPrompt + tool set, so the key
 * must be `(conversationId, nodeId)`, and the entry must be invalidated the
 * moment the resolved system prompt or tool list changes, or the client-side
 * conversation history is pruned/diverges from what the session last saw, or the
 * run errors / hands off (each starts fresh context).
 *
 * SCOPE OF THIS MODULE. A PURE, in-process registry holding the keying +
 * invalidation decision logic, fully unit tested. The adapter both READS it (to
 * decide whether to `resume` this turn) and WRITES it (recording the captured
 * session id + watermark after a successful run). The actual send-path behaviour
 * change lives in the adapter and is gated by the experimental
 * `claudeSessionResume` setting; this module stays behaviour-agnostic.
 */

import { createHash } from 'crypto';
import { getCurrentWorkspace } from '@/utils/workspace';
import { MESSAGE_NORMALIZATION_POLICY_VERSION } from './messageNormalization';

/** A session the adapter may be able to resume on a later turn. */
export interface StoredSession {
  /** SDK session UUID captured from the run's system/result messages. */
  sessionId: string;
  /** Hash of the reusable prefix (systemPrompt + tool set) the session was built with. */
  prefixHash: string;
  /**
   * How many conversation messages the session's persisted history reflects —
   * the run's INPUT messages PLUS everything the SDK generated that turn (which
   * the caller appends to the conversation verbatim). The next turn's delta is
   * exactly `messages.slice(seenMessageCount)`. Also used to detect divergence:
   * a current history SHORTER than this means the client pruned/reset it, so the
   * session can no longer be safely resumed.
   */
  seenMessageCount: number;
  /** Number of contiguous leading system messages when this watermark was recorded. */
  leadingSystemMessageCount: number;
  /** Last time this entry was written (for TTL/eviction bookkeeping). */
  updatedAt: number;
}

/** Details needed to record/refresh a session entry. */
export interface SessionObservation {
  sessionId: string;
  prefixHash: string;
  seenMessageCount: number;
  leadingSystemMessageCount: number;
}

// Process-memory registry, keyed by `${conversationId}::${nodeId}`. Mirrors the
// existing global-map pattern used elsewhere in the backend (e.g. the MCP
// clients map). One entry per (conversation, node); overwritten in place, so it
// stays small. Entries are dropped on error/handoff/divergence (see below); a
// broader end-of-conversation eviction is a Phase-1 follow-up.
const sessionsByWorkspace = new Map<string, Map<string, StoredSession>>();

function sessions(): Map<string, StoredSession> {
  const workspace = getCurrentWorkspace();
  let value = sessionsByWorkspace.get(workspace);
  if (!value) {
    value = new Map();
    sessionsByWorkspace.set(workspace, value);
  }
  return value;
}

/** Stable registry key for a conversation's node. */
export function sessionKey(conversationId: string, nodeId: string): string {
  return `${conversationId}::${nodeId}`;
}

/**
 * Hash the reusable prefix: the system prompt plus the node's tool set. Tool
 * names are sorted so the hash is order-independent — the same tools in any
 * order describe the same reusable session (prefix byte-stability for caching is
 * a separate concern handled at send time). Any change to the system prompt or
 * the set of tools yields a different hash, which invalidates reuse.
 */
export function computePrefixHash(
  systemPrompt: string | undefined,
  toolNames: readonly string[],
): string {
  const h = createHash('sha256');
  h.update('projection\0');
  h.update(MESSAGE_NORMALIZATION_POLICY_VERSION);
  h.update('\0');
  h.update('sys\0');
  h.update(systemPrompt ?? '');
  h.update('\0tools\0');
  for (const name of [...toolNames].sort()) {
    h.update(name);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Return a session that can be safely resumed for this call, or `undefined` when
 * the caller must fall back to a fresh full-flatten run. Reuse is allowed only
 * when an entry exists AND its prefix still matches AND the current conversation
 * is not shorter than what the session last saw (a shorter history means the
 * client pruned/reset it, so the persisted session would diverge), and the
 * contiguous leading system-message count has not changed. The latter protects
 * the positional watermark from future context transformations that alter the
 * message-array head. Entries missing this metadata are treated as stale.
 */
export function findReusableSession(
  key: string,
  prefixHash: string,
  currentMessageCount: number,
  currentLeadingSystemMessageCount: number,
): StoredSession | undefined {
  const existing = sessions().get(key);
  if (!existing) return undefined;
  if (existing.prefixHash !== prefixHash) return undefined;
  if (existing.leadingSystemMessageCount === undefined) return undefined;
  if (existing.leadingSystemMessageCount !== currentLeadingSystemMessageCount) return undefined;
  if (currentMessageCount < existing.seenMessageCount) return undefined;
  return existing;
}

/** Record (or refresh) the session for a key after a successful run. */
export function recordSession(key: string, observation: SessionObservation): void {
  sessions().set(key, { ...observation, updatedAt: Date.now() });
}

/** Drop the session for a key (on error, handoff, or detected divergence). */
export function invalidateSession(key: string): void {
  sessions().delete(key);
}

/** Current number of tracked sessions (diagnostics/tests). */
export function sessionCount(): number {
  return sessions().size;
}

/** Test-only: clear the whole registry between cases. */
export function _clearAllSessionsForTests(): void {
  sessions().clear();
}
