import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import type { MeetingEvent, RawMeetingEvent } from '@/shared/types/meeting';
import {
  ARCHIVED_MEETING_PARTICIPANT_NAME,
  MEETING_SCHEMA_VERSION,
} from '@/shared/types/meeting';
import { assertSafeCollectionId, writeFileAtomic } from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';

const log = createLogger('backend/services/meetings/eventLog');

const SAFE_EVENT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

let logDirOverride: string | undefined;
const logDir = () =>
  logDirOverride ?? path.join(getWorkspaceDataDir(), 'db', 'meeting-logs');

const appendChains = new Map<string, Promise<unknown>>();

interface MeetingLogState {
  nextSeq: number;
  eventsById: Map<string, MeetingEvent>;
  /** A crash may leave a partial final line without its newline terminator. */
  needsSeparator: boolean;
}

interface PersistedMeetingEventBatch {
  kind: 'meeting-event-batch';
  version: 1;
  meetingId: string;
  batchId: string;
  events: MeetingEvent[];
}

const states = new Map<string, MeetingLogState>();
const stateInitializers = new Map<string, Promise<MeetingLogState>>();

function cacheKey(meetingId: string): string {
  return workspaceCacheKey('meeting-event-log', logDir(), meetingId);
}

function logFilePath(meetingId: string): string {
  return path.join(logDir(), `${meetingId}.jsonl`);
}

export function assertSafeMeetingEventId(eventId: string): void {
  if (typeof eventId !== 'string' || !SAFE_EVENT_ID.test(eventId)) {
    throw new Error(`Unsafe meeting event id: ${JSON.stringify(eventId)}`);
  }
}

function isPersistedMeetingEvent(
  candidate: Partial<MeetingEvent>,
  meetingId: string,
): candidate is MeetingEvent {
  return candidate.meetingId === meetingId
    && typeof candidate.eventId === 'string'
    && typeof candidate.seq === 'number'
    && Number.isSafeInteger(candidate.seq)
    && candidate.seq >= 0
    && typeof candidate.timestamp === 'number'
    && typeof candidate.type === 'string';
}

function parseEventLines(content: string, meetingId: string): MeetingEvent[] {
  const events: MeetingEvent[] = [];
  let skipped = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const candidate = JSON.parse(line) as Partial<MeetingEvent> & {
        kind?: string;
        batchId?: string;
        events?: Partial<MeetingEvent>[];
      };
      if (candidate.kind === 'meeting-event-batch') {
        if (
          candidate.version !== 1
          || candidate.meetingId !== meetingId
          || typeof candidate.batchId !== 'string'
          || !SAFE_EVENT_ID.test(candidate.batchId)
          || !Array.isArray(candidate.events)
          || !candidate.events.every((event) => isPersistedMeetingEvent(event, meetingId))
        ) {
          skipped++;
          continue;
        }
        events.push(...candidate.events);
        continue;
      }
      if (!isPersistedMeetingEvent(candidate, meetingId)) {
        skipped++;
        continue;
      }
      events.push(candidate);
    } catch {
      // A process can be interrupted halfway through the final append. Earlier
      // complete JSONL lines remain usable, so ignore only the malformed line.
      skipped++;
    }
  }
  if (skipped > 0) {
    log.warn(`Skipped ${skipped} malformed line(s) in meeting log ${meetingId}`);
  }
  return events;
}

async function readFileSnapshot(
  meetingId: string,
): Promise<{ events: MeetingEvent[]; needsSeparator: boolean }> {
  let content: string;
  try {
    content = await fs.readFile(logFilePath(meetingId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], needsSeparator: false };
    }
    throw error;
  }
  return {
    events: parseEventLines(content, meetingId),
    needsSeparator: content.length > 0 && !content.endsWith('\n'),
  };
}

async function readFileEvents(meetingId: string): Promise<MeetingEvent[]> {
  return (await readFileSnapshot(meetingId)).events;
}

