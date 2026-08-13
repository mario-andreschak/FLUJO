import { createHash } from 'crypto';
import { promises as fs } from 'fs';
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

import { withPersonaRuntimeLock } from './runtimeLock';

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

interface PersonaRuntimeEventLogState {
  nextSeq: number;
  eventsById: Map<string, PersonaRuntimeEvent>;
  /** A crash may leave a partial final line without a newline terminator. */
  needsSeparator: boolean;
}

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

function parseEventLines(
  content: string,
  personaId: string,
  workspaceId: string,
): PersonaRuntimeEvent[] {
  const events: PersonaRuntimeEvent[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = PersonaRuntimeEventSchema.parse(JSON.parse(line));
      if (
        event.personaId !== personaId
        || event.workspaceId !== workspaceId
        || seenIds.has(event.eventId)
      ) {
        skipped += 1;
        continue;
      }
      seenIds.add(event.eventId);
      events.push(event);
    } catch {
      // A process may stop halfway through the final append. Complete earlier
      // lines remain authoritative, and the next append inserts a separator.
      skipped += 1;
    }
  }
  if (skipped > 0) {
    log.warn(`Skipped ${skipped} malformed Persona runtime event line(s).`, {
      personaId,
      workspaceId,
    });
  }
  return events;
}

async function readFileSnapshot(
  personaId: string,
): Promise<{ events: PersonaRuntimeEvent[]; needsSeparator: boolean }> {
  let content: string;
  try {
    content = await fs.readFile(eventLogPath(personaId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], needsSeparator: false };
    }
    throw error;
  }
  return {
    events: parseEventLines(content, personaId, getCurrentWorkspace()),
    needsSeparator: content.length > 0 && !content.endsWith('\n'),
  };
}

async function reloadState(personaId: string): Promise<PersonaRuntimeEventLogState> {
  const { events, needsSeparator } = await readFileSnapshot(personaId);
  let maxSeq = -1;
  const eventsById = new Map<string, PersonaRuntimeEvent>();
  for (const event of events) {
    maxSeq = Math.max(maxSeq, event.seq);
    eventsById.set(event.eventId, event);
  }
  return { nextSeq: maxSeq + 1, eventsById, needsSeparator };
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
): Promise<void> {
  await fs.mkdir(eventLogDir(), { recursive: true });
  const separator = state.needsSeparator ? '\n' : '';
  await fs.appendFile(
    eventLogPath(personaId),
    `${separator}${JSON.stringify(event)}\n`,
    'utf8',
  );
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
      // Always rescan while holding the cross-process writer lock. An in-memory
      // nextSeq can be stale after another FLUJO process appended to the JSONL.
      const state = await reloadState(personaId);
      const existing = state.eventsById.get(raw.eventId);
      if (existing) return { event: existing, appended: false };

      const event = PersonaRuntimeEventSchema.parse({
        ...raw,
        version: PERSONA_RUNTIME_EVENT_VERSION,
        workspaceId: getCurrentWorkspace(),
        personaId,
        seq: state.nextSeq,
        timestamp: Date.now(),
      });
      try {
        await appendRecord(personaId, state, event);
      } catch (error) {
        // Some filesystems may reject after the full record reached disk.
        // Rescan and accept the exact durable id so a retry cannot duplicate it.
        try {
          const recovered = await reloadState(personaId);
          const durable = recovered.eventsById.get(raw.eventId);
          if (durable) return { event: durable, appended: true };
        } catch {
          // Preserve the append error; a later retry performs the same rescan.
        }
        throw error;
      }
      state.nextSeq += 1;
      state.needsSeparator = false;
      state.eventsById.set(event.eventId, event);
      return { event, appended: true };
    })
  );
}

export interface ReadPersonaRuntimeEventsOptions {
  /** Inclusive durable resume cursor. */
  fromSeq?: number;
  /** Optional maximum count after filtering. */
  limit?: number;
}

/** Read committed observations in durable append order. */
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
  return withPersonaRuntimeLock(eventWriterLockId(personaId), async () => {
    const events = (await readFileSnapshot(personaId)).events
      .filter((event) => event.seq >= fromSeq);
    return limit === undefined ? events : events.slice(0, limit);
  });
}

/** Highest committed sequence, or -1 when no observations exist. */
export async function latestPersonaRuntimeEventSequence(personaId: string): Promise<number> {
  assertSafeCollectionId(personaId);
  const events = await readPersonaRuntimeEvents(personaId);
  return events.reduce((maximum, event) => Math.max(maximum, event.seq), -1);
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
  return previous;
}
