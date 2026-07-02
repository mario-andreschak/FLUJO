import { promises as fs } from 'fs';
import path from 'path';
import {
  ExecutionEvent,
  ExecutionEventType,
  RawExecutionEvent,
} from '@/shared/types/execution/events';
import { FlujoChatMessage } from '@/shared/types/chat';
import { SharedState } from './types';
import { createLogger } from '@/utils/logger';

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
 * Ordering is FILE ORDER. Event `seq` is advisory here: the bus resets seq when
 * a channel is garbage-collected between runs, and log-only events (turn-start
 * reconcile, see appendRawForState) carry seq -1 because they were never on the
 * bus. Consumers must not sort by seq.
 */

// Event types worth persisting. Excluded on purpose:
//  - model:start/delta/end — streaming noise; the final content arrives as a
//    'message' event anyway.
//  - run:paused / run:awaiting_approval / breakpoint:hit — transient control
//    signals for live subscribers; they describe the run's momentary state,
//    not the conversation.
const PERSISTED_EVENT_TYPES: ReadonlySet<ExecutionEventType> = new Set<ExecutionEventType>([
  'run:start',
  'run:done',
  'node:enter',
  'node:exit',
  'handoff',
  'message',
  'message:removed',
  'tool:call',
  'tool:result',
  'usage',
  'subflow:start',
  'subflow:done',
  'error',
]);

// Conversation ids are UUIDs; anything else (path separators, dots) is refused
// so a hostile id can never escape the log directory.
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

let logDir = path.join(process.cwd(), 'db', 'conversation-logs');

/** Test seam: point the store at a temp directory. Returns the previous dir. */
export function _setConversationLogDirForTests(dir: string): string {
  const previous = logDir;
  logDir = dir;
  return previous;
}

function logFilePath(conversationId: string): string {
  return path.join(logDir, `${conversationId}.jsonl`);
}

// Per-conversation append chains so concurrent appends for the same log never
// interleave (mirrors saveItem's writeChains). Different conversations still
// append concurrently.
const appendChains = new Map<string, Promise<unknown>>();

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
 * live bus, so they are stamped here with seq -1. The ephemeral policy is
 * checked on the state itself. Awaitable so callers that need durability
 * (reconcile before a run) can wait; errors are logged, not thrown.
 */
export async function appendRawForState(state: SharedState, raws: RawExecutionEvent[]): Promise<void> {
  if (raws.length === 0) return;
  if (state.ephemeral) return;
  const conversationId = state.conversationId;
  if (!conversationId || !SAFE_ID.test(conversationId)) return;
  const lines = raws
    .map((raw) => serialize({ ...raw, conversationId, seq: -1, timestamp: Date.now() } as ExecutionEvent))
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

  for (const event of events) {
    if (event.type === 'message') {
      const incoming = event.message;
      if (!incoming || !incoming.id) continue;
      if (incoming.role === 'system') continue;
      const depth = event.depth ?? 0;
      const projected: FlujoChatMessage = depth > 0 ? { ...incoming, depth } : { ...incoming };
      const existingIndex = indexById.get(incoming.id);
      if (existingIndex !== undefined) {
        messages[existingIndex] = projected;
      } else {
        indexById.set(incoming.id, messages.length);
        messages.push(projected);
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