async function loadState(meetingId: string): Promise<MeetingLogState> {
  const key = cacheKey(meetingId);
  const cached = states.get(key);
  if (cached) return cached;
  const pending = stateInitializers.get(key);
  if (pending) return pending;

  const initializer = (async () => {
    const { events, needsSeparator } = await readFileSnapshot(meetingId);
    let maxSeq = -1;
    const eventsById = new Map<string, MeetingEvent>();
    for (const event of events) {
      if (event.seq > maxSeq) maxSeq = event.seq;
      // File order is authoritative. Preserve the first occurrence if a log
      // written by an older implementation contains a duplicate id.
      if (!eventsById.has(event.eventId)) eventsById.set(event.eventId, event);
    }
    const state = { nextSeq: maxSeq + 1, eventsById, needsSeparator };
    states.set(key, state);
    return state;
  })();
  stateInitializers.set(key, initializer);
  try {
    return await initializer;
  } finally {
    if (stateInitializers.get(key) === initializer) stateInitializers.delete(key);
  }
}

function enqueue<T>(meetingId: string, task: () => Promise<T>): Promise<T> {
  const key = cacheKey(meetingId);
  const previous = appendChains.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => { /* a failed earlier append must not wedge the log */ })
    .then(task);
  appendChains.set(key, run);
  void run.catch(() => { /* surfaced to the caller */ }).finally(() => {
    if (appendChains.get(key) === run) appendChains.delete(key);
  });
  return run;
}

async function appendRecord(
  meetingId: string,
  state: MeetingLogState,
  record: MeetingEvent | PersistedMeetingEventBatch,
): Promise<void> {
  await fs.mkdir(logDir(), { recursive: true });
  const separator = state.needsSeparator ? '\n' : '';
  try {
    await fs.appendFile(
      logFilePath(meetingId),
      `${separator}${JSON.stringify(record)}\n`,
      'utf8',
    );
  } catch (error) {
    // appendFile can reject after writing some or all bytes. Discard every
    // cached projection so the next queued append rescans both sequence/id
    // state and whether a separator is needed from the actual file tail.
    const key = cacheKey(meetingId);
    states.delete(key);
    stateInitializers.delete(key);
    throw error;
  }
}

export interface AppendMeetingEventResult {
  event: MeetingEvent;
  /** False when eventId already existed and the original event was returned. */
  appended: boolean;
}

export interface AppendMeetingEventBatchResult {
  /** One result per requested raw event, preserving request order. */
  events: MeetingEvent[];
  /** Newly persisted events; duplicates are returned above but not republished. */
  appendedEvents: MeetingEvent[];
}

/** Append failed ambiguously; these ids were absent before the attempted write. */
export class MeetingEventAppendError extends Error {
  readonly eventIds: readonly string[];

  constructor(cause: unknown, eventIds: readonly string[]) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'MeetingEventAppendError';
    this.eventIds = [...eventIds];
  }
}

/**
 * Stamp and durably append a meeting event.
 *
 * Calls for one meeting are serialized, so file order and `seq` order always
 * agree even when participant turns settle concurrently. Supplying an eventId
 * makes retries idempotent and returns the original persisted event.
 */
export async function appendMeetingEvent(
  meetingId: string,
  raw: RawMeetingEvent,
): Promise<AppendMeetingEventResult> {
  assertSafeCollectionId(meetingId);
  const requestedEventId = raw.eventId ?? randomUUID();
  assertSafeMeetingEventId(requestedEventId);

  return enqueue(meetingId, async () => {
    const state = await loadState(meetingId);
    const existing = state.eventsById.get(requestedEventId);
    if (existing) return { event: existing, appended: false };

    const { eventId: _eventId, ...body } = raw;
    const event = {
      ...body,
      version: MEETING_SCHEMA_VERSION,
      meetingId,
      eventId: requestedEventId,
      seq: state.nextSeq,
      timestamp: Date.now(),
    } as MeetingEvent;

    try {
      await appendRecord(meetingId, state, event);
    } catch (error) {
      // Some filesystems can report failure after every byte reached disk.
      // Rescan after cache invalidation and treat that exact durable id as a
      // successful append so live publishers do not skip it.
      try {
        const recovered = await loadState(meetingId);
        const durable = recovered.eventsById.get(requestedEventId);
        if (durable) return { event: durable, appended: true };
      } catch {
        // Preserve the append error; a later retry performs the same rescan.
      }
      throw new MeetingEventAppendError(error, [requestedEventId]);
    }
    state.nextSeq += 1;
    state.needsSeparator = false;
    state.eventsById.set(requestedEventId, event);
    return { event, appended: true };
  });
}

