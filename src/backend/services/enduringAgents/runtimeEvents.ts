import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import type { BigIntStats } from 'fs';
import path from 'path';
import { z } from 'zod';

import {
  PERSONA_ACTIVITY_KINDS,
  PERSONA_LIFECYCLE_STATES,
  PERSONA_PRIORITIES,
} from '@/shared/types/enduringAgent';
import { assertSafeCollectionId } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import {
  getCurrentWorkspace,
  getWorkspaceDataDir,
  workspaceCacheKey,
} from '@/utils/workspace';

import { getPersonaRuntimeClock } from './runtimeClock';
import { withPersonaRuntimeLock } from './runtimeLock';

const runtimeClock = getPersonaRuntimeClock();

const log = createLogger('backend/services/enduringAgents/runtimeEvents');

export const PERSONA_RUNTIME_EVENT_VERSION = 1 as const;

export const PERSONA_RUNTIME_STUCK_INDICATORS = [
  'active_lease_expired',
  'active_lease_missing_activity',
  'active_activity_terminal',
  'active_activity_waiting',
  'active_activity_not_running',
  'active_activity_missing_mailbox',
  'active_mailbox_not_claimed',
  'claimed_mailbox_without_live_lease',
  'lifecycle_projection_mismatch',
  'waiting_lifecycle_without_waiting_activity',
  'lifecycle_error_blocks_work',
] as const;

export type PersonaRuntimeStuckIndicator =
  (typeof PERSONA_RUNTIME_STUCK_INDICATORS)[number];

const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

const EventIdSchema = z.string().regex(SAFE_EVENT_ID);
const ReferenceSchema = z.string().regex(SAFE_REFERENCE);
const CodeSchema = z.string().regex(SAFE_CODE);
const TimestampSchema = z.number().int().nonnegative();

const MailboxAdmittedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('mailbox:admitted'),
  mailboxItemId: ReferenceSchema,
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  priority: z.enum(PERSONA_PRIORITIES),
  duplicate: z.boolean(),
}).strict();

const MailboxRoutedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('mailbox:routed'),
  mailboxItemId: ReferenceSchema,
  decision: z.enum([
    'queued',
    'steered',
    'coalesced',
    'interruption_requested',
    'rejected',
    'duplicate',
  ]),
  targetActivityId: ReferenceSchema.optional(),
  targetMailboxItemId: ReferenceSchema.optional(),
  reasonCode: CodeSchema.optional(),
}).strict();

const LifecycleTransitionEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('lifecycle:transition'),
  from: z.enum(PERSONA_LIFECYCLE_STATES),
  to: z.enum(PERSONA_LIFECYCLE_STATES),
  reasonCode: CodeSchema.optional(),
}).strict();

const ActivityClaimedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('activity:claimed'),
  activityId: ReferenceSchema,
  kind: z.enum(PERSONA_ACTIVITY_KINDS),
  behaviorRevisionId: ReferenceSchema.optional(),
}).strict();

const ActivityYieldedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('activity:yielded'),
  activityId: ReferenceSchema,
}).strict();

const ActivityCompletedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('activity:completed'),
  activityId: ReferenceSchema,
}).strict();

const ActivityCancelledEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('activity:cancelled'),
  activityId: ReferenceSchema,
}).strict();

const ActivityErroredEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('activity:errored'),
  activityId: ReferenceSchema,
  errorCode: CodeSchema,
}).strict();

const LeaseRenewedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('lease:renewed'),
  activityId: ReferenceSchema,
  expiresAt: TimestampSchema,
}).strict();

const LeaseExpiredEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('lease:expired'),
  activityId: ReferenceSchema,
  reasonCode: CodeSchema.optional(),
}).strict();

const InterruptionRequestedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('interruption:requested'),
  activityId: ReferenceSchema,
  requestedByMailboxItemId: ReferenceSchema,
}).strict();

const RecoveryStartedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('recovery:started'),
  indicators: z.array(z.enum(PERSONA_RUNTIME_STUCK_INDICATORS)).min(1).max(20),
}).strict();

const RecoveryCompletedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('recovery:completed'),
  changed: z.boolean(),
  remainingStuckCount: z.number().int().nonnegative(),
}).strict();

const RecoveryFailedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('recovery:failed'),
  errorCode: CodeSchema,
}).strict();

