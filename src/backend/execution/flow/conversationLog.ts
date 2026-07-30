import { promises as fs, readFileSync } from 'fs';
import path from 'path';
import {
  ExecutionEvent,
  ExecutionEventType,
  RawExecutionEvent,
} from '@/shared/types/execution/events';
import { FlujoChatMessage } from '@/shared/types/chat';
import { SharedState } from './types';
import { isConversationDeleted } from './cancellation';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';

const log = createLogger('backend/execution/flow/conversationLog');

/**
 * Append-only per-conversation event log — the persistence half of the
 * conversation-as-projection model (execution-core v2, Phase 3).
 *
 * One JSONL file per conversation under db/conversation-logs/. Every persisted
 * step is an APPEND of one line instead of a rewrite of the whole conversation
 * JSON, and the displayed conversation is a pure projection of the log (see
 * projectMessages). The live SSE stream and this log are the same events: the
 * ExecutionEventBus taps every emit into appendFromBus, so "the live stream is
 * the log being appended".
 *
 * Ordering is FILE ORDER, and (since issue #261) `seq` is AUTHORITATIVE and
 * MONOTONIC: the log allocates the per-conversation sequence number itself (see
 * allocateSeq), so it is durable, never reset between runs, survives channel
 * garbage-collection and process restarts, and is stamped on log-only events
 * too (no more seq -1). Append order equals seq order, so a persisted `seq` is
 * a valid resume cursor for the SSE stream. Readers may still project by file
 * order (the two agree); consumers MAY now sort by / resume from seq.
 */

// Event types worth persisting. Excluded on purpose:
//  - model:start/delta/end — streaming noise; the final content arrives as a
//    'message' event anyway.
//  - tool:progress — same: live liveness ticks during a long tool call; the
//    outcome arrives as tool:result.
//  - run:paused / run:awaiting_approval / breakpoint:hit — transient control
//    signals for live subscribers; they describe the run's momentary state,
//    not the conversation.
const PERSISTED_EVENT_TYPES: ReadonlySet<ExecutionEventType> = new Set<ExecutionEventType>([
  'run:start',
  'run:done',
  'node:enter',
  'node:exit',
  'node:snapshot',
  'node:changed-files',
  'handoff',
  'message',
  'message:removed',
  'tool:call',
  'tool:result',
  'usage',
  'subflow:start',
  'subflow:done',
  'resource:read',
  'resource:write',
  'error',
]);

// Conversation ids are UUIDs; anything else (path separators, dots) is refused
// so a hostile id can never escape the log directory.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

let logDir = path.join(getDataDir(), 'db', 'conversation-logs');

/** Test seam: point the store at a temp directory. Returns the previous dir. */
export function _setConversationLogDirForTests(dir: string): string {
  const previous = logDir;
  logDir = dir;
  // Counters are seeded from the store on cold start; switching stores must
  // re-seed from the new directory rather than reuse a stale counter.
  nextSeq.clear();
  return previous;
}

function logFilePath(conversationId: string): string {
  return path.join(logDir, `${conversationId}.jsonl`);
}

// Per-conversation append chains so concurrent appends for the same log never
// interleave (mirrors saveItem's writeChains). Different conversations still
// append concurrently.
const appendChains = new Map<string, Promise<unknown>>();

// --- Authoritative per-conversation sequence (issue #261) --------------------
// The JSONL file is the source of truth for ordering, so the LOG allocates the
// event `seq`: a durable, per-conversation, never-reset monotonic counter. Both
// the bus (ExecutionEventBus.emit) and the log-only append paths draw the seq
// they persist from here (allocateSeq), so the number written to disk — and
// used as an SSE resume cursor — is authoritative and strictly increasing
// across runs, channel garbage-collection, and process restarts.
//
// In-memory: Map<conversationId, nextSeq>. Cold-start (first allocation for a
// conversation this process has not seen, e.g. after restart) seeds the counter
// by tail-reading the existing .jsonl and resuming at max(seq)+1, ignoring
// legacy sentinel/non-numeric values — so pre-#261 logs are tolerated, never
// rewritten. The counter then stays in memory for the process lifetime.
const nextSeq = new Map<string, number>();