/**
 * Durably append a visibility batch as one JSONL record.
 *
 * A crash can leave at most one malformed final line, which the reader ignores
 * in full. Consequently no consumer can observe a prefix of a barrier commit.
 */
export async function appendMeetingEventBatch(
  meetingId: string,
  batchId: string,
  raws: readonly RawMeetingEvent[],
): Promise<AppendMeetingEventBatchResult> {
  assertSafeCollectionId(meetingId);
  assertSafeMeetingEventId(batchId);
  if (raws.length === 0) return { events: [], appendedEvents: [] };

  return enqueue(meetingId, async () => {
    const state = await loadState(meetingId);
    const requested: MeetingEvent[] = [];
    const appendedEvents: MeetingEvent[] = [];
    const pendingById = new Map<string, MeetingEvent>();
    let nextSeq = state.nextSeq;

    for (const raw of raws) {
      const requestedEventId = raw.eventId ?? randomUUID();
      assertSafeMeetingEventId(requestedEventId);
      const existing = state.eventsById.get(requestedEventId)
        ?? pendingById.get(requestedEventId);
      if (existing) {
        requested.push(existing);
        continue;
      }
      const { eventId: _eventId, ...body } = raw;
      const event = {
        ...body,
        version: MEETING_SCHEMA_VERSION,
        meetingId,
        eventId: requestedEventId,
        seq: nextSeq++,
        timestamp: Date.now(),
      } as MeetingEvent;
      requested.push(event);
      appendedEvents.push(event);
      pendingById.set(event.eventId, event);
    }

    if (appendedEvents.length > 0) {
      const batch: PersistedMeetingEventBatch = {
        kind: 'meeting-event-batch',
        version: 1,
        meetingId,
        batchId,
        events: appendedEvents,
      };
      try {
        await appendRecord(meetingId, state, batch);
      } catch (error) {
        try {
          const recovered = await loadState(meetingId);
          const durableAppended = appendedEvents.map((event) =>
            recovered.eventsById.get(event.eventId));
          const durableRequested = requested.map((event) =>
            recovered.eventsById.get(event.eventId));
          if (
            durableAppended.every((event): event is MeetingEvent => Boolean(event))
            && durableRequested.every((event): event is MeetingEvent => Boolean(event))
          ) {
            return {
              events: durableRequested,
              appendedEvents: durableAppended,
            };
          }
        } catch {
          // Preserve the append error; a later retry performs the same rescan.
        }
        throw new MeetingEventAppendError(
          error,
          appendedEvents.map((event) => event.eventId),
        );
      }
      state.nextSeq = nextSeq;
      state.needsSeparator = false;
      for (const event of appendedEvents) state.eventsById.set(event.eventId, event);
    }

    return { events: requested, appendedEvents };
  });
}

export interface ReadMeetingEventsOptions {
  /** Inclusive durable resume cursor. */
  fromSeq?: number;
  /** Optional maximum count after filtering. */
  limit?: number;
}