const StuckDetectedEventSchema = z.object({
  eventId: EventIdSchema,
  type: z.literal('stuck:detected'),
  indicator: z.enum(PERSONA_RUNTIME_STUCK_INDICATORS),
  activityId: ReferenceSchema.optional(),
}).strict();

export const RawPersonaRuntimeEventSchema = z.discriminatedUnion('type', [
  MailboxAdmittedEventSchema,
  MailboxRoutedEventSchema,
  LifecycleTransitionEventSchema,
  ActivityClaimedEventSchema,
  ActivityYieldedEventSchema,
  ActivityCompletedEventSchema,
  ActivityCancelledEventSchema,
  ActivityErroredEventSchema,
  LeaseRenewedEventSchema,
  LeaseExpiredEventSchema,
  InterruptionRequestedEventSchema,
  RecoveryStartedEventSchema,
  RecoveryCompletedEventSchema,
  RecoveryFailedEventSchema,
  StuckDetectedEventSchema,
]);

export type RawPersonaRuntimeEvent = z.infer<typeof RawPersonaRuntimeEventSchema>;

const persistedFields = {
  version: z.literal(PERSONA_RUNTIME_EVENT_VERSION),
  workspaceId: z.string().min(1).max(256),
  personaId: ReferenceSchema,
  seq: z.number().int().nonnegative(),
  timestamp: TimestampSchema,
};

export const PersonaRuntimeEventSchema = z.discriminatedUnion('type', [
  MailboxAdmittedEventSchema.extend(persistedFields),
  MailboxRoutedEventSchema.extend(persistedFields),
  LifecycleTransitionEventSchema.extend(persistedFields),
  ActivityClaimedEventSchema.extend(persistedFields),
  ActivityYieldedEventSchema.extend(persistedFields),
  ActivityCompletedEventSchema.extend(persistedFields),
  ActivityCancelledEventSchema.extend(persistedFields),
  ActivityErroredEventSchema.extend(persistedFields),
  LeaseRenewedEventSchema.extend(persistedFields),
  LeaseExpiredEventSchema.extend(persistedFields),
  InterruptionRequestedEventSchema.extend(persistedFields),
  RecoveryStartedEventSchema.extend(persistedFields),
  RecoveryCompletedEventSchema.extend(persistedFields),
  RecoveryFailedEventSchema.extend(persistedFields),
  StuckDetectedEventSchema.extend(persistedFields),
]);

export type PersonaRuntimeEvent = z.infer<typeof PersonaRuntimeEventSchema>;

/**
 * Number of most-recent eventIds kept per Persona for idempotent-retry
 * detection. A replayed eventId older than this window is no longer deduped
 * and appends a new record with a new seq — a deliberate, documented bound on
 * resident memory (issue #454). The window is far larger than any realistic
 * retry horizon (recovery-outbox drains replay a handful of events). Full
 * rescans log a warning whenever a duplicate id is observed beyond the
 * window, so any real-world violation of this assumption becomes visible.
 */
export const RUNTIME_EVENT_IDEMPOTENCY_WINDOW = 5_000;

let idempotencyWindowLimit: number = RUNTIME_EVENT_IDEMPOTENCY_WINDOW;

/**
 * Kill switch: flip to false to force an unconditional full rescan on every
 * append (the pre-#454 behaviour) while debugging a field report.
 */
const RUNTIME_EVENT_INCREMENTAL_STATE = true;

/** Bounded number of per-Persona cached log states retained in this process. */
const LOG_STATE_CACHE_LIMIT = 256;

const SCAN_CHUNK_BYTES = 64 * 1024;
const NEWLINE_BYTE = 0x0a;
const EMPTY_BUFFER = Buffer.alloc(0);
// BigInt call form (not a literal) because the compile target predates ES2020.
const UNKNOWN_FILE_IDENTITY = BigInt(-1);

/**
 * Insertion-ordered index of the most recent eventIds, capped at the
 * idempotency window; evicts oldest-first. Stores the full event because the
 * append path returns the existing event on a duplicate. Memory bound is
 * approximately window-size × average event size.
 */
class RecentEventIdWindow {
  private readonly entries = new Map<string, PersonaRuntimeEvent>();

  get size(): number {
    return this.entries.size;
  }

  has(eventId: string): boolean {
    return this.entries.has(eventId);
  }

  get(eventId: string): PersonaRuntimeEvent | undefined {
    return this.entries.get(eventId);
  }