/** Cold-start init of the durable counter from the persisted log tail. Runs at
 *  most once per conversation per process; a one-time synchronous read keeps
 *  allocateSeq usable from the bus's synchronous emit path. */
function initSeqIfNeeded(conversationId: string): void {
  if (nextSeq.has(conversationId)) return;
  let max = -1;
  try {
    const content = readFileSync(logFilePath(conversationId), 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq;
        if (typeof seq === 'number' && Number.isFinite(seq) && seq > max) max = seq;
      } catch {
        /* skip a truncated/garbled tail line */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Could not read conversation log ${conversationId} to seed seq; starting at 0.`, { err });
    }
  }
  nextSeq.set(conversationId, max + 1);
}

/**
 * Allocate the next authoritative monotonic seq for a conversation. Synchronous
 * (safe from the bus's emit path); the returned value is strictly greater than
 * every previously allocated/persisted seq for this conversation this process
 * lifetime, seeded from disk on cold start.
 */
export function allocateSeq(conversationId: string): number {
  initSeqIfNeeded(conversationId);
  const seq = nextSeq.get(conversationId)!;
  nextSeq.set(conversationId, seq + 1);
  return seq;
}

/**
 * Highest authoritative seq allocated/persisted for a conversation, or -1 when
 * nothing exists yet. Seeds from disk on cold start. Callers that must observe
 * in-flight bus-tap appends should flushConversationLog() first.
 */
export async function latestSequence(conversationId: string): Promise<number> {
  if (!SAFE_ID.test(conversationId)) return -1;
  initSeqIfNeeded(conversationId);
  return nextSeq.get(conversationId)! - 1;
}

function chainAppend(conversationId: string, lines: string): Promise<void> {
  const previous = appendChains.get(conversationId) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior append's error was logged by its own caller */ })
    .then(async () => {
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(logFilePath(conversationId), lines);
    });
  appendChains.set(conversationId, run);
  return run.finally(() => {
    if (appendChains.get(conversationId) === run) {
      appendChains.delete(conversationId);
    }
  }) as Promise<void>;
}

// Truncating rewrite of a whole log, serialized through the SAME per-conversation
// chain as appends so it never interleaves with an in-flight append. Used only
// by the self-heal repair (repairTruncatedConversationLog) to replace a log that
// lost events with one rebuilt from the authoritative SharedState snapshot.
function chainWrite(conversationId: string, content: string): Promise<void> {
  const previous = appendChains.get(conversationId) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* prior op's error was logged by its own caller */ })
    .then(async () => {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logFilePath(conversationId), content);
    });
  appendChains.set(conversationId, run);
  return run.finally(() => {
    if (appendChains.get(conversationId) === run) {
      appendChains.delete(conversationId);
    }
  }) as Promise<void>;
}

/**
 * Is this conversation allowed to persist a log? The ephemeral policy travels
 * ON the state (see persistConversationState): a state marked `ephemeral`
 * (subflow child runs, scheduler runs) must never leave anything on disk. When
 * the state is unknown (not in the executor's map) we REFUSE — the safe
 * default, since every legitimate emitter has the state registered before it
 * emits (runFlow registers it before run:start; control routes load it first).
 */
function isPersistable(conversationId: string): boolean {
  try {
    // A deleted conversation's in-flight run keeps emitting until its next
    // cancellation check; those events must not re-create the just-deleted log.
    if (isConversationDeleted(conversationId)) return false;
    // Lazy require to avoid a static import cycle (FlowExecutor → engine →
    // nodes → handlers → executionEventBus → this module).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
    const state: SharedState | undefined = FlowExecutor.conversationStates.get(conversationId);
    if (!state) return false;
    return !state.ephemeral;
  } catch (err) {
    log.warn(`Could not resolve persistence policy for ${conversationId}; not persisting.`, { err });
    return false;
  }
}

function serialize(event: ExecutionEvent): string {
  // One event per line. `emit` callbacks or other functions never appear on
  // events, so plain JSON.stringify is safe.
  return `${JSON.stringify(event)}\n`;
}

/**
 * Bus tap: persist a just-emitted (stamped) event to its conversation's log.
 * Fire-and-forget by design — a disk hiccup must never break the live stream.
 * Applies the persisted-type filter and the ephemeral policy.
 */
export function appendFromBus(event: ExecutionEvent): void {
  if (!PERSISTED_EVENT_TYPES.has(event.type)) return;
  if (!SAFE_ID.test(event.conversationId)) {
    log.warn(`Refusing to log event for unsafe conversation id`, { conversationId: event.conversationId });
    return;
  }
  if (!isPersistable(event.conversationId)) return;
  void chainAppend(event.conversationId, serialize(event)).catch((err) =>
    log.warn(`Failed to append event to conversation log ${event.conversationId}`, { err })
  );
}

/**
 * Direct append of log-only events for a run whose state we hold (turn-start
 * reconcile, incremental streamed-message persistence). These never touch the
 * live bus, so they are stamped here with a freshly allocated authoritative
 * seq (issue #261 — no more seq -1), drawn from the same durable per-conversation
 * counter as bus events. The ephemeral policy is checked on the state itself.
 * Awaitable so callers that need durability (reconcile before a run) can wait;
 * errors are logged, not thrown.
 */
export async function appendRawForState(state: SharedState, raws: RawExecutionEvent[]): Promise<void> {
  if (raws.length === 0) return;
  if (state.ephemeral) return;
  const conversationId = state.conversationId;
  if (!conversationId || !SAFE_ID.test(conversationId)) return;
  if (isConversationDeleted(conversationId)) return;
  const lines = raws
    .map((raw) => serialize({ ...raw, conversationId, seq: allocateSeq(conversationId), timestamp: Date.now() } as ExecutionEvent))
    .join('');
  try {
    await chainAppend(conversationId, lines);
  } catch (err) {
    log.warn(`Failed to append ${raws.length} event(s) to conversation log ${conversationId}`, { err });
  }
}

/**
 * Wait for this conversation's in-flight appends (as of the call) to reach
 * disk. Appends from the bus tap are fire-and-forget; readers that must
 * observe them (projection reads, tests) can flush first. Never rejects.
 */
export function flushConversationLog(conversationId: string): Promise<void> {
  const pending = appendChains.get(conversationId);
  return pending ? pending.then(() => undefined, () => undefined) : Promise.resolve();
}

/**
 * Read a conversation's full event log, in file (= append) order. Returns
 * undefined when no log exists (legacy conversation, or nothing persisted
 * yet) so callers can fall back to the SharedState messages. Unparseable
 * lines — e.g. a tail truncated by a crash mid-append — are skipped.
 */
export async function readConversationLog(conversationId: string): Promise<ExecutionEvent[] | undefined> {
  if (!SAFE_ID.test(conversationId)) return undefined;
  let content: string;
  try {
    content = await fs.readFile(logFilePath(conversationId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.error(`Error reading conversation log ${conversationId}:`, error);
    return undefined;
  }
  const events: ExecutionEvent[] = [];
  let skipped = 0;
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as ExecutionEvent);
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    log.warn(`Skipped ${skipped} unparseable line(s) in conversation log ${conversationId} (truncated append?)`);
  }
  return events;
}

/** Remove a conversation's log file (conversation deletion). Idempotent. */
export async function deleteConversationLog(conversationId: string): Promise<void> {
  if (!SAFE_ID.test(conversationId)) return;
  try {
    await fs.unlink(logFilePath(conversationId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Error deleting conversation log ${conversationId}:`, error);
    }
  }
}