/** Read committed events in durable append/sequence order. */
export async function readMeetingEvents(
  meetingId: string,
  options: ReadMeetingEventsOptions = {},
): Promise<MeetingEvent[]> {
  assertSafeCollectionId(meetingId);
  await flushMeetingEventLog(meetingId);
  const fromSeq = Number.isSafeInteger(options.fromSeq) && (options.fromSeq ?? 0) >= 0
    ? options.fromSeq!
    : 0;
  const limit = Number.isSafeInteger(options.limit) && (options.limit ?? 0) >= 0
    ? options.limit
    : undefined;
  const events = (await readFileEvents(meetingId)).filter((event) => event.seq >= fromSeq);
  return limit === undefined ? events : events.slice(0, limit);
}

/** Highest committed sequence, or -1 for a meeting with no event log. */
export async function latestMeetingSequence(meetingId: string): Promise<number> {
  assertSafeCollectionId(meetingId);
  await flushMeetingEventLog(meetingId);
  const state = await loadState(meetingId);
  return state.nextSeq - 1;
}

/** Wait until appends already queued for this meeting settle. Never rejects. */
export async function flushMeetingEventLog(meetingId: string): Promise<void> {
  assertSafeCollectionId(meetingId);
  const pending = appendChains.get(cacheKey(meetingId));
  if (pending) await pending.then(() => undefined, () => undefined);
}

function anonymizeParticipantEvent(
  value: unknown,
  participantIds: ReadonlySet<string>,
): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  if (record.kind === 'meeting-event-batch' && Array.isArray(record.events)) {
    return record.events.reduce(
      (count, event) => count + anonymizeParticipantEvent(event, participantIds),
      0,
    );
  }
  if (typeof record.participantId !== 'string' || !participantIds.has(record.participantId)) {
    return 0;
  }

  let changed = false;
  if (
    typeof record.participantName === 'string'
    && record.participantName !== ARCHIVED_MEETING_PARTICIPANT_NAME
  ) {
    record.participantName = ARCHIVED_MEETING_PARTICIPANT_NAME;
    changed = true;
  }
  for (const key of ['personaId', 'activityId', 'behaviorRevisionId'] as const) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      delete record[key];
      changed = true;
    }
  }
  return changed ? 1 : 0;
}

/**
 * Privacy-erasure rewrite for cached participant attribution in the lossless
 * meeting log. Association is deliberately limited to participant ids already
 * resolved from the authoritative meeting snapshot; text and names are never
 * used to infer ownership.
 */
export async function anonymizeMeetingParticipantEvents(
  meetingId: string,
  participantIds: readonly string[],
): Promise<number> {
  assertSafeCollectionId(meetingId);
  const matchedIds = new Set(participantIds);
  if (matchedIds.size === 0) return 0;

  return enqueue(meetingId, async () => {
    let content: string;
    try {
      content = await fs.readFile(logFilePath(meetingId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    let changedEvents = 0;
    const rewritten = content.split('\n').map((line) => {
      if (!line.trim()) return line;
      try {
        const parsed = JSON.parse(line) as unknown;
        const changed = anonymizeParticipantEvent(parsed, matchedIds);
        changedEvents += changed;
        return changed > 0 ? JSON.stringify(parsed) : line;
      } catch {
        // An unreadable line cannot be associated without guessing. Preserve it
        // byte-for-byte, matching the normal tolerant reader.
        return line;
      }
    }).join('\n');
    if (changedEvents === 0) return 0;

    await writeFileAtomic(logFilePath(meetingId), rewritten);
    const key = cacheKey(meetingId);
    states.delete(key);
    stateInitializers.delete(key);
    return changedEvents;
  });
}

/** Delete the durable log and reset its in-process sequence/idempotency state. */
export async function deleteMeetingEventLog(meetingId: string): Promise<void> {
  assertSafeCollectionId(meetingId);
  await enqueue(meetingId, async () => {
    try {
      await fs.unlink(logFilePath(meetingId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const key = cacheKey(meetingId);
    states.delete(key);
    stateInitializers.delete(key);
  });
}

/** Test seam matching the conversation-log store. */
export function _setMeetingEventLogDirForTests(dir: string): string {
  const previous = logDir();
  logDirOverride = dir;
  states.clear();
  stateInitializers.clear();
  appendChains.clear();
  return previous;
}