  remember(event: PersonaRuntimeEvent): void {
    if (this.entries.has(event.eventId)) return;
    this.entries.set(event.eventId, event);
    while (this.entries.size > idempotencyWindowLimit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

interface PersonaRuntimeEventLogState {
  nextSeq: number;
  /** Bounded recent-eventId index; see RUNTIME_EVENT_IDEMPOTENCY_WINDOW. */
  recentEventIds: RecentEventIdWindow;
  /** A crash may leave a partial final line without a newline terminator. */
  needsSeparator: boolean;
  /** File identity this state was derived from; UNKNOWN_FILE_IDENTITY when the file did not exist yet. */
  dev: bigint;
  ino: bigint;
  /** Byte offset of the end of the last complete (newline-terminated) line consumed. */
  parsedBytes: number;
  /**
   * Raw bytes after the last newline (a crash-partial final line). Kept as
   * bytes — not a decoded string — so offset accounting stays exact even when
   * a crash cut a multi-byte UTF-8 character in half.
   */
  tailBytes: Buffer;
  /** Diagnostics only — never used as the staleness oracle (coarse granularity). */
  mtimeMs: number;
}

/**
 * Per-Persona incremental log state, keyed identically to appendChains so
 * workspace and test-root scoping are inherited. Bounded LRU so a workspace
 * with many Personas cannot leak memory.
 */
const logStates = new Map<string, PersonaRuntimeEventLogState>();

function cacheLogState(key: string, state: PersonaRuntimeEventLogState): void {
  logStates.delete(key);
  logStates.set(key, state);
  while (logStates.size > LOG_STATE_CACHE_LIMIT) {
    const oldest = logStates.keys().next().value;
    if (oldest === undefined) break;
    logStates.delete(oldest);
  }
}

/** Deterministic work counters exposed for scaling tests (test seam). */
export interface PersonaRuntimeEventLogWorkStats {
  fullRescans: number;
  tailReads: number;
  cacheHits: number;
  bytesParsed: number;
  linesParsed: number;
}

const logWorkStats: PersonaRuntimeEventLogWorkStats = {
  fullRescans: 0,
  tailReads: 0,
  cacheHits: 0,
  bytesParsed: 0,
  linesParsed: 0,
};

let eventLogRootOverride: string | undefined;

function eventLogDir(): string {
  if (eventLogRootOverride) {
    return path.join(eventLogRootOverride, getCurrentWorkspace());
  }
  return path.join(getWorkspaceDataDir(), 'db', 'persona-runtime-events');
}

function eventLogPath(personaId: string): string {
  return path.join(eventLogDir(), `${personaId}.jsonl`);
}

function cacheKey(personaId: string): string {
  return workspaceCacheKey('persona-runtime-events', eventLogDir(), personaId);
}

// Event appends can originate after the authoritative Persona lock is released
// (and from inspection/recovery in another process). Use a separate, stable
// local-filesystem lock identity so observation writes are cross-process
// serialized without ever recursively acquiring the Persona's runtime lock.
function eventWriterLockId(personaId: string): string {
  const digest = createHash('sha256').update(personaId).digest('hex').slice(0, 40);
  return `runtime_events_${digest}`;
}

async function assertEventLogNotDeleting(personaId: string): Promise<void> {
  // Loaded lazily to keep the event schema/store dependency one-way at module
  // initialization. A deleting tombstone is published before state erasure,
  // so checking it while holding the event-writer lock prevents a delayed
  // observation from recreating the JSONL after Persona deletion removed it.
  const { getPersonaDeletionTombstone } = await import('./store');
  if (await getPersonaDeletionTombstone(personaId)) {
    throw new Error(`Persona ${JSON.stringify(personaId)} is deleting; runtime events are closed.`);
  }
}

const appendChains = new Map<string, Promise<unknown>>();

type ParsedLogLine =
  | { kind: 'blank' }
  | { kind: 'skipped' }
  | { kind: 'event'; event: PersonaRuntimeEvent };

/**
 * Validate one complete JSONL line. Duplicate-eventId suppression is the
 * caller's responsibility (different paths dedupe against different sets).
 * Skip semantics are identical to the historical parseEventLines: blank lines
 * are ignored silently; malformed JSON/Zod failures and persona/workspace
 * mismatches are skipped (and counted by the caller).
 */
function parseLogLine(
  line: string,
  personaId: string,
  workspaceId: string,
): ParsedLogLine {
  if (!line.trim()) return { kind: 'blank' };
  try {
    const event = PersonaRuntimeEventSchema.parse(JSON.parse(line));
    if (event.personaId !== personaId || event.workspaceId !== workspaceId) {
      return { kind: 'skipped' };
    }
    return { kind: 'event', event };
  } catch {
    // A process may stop halfway through the final append. Complete earlier
    // lines remain authoritative, and the next append inserts a separator.
    return { kind: 'skipped' };
  }
}

interface LogScanResult {
  /** Raw bytes after the last newline (partial trailing line), empty when clean. */
  tailBytes: Buffer;
  /** File byte offset just past the last complete line consumed. */
  endOffset: number;
  /** Total bytes read from disk by this scan. */
  bytesRead: number;
}

/**
 * Stream the log from byte offset `start` to EOF in fixed-size chunks,
 * splitting on newline BYTES (never decoding partial lines), and invoke
 * `onLine` for every complete line. `carry` must contain the raw bytes that
 * logically sit immediately before `start` (a previously observed partial
 * trailing line); it is prepended to the first line. Returning false from
 * `onLine` stops the scan early — tailBytes/endOffset are then meaningless
 * and must not be persisted. ENOENT is treated as an empty file.
 */
async function scanLogLines(
  filePath: string,
  start: number,
  carry: Buffer,
  onLine: (line: string) => boolean | void,
): Promise<LogScanResult> {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { tailBytes: carry, endOffset: start, bytesRead: 0 };
    }
    throw error;
  }
  try {
    let position = start;
    let bytesRead = 0;
    let pending = carry;
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    for (;;) {
      const { bytesRead: readCount } = await handle.read(chunk, 0, chunk.length, position);
      if (readCount === 0) break;
      position += readCount;
      bytesRead += readCount;
      // The chunk buffer is reused; always copy before retaining bytes.
      pending = pending.length === 0
        ? Buffer.from(chunk.subarray(0, readCount))
        : Buffer.concat([pending, chunk.subarray(0, readCount)]);
      let lineStart = 0;
      for (;;) {
        const newlineAt = pending.indexOf(NEWLINE_BYTE, lineStart);
        if (newlineAt === -1) break;
        const keepGoing = onLine(pending.subarray(lineStart, newlineAt).toString('utf8'));
        lineStart = newlineAt + 1;
        if (keepGoing === false) {
          return { tailBytes: EMPTY_BUFFER, endOffset: start, bytesRead };
        }
      }
      if (lineStart > 0) pending = Buffer.from(pending.subarray(lineStart));
    }
    // position - pending.length is exact even with a carry: the virtual stream
    // is carry + file[start, position), and pending is its unconsumed suffix.
    return { tailBytes: pending, endOffset: position - pending.length, bytesRead };
  } finally {
    await handle.close();
  }
}

function emptyLogState(): PersonaRuntimeEventLogState {
  return {
    nextSeq: 0,
    recentEventIds: new RecentEventIdWindow(),
    needsSeparator: false,
    dev: UNKNOWN_FILE_IDENTITY,
    ino: UNKNOWN_FILE_IDENTITY,
    parsedBytes: 0,
    tailBytes: EMPTY_BUFFER,
    mtimeMs: 0,
  };
}

function warnSkipped(skipped: number, personaId: string, workspaceId: string): void {
  if (skipped > 0) {
    log.warn(`Skipped ${skipped} malformed Persona runtime event line(s).`, {
      personaId,
      workspaceId,
    });
  }
}

/**
 * Bring the cached per-Persona log state in sync with the file on disk.
 * MUST only be called while holding the event-writer lock.
 *
 * Correctness argument: the JSONL is strictly append-only — it is only ever
 * extended with fs.appendFile and never rewritten in place — therefore
 * (dev, ino, size) is a sound change detector: an unchanged size on the same
 * inode proves no bytes were appended by any process, a grown size means
 * exactly the bytes in [parsedBytes + tailBytes.length, size) are new, and a
 * shrunk size or a different inode means the file was truncated/replaced and
 * forces a full rescan. mtimeMs is deliberately NOT used as the oracle (its
 * granularity can be as coarse as 1 s on some filesystems); it is stored for
 * diagnostics only. Because the check is derived from the filesystem while
 * the cross-process writer lock is held, a foreign append from another FLUJO
 * process can never be missed.
 */
async function syncState(personaId: string): Promise<PersonaRuntimeEventLogState> {
  const key = cacheKey(personaId);
  const filePath = eventLogPath(personaId);
  const workspaceId = getCurrentWorkspace();

  let stat: BigIntStats | undefined;
  try {
    stat = await fs.stat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (!stat) {
    const state = emptyLogState();
    cacheLogState(key, state);
    return state;
  }

  const size = Number(stat.size);
  const cached = RUNTIME_EVENT_INCREMENTAL_STATE ? logStates.get(key) : undefined;
  if (cached && cached.dev === stat.dev && cached.ino === stat.ino) {
    const knownBytes = cached.parsedBytes + cached.tailBytes.length;
    if (size === knownBytes) {
      // O(1) hit: same inode, same length — nothing was appended by anyone.
      logWorkStats.cacheHits += 1;
      cached.mtimeMs = Number(stat.mtimeMs);
      cacheLogState(key, cached);
      return cached;
    }
    if (size > knownBytes) {
      // Append-only growth: parse only the foreign delta.
      let skipped = 0;
      const scan = await scanLogLines(filePath, knownBytes, cached.tailBytes, (line) => {
        logWorkStats.linesParsed += 1;
        const parsed = parseLogLine(line, personaId, workspaceId);
        if (parsed.kind === 'blank') return;
        if (parsed.kind === 'skipped' || cached.recentEventIds.has(parsed.event.eventId)) {
          skipped += 1;
          return;
        }
        cached.recentEventIds.remember(parsed.event);
        cached.nextSeq = Math.max(cached.nextSeq, parsed.event.seq + 1);
      });
      logWorkStats.tailReads += 1;
      logWorkStats.bytesParsed += scan.bytesRead;
      cached.parsedBytes = scan.endOffset;
      cached.tailBytes = scan.tailBytes;
      cached.needsSeparator = scan.tailBytes.length > 0;
      cached.mtimeMs = Number(stat.mtimeMs);
      warnSkipped(skipped, personaId, workspaceId);
      cacheLogState(key, cached);
      return cached;
    }
    // size < knownBytes: truncated or replaced — fall through to a full rescan.
  }

  // Full rescan (cache miss, incremental state disabled, inode change, or shrink).
  logWorkStats.fullRescans += 1;
  const seenIds = new Set<string>();
  const window = new RecentEventIdWindow();
  let nextSeq = 0;
  let skipped = 0;
  let duplicatesBeyondWindow = 0;
  const scan = await scanLogLines(filePath, 0, EMPTY_BUFFER, (line) => {
    logWorkStats.linesParsed += 1;
    const parsed = parseLogLine(line, personaId, workspaceId);
    if (parsed.kind === 'blank') return;
    if (parsed.kind === 'skipped') {
      skipped += 1;
      return;
    }
    const { event } = parsed;
    if (seenIds.has(event.eventId)) {
      skipped += 1;
      if (!window.has(event.eventId)) duplicatesBeyondWindow += 1;
      return;
    }
    seenIds.add(event.eventId);
    window.remember(event);
    nextSeq = Math.max(nextSeq, event.seq + 1);
  });
  logWorkStats.bytesParsed += scan.bytesRead;
  warnSkipped(skipped, personaId, workspaceId);
  if (duplicatesBeyondWindow > 0) {
    log.warn('Observed duplicate Persona runtime eventIds beyond the idempotency window.', {
      personaId,
      workspaceId,
      duplicatesBeyondWindow,
      window: idempotencyWindowLimit,
    });
  }
  const state: PersonaRuntimeEventLogState = {
    nextSeq,
    recentEventIds: window,
    needsSeparator: scan.tailBytes.length > 0,
    dev: stat.dev,
    ino: stat.ino,
    parsedBytes: scan.endOffset,
    tailBytes: scan.tailBytes,
    mtimeMs: Number(stat.mtimeMs),
  };
  cacheLogState(key, state);
  return state;
}

function enqueue<T>(personaId: string, task: () => Promise<T>): Promise<T> {
  const key = cacheKey(personaId);
  const previous = appendChains.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* a prior append failure must not wedge the log */ })
    .then(task);
  appendChains.set(key, run);
  void run.catch(() => { /* surfaced to the caller */ }).finally(() => {
    if (appendChains.get(key) === run) appendChains.delete(key);
  });
  return run;
}