/**
 * Project a conversation's displayed messages from its event log.
 *
 * Pure fold over 'message' / 'message:removed' events:
 *  - upsert by message id — a message that appears again (streamed live then
 *    materialized at end of step, or edited via edit-state) REPLACES the
 *    earlier copy in place, matching upsertMessageById semantics;
 *  - system-role messages are never part of the displayed conversation (a
 *    node's system prompt is model plumbing);
 *  - subflow child messages (event depth > 0) are inlined in order, tagged
 *    with `depth` for nested display — they are display-only and never part
 *    of the parent's model context;
 *  - 'message:removed' deletes (the chat client prunes/disables messages and
 *    sends the reduced history; the turn-start reconcile records removals).
 */
export function projectMessages(events: ExecutionEvent[]): FlujoChatMessage[] {
  const messages: FlujoChatMessage[] = [];
  const indexById = new Map<string, number>();
  // The first Codex live-streaming release used SDK-local ids such as
  // `stream_codex_item_0`. Codex restarts that numbering on later model calls,
  // so distinct durable messages written during that release can share an id.
  // New messages carry a per-call namespace; preserve every legacy collision
  // here so old conversations recover on their next detail fetch.
  const legacyCodexIdOccurrences = new Map<string, number>();

  for (const event of events) {
    if (event.type === 'message') {
      const incoming = event.message;
      if (!incoming || !incoming.id) continue;
      if (incoming.role === 'system') continue;
      const depth = event.depth ?? 0;
      let projectedId = incoming.id;
      let existingIndex = indexById.get(projectedId);
      if (existingIndex !== undefined && /^stream_codex_item_/.test(projectedId)) {
        const occurrence = (legacyCodexIdOccurrences.get(projectedId) ?? 1) + 1;
        legacyCodexIdOccurrences.set(projectedId, occurrence);
        projectedId = `${projectedId}_legacy_${occurrence}`;
        existingIndex = undefined;
      } else if (!legacyCodexIdOccurrences.has(projectedId)) {
        legacyCodexIdOccurrences.set(projectedId, 1);
      }
      const withRecoveredId =
        projectedId === incoming.id ? incoming : { ...incoming, id: projectedId };
      const projected: FlujoChatMessage =
        depth > 0 ? { ...withRecoveredId, depth } : { ...withRecoveredId };
      if (existingIndex !== undefined) {
        messages[existingIndex] = projected;
      } else {
        indexById.set(projectedId, messages.length);
        messages.push(projected);
      }
    } else if (event.type === 'node:changed-files') {
      const nodeId = event.node?.nodeId;
      if (!nodeId || event.changedFiles.length === 0) continue;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].processNodeId !== nodeId) continue;
        messages[i] = {
          ...messages[i],
          changedFiles: event.changedFiles.map(({ path, status }) => ({ path, status })),
        };
        break;
      }
    } else if (event.type === 'message:removed') {
      const existingIndex = indexById.get(event.messageId);
      if (existingIndex === undefined) continue;
      messages.splice(existingIndex, 1);
      indexById.delete(event.messageId);
      for (const [id, i] of indexById) {
        if (i > existingIndex) indexById.set(id, i - 1);
      }
    }
  }
  return messages;
}