async function appendRecord(
  personaId: string,
  state: PersonaRuntimeEventLogState,
  event: PersonaRuntimeEvent,
): Promise<number> {
  await fs.mkdir(eventLogDir(), { recursive: true });
  const record = `${state.needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`;
  await fs.appendFile(eventLogPath(personaId), record, 'utf8');
  // Byte length, not string length: workspace ids (and future fields) may
  // contain multi-byte UTF-8, and offset accounting must be exact.
  return Buffer.byteLength(record, 'utf8');
}

export interface AppendPersonaRuntimeEventResult {
  event: PersonaRuntimeEvent;
  /** False when eventId was already durable and the original was returned. */
  appended: boolean;
}

/**
 * Append one strictly validated, redacted runtime observation.
 *
 * The service stamps workspace, Persona, sequence, and time. Callers cannot add
 * free-form details or lease capabilities because every event variant is strict.
 */
export async function appendPersonaRuntimeEvent(
  personaId: string,
  value: unknown,
): Promise<AppendPersonaRuntimeEventResult> {
  assertSafeCollectionId(personaId);
  const raw = RawPersonaRuntimeEventSchema.parse(value);

  return withPersonaRuntimeLock(eventWriterLockId(personaId), () =>
    enqueue(personaId, async () => {
      await assertEventLogNotDeleting(personaId);
      // Re-derive freshness from the filesystem while holding the
      // cross-process writer lock: syncState stats the file and parses at
      // most the bytes appended by a foreign process since the last call.
      const state = await syncState(personaId);
      const existing = state.recentEventIds.get(raw.eventId);
      if (existing) return { event: existing, appended: false };

      const event = PersonaRuntimeEventSchema.parse({
        ...raw,
        version: PERSONA_RUNTIME_EVENT_VERSION,
        workspaceId: getCurrentWorkspace(),
        personaId,
        seq: state.nextSeq,
        timestamp: runtimeClock.now(),
      });
      let bytesWritten: number;
      try {
        bytesWritten = await appendRecord(personaId, state, event);
      } catch (error) {
        // Some filesystems may reject after the full record reached disk.
        // The cached state's write outcome is unknown — drop it, rescan, and
        // accept the exact durable id so a retry cannot duplicate it.
        logStates.delete(cacheKey(personaId));
        try {
          const recovered = await syncState(personaId);
          const durable = recovered.recentEventIds.get(raw.eventId);
          if (durable) return { event: durable, appended: true };
        } catch {
          // Preserve the append error; a later retry performs the same rescan.
        }
        throw error;
      }
      // Advance the cache deterministically past what was just written. A
      // crash fragment (tailBytes) was terminated by the separator newline
      // and is now a complete — malformed, skipped — line.
      state.parsedBytes += state.tailBytes.length + bytesWritten;
      state.tailBytes = EMPTY_BUFFER;
      state.needsSeparator = false;
      state.nextSeq = event.seq + 1;
      state.recentEventIds.remember(event);
      if (state.dev === UNKNOWN_FILE_IDENTITY) {
        // First append created the file: capture its identity once so the
        // next syncState takes the O(1) hit path instead of a full rescan.
        try {
          const created = await fs.stat(eventLogPath(personaId), { bigint: true });
          state.dev = created.dev;
          state.ino = created.ino;
          state.mtimeMs = Number(created.mtimeMs);
        } catch {
          // The next syncState simply performs a full rescan.
        }
      }
      return { event, appended: true };
    })
  );
}