// Change signature for the reconcile diff: which fields make a message "the
// same" across turns. The chat client sends the full history each turn with
// stable ids; content may be re-encoded (attachments collapse to text/parts),
// which the persisted state also adopts today — so an upsert on signature
// change keeps the projection aligned with SharedState semantics.
function messageSignature(m: FlujoChatMessage): string {
  return JSON.stringify([
    m.role,
    m.content,
    (m as { tool_calls?: unknown }).tool_calls ?? null,
    m.disabled ?? false,
    m.processNodeId ?? null,
  ]);
}

/**
 * Turn-start reconcile: bring the log in line with the state's just-configured
 * messages. The chat client sends its FULL (possibly pruned or edited) history
 * every turn and runFlow REPLACES SharedState.messages with it, so the log
 * cannot assume pure append. Called once per runFlow invocation, after state
 * configuration and before the run loop:
 *  - no log yet (brand-new conversation, or a legacy one from before the log
 *    existed) → bootstrap: the whole current transcript becomes the baseline;
 *  - log exists → diff current vs the pre-turn messages: changed/new messages
 *    become 'message' upserts, vanished ids become 'message:removed'.
 * System-role messages never enter the log. Awaitable: the turn's input is on
 * disk before the run loop starts.
 */
export async function reconcileConversationLog(
  state: SharedState,
  previousMessages: FlujoChatMessage[],
): Promise<void> {
  if (state.ephemeral) return;
  const conversationId = state.conversationId;
  if (!conversationId || !SAFE_ID.test(conversationId)) return;

  const current = (state.messages ?? []).filter((m) => m.role !== 'system' && !!m.id);
  const logExists = await hasConversationLog(conversationId);
  const baseline = logExists
    ? previousMessages.filter((m) => m.role !== 'system' && !!m.id)
    : [];

  const baselineById = new Map(baseline.map((m) => [m.id, m]));
  const currentIds = new Set(current.map((m) => m.id));

  const raws: RawExecutionEvent[] = [];
  for (const m of current) {
    const previous = baselineById.get(m.id);
    if (!previous || messageSignature(previous) !== messageSignature(m)) {
      raws.push({ type: 'message', message: m });
    }
  }
  for (const m of baseline) {
    if (!currentIds.has(m.id)) {
      raws.push({ type: 'message:removed', messageId: m.id });
    }
  }
  await appendRawForState(state, raws);
}

/**
 * Default synthetic result wording for a tool call that was emitted but never
 * answered because FLUJO died mid-tool (crash, dev-server restart, deploy).
 * Kept as one exported const so the run-start, load, cancel and resume paths
 * plus the tests all reuse the exact string; callers may pass a cause-specific
 * variant (e.g. the cancellation path) without touching call sites (issue #256).
 */
export const INTERRUPTED_TOOL_RESULT_CONTENT =
  'Tool execution interrupted (FLUJO restarted before this tool finished)';

/**
 * Reconcile dangling tool calls (issue #256). If a crash/restart lands between
 * "the assistant emitted tool_calls" and "the tool results were appended", the
 * persisted history keeps an assistant `tool_calls` turn whose calls are
 * unanswered — a shape every provider rejects with a 400 on the next request.
 *
 * This is a pure, in-place repair: it derives GROUND TRUTH strictly from the
 * message history (which tool_call_ids already have a matching role:'tool'
 * result) — never from `pendingToolCalls`, which can be out of sync after a
 * crash — synthesizes a role:'tool' "interrupted" result for each unanswered
 * call, and inserts it immediately after the owning assistant turn's existing
 * result block (or right after the assistant turn if it has none) so ordering
 * stays valid for providers. `processNodeId`/`depth` are carried over from the
 * owning assistant message so subflow projection tagging stays correct.
 *
 * Mutates `state.messages` and RETURNS the synthesized messages (empty array =
 * nothing to do). It does NOT persist them itself — callers decide persistence
 * (via appendRawForState), mirroring applyApprovalDecision's contract.
 */
export function repairDanglingToolCalls(
  state: SharedState,
  content: string = INTERRUPTED_TOOL_RESULT_CONTENT,
): FlujoChatMessage[] {
  const messages = state.messages ?? [];
  if (messages.length === 0) return [];

  // Ground truth: every tool_call_id that already has a role:'tool' result.
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      const id = (m as { tool_call_id?: string }).tool_call_id;
      if (id) answered.add(id);
    }
  }

  const synthesized: FlujoChatMessage[] = [];
  // Rebuild so each synthetic result lands right after the owning assistant
  // turn's existing (contiguous) tool-result block, not blindly at the end.
  const rebuilt: FlujoChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    rebuilt.push(m);
    const toolCalls = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
    if (m.role !== 'assistant' || !Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    const unanswered = toolCalls.filter((tc) => !!tc.id && !answered.has(tc.id));
    if (unanswered.length === 0) continue;
    // Copy this turn's existing contiguous tool-result block first so the
    // synthetic results are appended AFTER them.
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      rebuilt.push(messages[j]);
      j++;
    }
    for (const tc of unanswered) {
      const synthetic: FlujoChatMessage = {
        id: crypto.randomUUID(),
        role: 'tool',
        tool_call_id: tc.id!,
        content,
        timestamp: Date.now(),
        ...(m.processNodeId !== undefined ? { processNodeId: m.processNodeId } : {}),
        ...(m.depth !== undefined ? { depth: m.depth } : {}),
      };
      rebuilt.push(synthetic);
      synthesized.push(synthetic);
      answered.add(tc.id!);
    }
    i = j - 1; // skip the tool block already copied
  }

  if (synthesized.length === 0) return [];
  state.messages = rebuilt;
  return synthesized;
}

/**
 * Crash recovery: fold log messages missing from a storage-loaded snapshot
 * back into the state. Per-step durability is the LOG (appends); the full
 * SharedState snapshot is only written at run boundaries, so a crash mid-run
 * leaves the snapshot behind the log. Adopt the log's parent-level projection
 * (depth>0 subflow steps are display-only and never enter the transcript)
 * ONLY when it strictly extends the snapshot — every snapshot message id
 * present, plus at least one more. Anything else (no log, log incomplete or
 * diverged) keeps the snapshot untouched. Returns true when recovery applied.
 */