export interface ReadPersonaRuntimeEventsOptions {
  /** Inclusive durable resume cursor. */
  fromSeq?: number;
  /** Optional maximum count after filtering (the FIRST matches, as before). */
  limit?: number;
  /**
   * Return only the LAST `tail` events after filtering, collected with a
   * bounded ring buffer during the stream (O(tail) memory). When combined
   * with limit, limit is applied to the tail.
   */
  tail?: number;
}

/** Read committed observations in durable append order (streaming; O(result) memory). */
export async function readPersonaRuntimeEvents(
  personaId: string,
  options: ReadPersonaRuntimeEventsOptions = {},
): Promise<PersonaRuntimeEvent[]> {
  assertSafeCollectionId(personaId);
  await flushPersonaRuntimeEvents(personaId);
  const fromSeq = Number.isSafeInteger(options.fromSeq) && (options.fromSeq ?? 0) >= 0
    ? options.fromSeq!
    : 0;
  const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) >= 0
    ? options.limit
    : undefined;
  const tail = Number.isSafeInteger(options.tail) && (options.tail ?? 0) >= 0
    ? options.tail
    : undefined;
  return withPersonaRuntimeLock(eventWriterLockId(personaId), async () => {
    const workspaceId = getCurrentWorkspace();
    const events: PersonaRuntimeEvent[] = [];
    const seenIds = new Set<string>();
    let skipped = 0;
    await scanLogLines(eventLogPath(personaId), 0, EMPTY_BUFFER, (line) => {
      const parsed = parseLogLine(line, personaId, workspaceId);
      if (parsed.kind === 'blank') return;
      if (parsed.kind === 'skipped') {
        skipped += 1;
        return;
      }
      const { event } = parsed;
      if (seenIds.has(event.eventId)) {
        skipped += 1;
        return;
      }
      seenIds.add(event.eventId);
      if (event.seq < fromSeq) return;
      if (tail !== undefined) {
        events.push(event);
        if (events.length > tail) events.shift();
        return;
      }
      if (limit === undefined) {
        events.push(event);
        return;
      }
      if (events.length < limit) events.push(event);
      if (events.length >= limit) return false;
    });
    warnSkipped(skipped, personaId, workspaceId);
    return tail !== undefined && limit !== undefined ? events.slice(0, limit) : events;
  });
}

/** Highest committed sequence, or -1 when no observations exist. */
export async function latestPersonaRuntimeEventSequence(personaId: string): Promise<number> {
  assertSafeCollectionId(personaId);
  await flushPersonaRuntimeEvents(personaId);
  return withPersonaRuntimeLock(
    eventWriterLockId(personaId),
    async () => (await syncState(personaId)).nextSeq - 1,
  );
}

/** Wait until appends already queued for this Persona settle. Never rejects. */
export async function flushPersonaRuntimeEvents(personaId: string): Promise<void> {
  assertSafeCollectionId(personaId);
  const pending = appendChains.get(cacheKey(personaId));
  if (pending) await pending.then(() => undefined, () => undefined);
}

/** Delete one Persona's event log and reset its in-process state. */
export async function deletePersonaRuntimeEvents(personaId: string): Promise<void> {
  assertSafeCollectionId(personaId);
  await withPersonaRuntimeLock(eventWriterLockId(personaId), () =>
    enqueue(personaId, async () => {
      logStates.delete(cacheKey(personaId));
      try {
        await fs.unlink(eventLogPath(personaId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    })
  );
}

/** Workspace-preserving test seam; the override is a root, not a shared log directory. */
export function _setPersonaRuntimeEventLogRootForTests(
  root: string | undefined,
): string | undefined {
  const previous = eventLogRootOverride;
  eventLogRootOverride = root;
  appendChains.clear();
  logStates.clear();
  return previous;
}

/** Test seam: snapshot of the deterministic work counters. */
export function _getPersonaRuntimeEventLogStatsForTests(): PersonaRuntimeEventLogWorkStats {
  return { ...logWorkStats };
}

/** Test seam: reset the deterministic work counters. */
export function _resetPersonaRuntimeEventLogStatsForTests(): void {
  logWorkStats.fullRescans = 0;
  logWorkStats.tailReads = 0;
  logWorkStats.cacheHits = 0;
  logWorkStats.bytesParsed = 0;
  logWorkStats.linesParsed = 0;
}

/** Test seam: shrink/restore the idempotency window. Returns the previous limit. */
export function _setPersonaRuntimeEventIdempotencyWindowForTests(limit?: number): number {
  const previous = idempotencyWindowLimit;
  idempotencyWindowLimit = Number.isSafeInteger(limit) && (limit ?? 0) > 0
    ? limit!
    : RUNTIME_EVENT_IDEMPOTENCY_WINDOW;
  return previous;
}

/** Test seam: inspect the cached incremental state for one Persona. */
export function _getPersonaRuntimeEventLogStateForTests(personaId: string): {
  nextSeq: number;
  parsedBytes: number;
  tailBytesLength: number;
  windowSize: number;
  needsSeparator: boolean;
} | undefined {
  const state = logStates.get(cacheKey(personaId));
  if (!state) return undefined;
  return {
    nextSeq: state.nextSeq,
    parsedBytes: state.parsedBytes,
    tailBytesLength: state.tailBytes.length,
    windowSize: state.recentEventIds.size,
    needsSeparator: state.needsSeparator,
  };
}