export async function recoverMessagesFromLog(state: SharedState): Promise<boolean> {
  if (state.ephemeral) return false;
  const conversationId = state.conversationId;
  if (!conversationId || !SAFE_ID.test(conversationId)) return false;

  const events = await readConversationLog(conversationId);
  if (!events) return false;

  const projectedParent = projectMessages(events).filter((m) => !((m.depth ?? 0) > 0));
  const snapshotIds = (state.messages ?? [])
    .filter((m) => m.role !== 'system' && !!m.id)
    .map((m) => m.id);
  if (projectedParent.length <= snapshotIds.length) return false;
  const projectedIds = new Set(projectedParent.map((m) => m.id));
  if (!snapshotIds.every((id) => projectedIds.has(id))) return false;

  log.info(
    `Recovered ${projectedParent.length - snapshotIds.length} message(s) from the conversation log for ${conversationId} (snapshot was behind).`
  );
  state.messages = projectedParent;
  return true;
}

/**
 * Inverse of recoverMessagesFromLog: repair a log that lost events so the
 * projection fell BEHIND the SharedState snapshot (issue #49). The
 * conversation-log bus tap used to drop every event of a planned
 * (saveConversations) run because FlowExecutor.conversationStates was
 * per-instance; the fix global-backs that map, but conversations already
 * written keep a complete `.json` snapshot and a truncated `.jsonl` (often just
 * the turn-start reconcile line). Because the display route prefers the
 * projection, those still render as one message until the log is rebuilt.
 *
 * We rebuild ONLY when it is safe and clearly the #49 signature:
 *  - a log exists, and
 *  - its parent-level projection is STRICTLY shorter than the snapshot's
 *    non-system messages, and
 *  - every projected id still exists in the snapshot (a subset) — so we are
 *    extending a truncated prefix, not clobbering a legitimately diverged log
 *    (edited/pruned history, where lengths match or ids differ).
 * On a match the `.jsonl` is rewritten as a sequence of `message` events from
 * the snapshot (system messages excluded, matching projection semantics) and
 * the authoritative messages are returned for display. Otherwise returns
 * undefined and the log is left untouched. Never throws.
 */
export async function repairTruncatedConversationLog(
  state: SharedState,
): Promise<FlujoChatMessage[] | undefined> {
  if (state.ephemeral) return undefined;
  const conversationId = state.conversationId;
  if (!conversationId || !SAFE_ID.test(conversationId)) return undefined;

  const events = await readConversationLog(conversationId);
  if (!events) return undefined; // no log — route falls back to the snapshot itself

  const projectedParent = projectMessages(events).filter((m) => !((m.depth ?? 0) > 0));
  const snapshot = (state.messages ?? []).filter((m) => m.role !== 'system' && !!m.id);
  // Not the truncation signature: log is level with / ahead of the snapshot.
  if (projectedParent.length >= snapshot.length) return undefined;
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  // Diverged (not a truncated prefix) — don't clobber a legitimately edited log.
  if (!projectedParent.every((m) => snapshotIds.has(m.id))) return undefined;

  // The log is fully replaced, so re-number from 0 with fresh monotonic seqs
  // and continue the durable counter past the rebuilt file.
  let rebuiltSeq = 0;
  const content = snapshot
    .map((m) => serialize({ type: 'message', message: m, conversationId, seq: rebuiltSeq++, timestamp: Date.now() } as ExecutionEvent))
    .join('');
  nextSeq.set(conversationId, rebuiltSeq);
  try {
    await chainWrite(conversationId, content);
    log.info(
      `Rebuilt truncated conversation log for ${conversationId} from snapshot (${projectedParent.length} → ${snapshot.length} message(s)); issue #49 self-heal.`
    );
  } catch (err) {
    log.warn(`Failed to rebuild truncated conversation log ${conversationId}`, { err });
    // Still return the snapshot for display; the rewrite can retry next read.
  }
  return snapshot;
}

/** True if a persisted log exists for this conversation. */
export async function hasConversationLog(conversationId: string): Promise<boolean> {
  if (!SAFE_ID.test(conversationId)) return false;
  try {
    await fs.access(logFilePath(conversationId));
    return true;
  } catch {
    return false;
  }
}
