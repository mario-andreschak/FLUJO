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
import { readPersonaRuntimeEventLogConfig, type PersonaRuntimeEventLogConfig } from '@/config/features';
import { assertSafeCollectionId, writeFileAtomic } from '@/utils/storage/backend';
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
const RUNTIME_EVENT_MANIFEST_VERSION = 1 as const;
const SEGMENT_NAME = /^segment-(\d{6})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const RuntimeEventSegmentSchema = z.object({
  name: z.string().regex(SEGMENT_NAME),
  firstSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().min(-1),
  eventCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  closedAt: TimestampSchema.optional(),
}).strict();

export const PersonaRuntimeEventManifestSchema = z.object({
  version: z.literal(RUNTIME_EVENT_MANIFEST_VERSION),
  workspaceId: z.string().min(1).max(256),
  personaId: ReferenceSchema,
  activeSegment: z.string().regex(SEGMENT_NAME),
  nextSeq: z.number().int().nonnegative(),
  segments: z.array(RuntimeEventSegmentSchema).min(1),
}).strict();

export type PersonaRuntimeEventManifest =
  z.infer<typeof PersonaRuntimeEventManifestSchema>;
type RuntimeEventSegment = PersonaRuntimeEventManifest['segments'][number];

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
  manifest: PersonaRuntimeEventManifest;
  manifestDev: bigint;
  manifestIno: bigint;
  manifestBytes: number;
  activeSegmentName: string;
  nextSeq: number;
  recentEventIds: RecentEventIdWindow;
  needsSeparator: boolean;
  dev: bigint;
  ino: bigint;
  parsedBytes: number;
  tailBytes: Buffer;
  mtimeMs: number;
  activeEventCount: number;
}

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

export interface PersonaRuntimeEventLogWorkStats {
  fullRescans: number;
  tailReads: number;
  cacheHits: number;
  bytesParsed: number;
  linesParsed: number;
  rotations: number;
  migrations: number;
  segmentsSkipped: number;
}

const logWorkStats: PersonaRuntimeEventLogWorkStats = {
  fullRescans: 0,
  tailReads: 0,
  cacheHits: 0,
  bytesParsed: 0,
  linesParsed: 0,
  rotations: 0,
  migrations: 0,
  segmentsSkipped: 0,
};

let eventLogRootOverride: string | undefined;
let eventLogConfigOverride: PersonaRuntimeEventLogConfig | undefined;

function eventLogDir(): string {
  if (eventLogRootOverride) {
    return path.join(eventLogRootOverride, getCurrentWorkspace());
  }
  return path.join(getWorkspaceDataDir(), 'db', 'persona-runtime-events');
}

function legacyEventLogPath(personaId: string): string {
  return path.join(eventLogDir(), `${personaId}.jsonl`);
}

function personaEventLogDir(personaId: string): string {
  return path.join(eventLogDir(), personaId);
}

function manifestPath(personaId: string): string {
  return path.join(personaEventLogDir(personaId), 'manifest.json');
}

function segmentPath(personaId: string, name: string): string {
  if (!SEGMENT_NAME.test(name)) {
    throw new Error(`Unsafe Persona runtime event segment name: ${JSON.stringify(name)}`);
  }
  return path.join(personaEventLogDir(personaId), name);
}

function trashPath(personaId: string, name: string): string {
  if (!SEGMENT_NAME.test(name)) {
    throw new Error(`Unsafe Persona runtime event segment name: ${JSON.stringify(name)}`);
  }
  return path.join(personaEventLogDir(personaId), `.trash-${name}`);
}

function segmentName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999_999) {
    throw new Error('Persona runtime event segment index is exhausted.');
  }
  return `segment-${String(index).padStart(6, '0')}.jsonl`;
}

function segmentIndex(name: string): number {
  const match = SEGMENT_NAME.exec(name);
  if (!match) throw new Error(`Invalid Persona runtime event segment: ${name}`);
  return Number(match[1]);
}

function cacheKey(personaId: string): string {
  return workspaceCacheKey('persona-runtime-events', eventLogDir(), personaId);
}

function eventWriterLockId(personaId: string): string {
  const digest = createHash('sha256').update(personaId).digest('hex').slice(0, 40);
  return `runtime_events_${digest}`;
}

async function assertEventLogNotDeleting(personaId: string): Promise<void> {
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
    return { kind: 'skipped' };
  }
}

interface LogScanResult {
  tailBytes: Buffer;
  endOffset: number;
  bytesRead: number;
  stopped: boolean;
}

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
      return { tailBytes: carry, endOffset: start, bytesRead: 0, stopped: false };
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
          return {
            tailBytes: EMPTY_BUFFER,
            endOffset: start,
            bytesRead,
            stopped: true,
          };
        }
      }
      if (lineStart > 0) pending = Buffer.from(pending.subarray(lineStart));
    }
    return {
      tailBytes: pending,
      endOffset: position - pending.length,
      bytesRead,
      stopped: false,
    };
  } finally {
    await handle.close();
  }
}

function warnSkipped(skipped: number, personaId: string, workspaceId: string): void {
  if (skipped > 0) {
    log.warn(`Skipped ${skipped} malformed Persona runtime event line(s).`, {
      personaId,
      workspaceId,
    });
  }
}

function assertManifestInvariants(
  manifest: PersonaRuntimeEventManifest,
  personaId: string,
  workspaceId: string,
): void {
  if (manifest.personaId !== personaId || manifest.workspaceId !== workspaceId) {
    throw new Error(`Persona runtime event manifest identity mismatch for ${personaId}.`);
  }
  const names = new Set<string>();
  let priorLast: number | undefined;
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index];
    if (names.has(segment.name)) {
      throw new Error(`Duplicate Persona runtime event segment ${segment.name}.`);
    }
    names.add(segment.name);
    if (index > 0 && segmentIndex(segment.name) <= segmentIndex(manifest.segments[index - 1].name)) {
      throw new Error('Persona runtime event segments are not monotonically named.');
    }
    const empty = segment.eventCount === 0;
    if (empty !== (segment.lastSeq === segment.firstSeq - 1)) {
      throw new Error(`Invalid empty/range metadata for segment ${segment.name}.`);
    }
    if (!empty && segment.lastSeq < segment.firstSeq) {
      throw new Error(`Invalid sequence range for segment ${segment.name}.`);
    }
    if (priorLast !== undefined && segment.firstSeq !== priorLast + 1) {
      throw new Error('Persona runtime event segment sequence ranges are not contiguous.');
    }
    priorLast = segment.lastSeq;
    const active = segment.name === manifest.activeSegment;
    if (active !== (index === manifest.segments.length - 1)) {
      throw new Error('Persona runtime event manifest must name its final segment active.');
    }
    if (active && segment.closedAt !== undefined) {
      throw new Error('Persona runtime event active segment cannot be closed.');
    }
    if (!active && segment.closedAt === undefined) {
      throw new Error(`Persona runtime event segment ${segment.name} is not closed.`);
    }
  }
  const active = manifest.segments[manifest.segments.length - 1];
  if (manifest.nextSeq < active.lastSeq + 1) {
    throw new Error('Persona runtime event manifest nextSeq precedes durable metadata.');
  }
}

async function statOrUndefined(filePath: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.stat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeManifest(
  personaId: string,
  manifest: PersonaRuntimeEventManifest,
): Promise<{ dev: bigint; ino: bigint; bytes: number }> {
  PersonaRuntimeEventManifestSchema.parse(manifest);
  assertManifestInvariants(manifest, personaId, getCurrentWorkspace());
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFileAtomic(manifestPath(personaId), serialized);
  const stat = await fs.stat(manifestPath(personaId), { bigint: true });
  return { dev: stat.dev, ino: stat.ino, bytes: Number(stat.size) };
}

interface SegmentSummary {
  firstSeq: number;
  lastSeq: number;
  eventCount: number;
  nextSeq: number;
  bytes: number;
  tailBytes: Buffer;
  endOffset: number;
  recentEventIds: RecentEventIdWindow;
}

async function scanSegmentSummary(
  personaId: string,
  filePath: string,
): Promise<SegmentSummary> {
  const workspaceId = getCurrentWorkspace();
  let firstSeq = -1;
  let lastSeq = -1;
  let eventCount = 0;
  let nextSeq = 0;
  let skipped = 0;
  const recentEventIds = new RecentEventIdWindow();
  const scan = await scanLogLines(filePath, 0, EMPTY_BUFFER, (line) => {
    const parsed = parseLogLine(line, personaId, workspaceId);
    if (parsed.kind === 'blank') return;
    if (parsed.kind === 'skipped') {
      skipped += 1;
      return;
    }
    eventCount += 1;
    firstSeq = firstSeq === -1 ? parsed.event.seq : Math.min(firstSeq, parsed.event.seq);
    lastSeq = Math.max(lastSeq, parsed.event.seq);
    nextSeq = Math.max(nextSeq, parsed.event.seq + 1);
    recentEventIds.remember(parsed.event);
  });
  warnSkipped(skipped, personaId, workspaceId);
  return {
    firstSeq: firstSeq === -1 ? nextSeq : firstSeq,
    lastSeq,
    eventCount,
    nextSeq,
    bytes: scan.endOffset + scan.tailBytes.length,
    tailBytes: scan.tailBytes,
    endOffset: scan.endOffset,
    recentEventIds,
  };
}

async function reconcilePublishedFiles(
  personaId: string,
  manifest: PersonaRuntimeEventManifest,
): Promise<void> {
  const dir = personaEventLogDir(personaId);
  for (const segment of manifest.segments) {
    const filePath = segmentPath(personaId, segment.name);
    if (!await statOrUndefined(filePath)) {
      const trashed = trashPath(personaId, segment.name);
      if (await statOrUndefined(trashed)) await fs.rename(trashed, filePath);
    }
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Persona runtime event segment is not a regular link-free file: ${filePath}`);
    }
  }
  const referenced = new Set(manifest.segments.map(segment => segment.name));
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (SEGMENT_NAME.test(entry.name) && !referenced.has(entry.name)) {
      const orphan = path.join(dir, entry.name);
      const stat = await fs.lstat(orphan);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 0) {
        throw new Error(`Non-empty or unsafe orphan Persona runtime event segment: ${orphan}`);
      }
      await fs.unlink(orphan);
      continue;
    }
    if (entry.name.startsWith('.trash-segment-') && entry.isFile()) {
      await fs.unlink(path.join(dir, entry.name)).catch(() => undefined);
    }
  }
}

async function createInitialManifest(
  personaId: string,
): Promise<PersonaRuntimeEventManifest> {
  const workspaceId = getCurrentWorkspace();
  const dir = personaEventLogDir(personaId);
  await fs.mkdir(dir, { recursive: true });
  const firstName = segmentName(1);
  const firstPath = segmentPath(personaId, firstName);
  const legacyPath = legacyEventLogPath(personaId);
  const [legacy, interrupted] = await Promise.all([
    statOrUndefined(legacyPath),
    statOrUndefined(firstPath),
  ]);
  if (legacy && interrupted) {
    throw new Error(`Ambiguous Persona runtime event migration state for ${personaId}.`);
  }
  if (legacy) {
    await fs.rename(legacyPath, firstPath);
    logWorkStats.migrations += 1;
  } else if (!interrupted) {
    await fs.writeFile(firstPath, '', { flag: 'wx' });
  }
  const summary = await scanSegmentSummary(personaId, firstPath);
  const stat = await fs.stat(firstPath);
  const now = runtimeClock.now();
  const firstSeq = summary.eventCount === 0 ? 0 : summary.firstSeq;
  const initial: RuntimeEventSegment = {
    name: firstName,
    firstSeq,
    lastSeq: summary.eventCount === 0 ? firstSeq - 1 : summary.lastSeq,
    eventCount: summary.eventCount,
    bytes: summary.bytes,
    createdAt: Math.max(0, Math.floor(stat.birthtimeMs || stat.ctimeMs || now)),
  };
  const config = eventLogConfigOverride ?? readPersonaRuntimeEventLogConfig();
  const oversized = summary.eventCount > 0 && (
    summary.bytes >= config.maxSegmentBytes
    || summary.eventCount >= config.maxSegmentEvents
  );
  const segments: RuntimeEventSegment[] = [initial];
  let activeSegment = firstName;
  if (oversized) {
    initial.closedAt = now;
    activeSegment = segmentName(2);
    const nextPath = segmentPath(personaId, activeSegment);
    const interruptedNext = await statOrUndefined(nextPath);
    if (interruptedNext) {
      const stat = await fs.lstat(nextPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
        throw new Error(
          `Unsafe interrupted Persona runtime event migration state for ${personaId}.`,
        );
      }
    } else {
      await fs.writeFile(nextPath, '', { flag: 'wx' });
    }
    segments.push({
      name: activeSegment,
      firstSeq: summary.nextSeq,
      lastSeq: summary.nextSeq - 1,
      eventCount: 0,
      bytes: 0,
      createdAt: now,
    });
  }
  const manifest: PersonaRuntimeEventManifest = {
    version: RUNTIME_EVENT_MANIFEST_VERSION,
    workspaceId,
    personaId,
    activeSegment,
    nextSeq: summary.nextSeq,
    segments,
  };
  await writeManifest(personaId, manifest);
  return manifest;
}

async function loadManifest(
  personaId: string,
): Promise<PersonaRuntimeEventManifest> {
  const filePath = manifestPath(personaId);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return createInitialManifest(personaId);
    }
    throw error;
  }
  let manifest: PersonaRuntimeEventManifest;
  try {
    manifest = PersonaRuntimeEventManifestSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error(
      `Invalid Persona runtime event manifest for ${personaId}: ${(error as Error).message}`,
    );
  }
  assertManifestInvariants(manifest, personaId, getCurrentWorkspace());
  await reconcilePublishedFiles(personaId, manifest);
  return manifest;
}

function recentSegmentStart(manifest: PersonaRuntimeEventManifest): number {
  let events = 0;
  for (let index = manifest.segments.length - 1; index >= 0; index -= 1) {
    events += manifest.segments[index].eventCount;
    if (events >= idempotencyWindowLimit) return index;
  }
  return 0;
}

async function buildStateFromManifest(
  personaId: string,
  manifest: PersonaRuntimeEventManifest,
): Promise<PersonaRuntimeEventLogState> {
  logWorkStats.fullRescans += 1;
  const workspaceId = getCurrentWorkspace();
  const recentEventIds = new RecentEventIdWindow();
  let nextSeq = manifest.nextSeq;
  let activeScan: LogScanResult | undefined;
  let activeEventCount = 0;
  let activeFirstSeq = manifest.nextSeq;
  let activeLastSeq = manifest.nextSeq - 1;
  let activeSkipped = 0;
  const startIndex = recentSegmentStart(manifest);
  for (let index = startIndex; index < manifest.segments.length; index += 1) {
    const segment = manifest.segments[index];
    let count = 0;
    let firstSeq = -1;
    let lastSeq = -1;
    const scan = await scanLogLines(
      segmentPath(personaId, segment.name),
      0,
      EMPTY_BUFFER,
      (line) => {
        logWorkStats.linesParsed += 1;
        const parsed = parseLogLine(line, personaId, workspaceId);
        if (parsed.kind === 'blank') return;
        if (parsed.kind === 'skipped') {
          if (segment.name === manifest.activeSegment) activeSkipped += 1;
          return;
        }
        count += 1;
        firstSeq = firstSeq === -1 ? parsed.event.seq : Math.min(firstSeq, parsed.event.seq);
        lastSeq = Math.max(lastSeq, parsed.event.seq);
        nextSeq = Math.max(nextSeq, parsed.event.seq + 1);
        recentEventIds.remember(parsed.event);
      },
    );
    logWorkStats.bytesParsed += scan.bytesRead;
    if (segment.name === manifest.activeSegment) {
      activeScan = scan;
      activeEventCount = count;
      activeFirstSeq = count === 0 ? segment.firstSeq : firstSeq;
      activeLastSeq = count === 0 ? activeFirstSeq - 1 : lastSeq;
    }
  }
  warnSkipped(activeSkipped, personaId, workspaceId);
  if (!activeScan) throw new Error('Persona runtime event active segment was not scanned.');
  const activePath = segmentPath(personaId, manifest.activeSegment);
  const activeStat = await fs.stat(activePath, { bigint: true });
  const active = manifest.segments[manifest.segments.length - 1];
  const activeBytes = activeScan.endOffset + activeScan.tailBytes.length;
  const repaired: PersonaRuntimeEventManifest = {
    ...manifest,
    nextSeq,
    segments: manifest.segments.map((segment, index) => index === manifest.segments.length - 1
      ? {
        ...segment,
        firstSeq: activeFirstSeq,
        lastSeq: activeLastSeq,
        eventCount: activeEventCount,
        bytes: activeBytes,
      }
      : segment),
  };
  const changed = JSON.stringify(repaired) !== JSON.stringify(manifest);
  const manifestIdentity = changed
    ? await writeManifest(personaId, repaired)
    : await fs.stat(manifestPath(personaId), { bigint: true }).then(stat => ({
      dev: stat.dev,
      ino: stat.ino,
      bytes: Number(stat.size),
    }));
  return {
    manifest: repaired,
    manifestDev: manifestIdentity.dev,
    manifestIno: manifestIdentity.ino,
    manifestBytes: manifestIdentity.bytes,
    activeSegmentName: repaired.activeSegment,
    nextSeq,
    recentEventIds,
    needsSeparator: activeScan.tailBytes.length > 0,
    dev: activeStat.dev,
    ino: activeStat.ino,
    parsedBytes: activeScan.endOffset,
    tailBytes: activeScan.tailBytes,
    mtimeMs: Number(activeStat.mtimeMs),
    activeEventCount,
  };
}

async function syncState(personaId: string): Promise<PersonaRuntimeEventLogState> {
  const key = cacheKey(personaId);
  const cached = RUNTIME_EVENT_INCREMENTAL_STATE ? logStates.get(key) : undefined;
  const diskManifest = await statOrUndefined(manifestPath(personaId));
  let manifest: PersonaRuntimeEventManifest;
  let manifestUnchanged = false;
  if (
    cached
    && diskManifest
    && cached.manifestDev === diskManifest.dev
    && cached.manifestIno === diskManifest.ino
    && cached.manifestBytes === Number(diskManifest.size)
  ) {
    manifest = cached.manifest;
    manifestUnchanged = true;
  } else {
    manifest = await loadManifest(personaId);
  }

  const activePath = segmentPath(personaId, manifest.activeSegment);
  const stat = await statOrUndefined(activePath);
  if (!stat) {
    throw new Error(`Missing active Persona runtime event segment ${manifest.activeSegment}.`);
  }
  const active = manifest.segments[manifest.segments.length - 1];
  if (
    !cached
    && !diskManifest
    && manifest.segments.length === 1
    && active.eventCount === 0
    && Number(stat.size) === 0
  ) {
    const manifestStat = await fs.stat(manifestPath(personaId), { bigint: true });
    const initialState: PersonaRuntimeEventLogState = {
      manifest,
      manifestDev: manifestStat.dev,
      manifestIno: manifestStat.ino,
      manifestBytes: Number(manifestStat.size),
      activeSegmentName: manifest.activeSegment,
      nextSeq: manifest.nextSeq,
      recentEventIds: new RecentEventIdWindow(),
      needsSeparator: false,
      dev: stat.dev,
      ino: stat.ino,
      parsedBytes: 0,
      tailBytes: EMPTY_BUFFER,
      mtimeMs: Number(stat.mtimeMs),
      activeEventCount: 0,
    };
    cacheLogState(key, initialState);
    return initialState;
  }
  if (
    cached
    && manifestUnchanged
    && cached.activeSegmentName === manifest.activeSegment
    && cached.dev === stat.dev
    && cached.ino === stat.ino
  ) {
    const size = Number(stat.size);
    const knownBytes = cached.parsedBytes + cached.tailBytes.length;
    if (size === knownBytes) {
      logWorkStats.cacheHits += 1;
      cached.mtimeMs = Number(stat.mtimeMs);
      cacheLogState(key, cached);
      return cached;
    }
    if (size > knownBytes) {
      let skipped = 0;
      let appendedEvents = 0;
      const scan = await scanLogLines(activePath, knownBytes, cached.tailBytes, (line) => {
        logWorkStats.linesParsed += 1;
        const parsed = parseLogLine(line, personaId, getCurrentWorkspace());
        if (parsed.kind === 'blank') return;
        if (parsed.kind === 'skipped') {
          skipped += 1;
          return;
        }
        appendedEvents += 1;
        cached.recentEventIds.remember(parsed.event);
        cached.nextSeq = Math.max(cached.nextSeq, parsed.event.seq + 1);
      });
      logWorkStats.tailReads += 1;
      logWorkStats.bytesParsed += scan.bytesRead;
      cached.parsedBytes = scan.endOffset;
      cached.tailBytes = scan.tailBytes;
      cached.needsSeparator = scan.tailBytes.length > 0;
      cached.activeEventCount += appendedEvents;
      cached.mtimeMs = Number(stat.mtimeMs);
      const active = cached.manifest.segments[cached.manifest.segments.length - 1];
      active.eventCount = cached.activeEventCount;
      active.bytes = size;
      active.lastSeq = cached.nextSeq - 1;
      cached.manifest.nextSeq = cached.nextSeq;
      warnSkipped(skipped, personaId, getCurrentWorkspace());
      cacheLogState(key, cached);
      return cached;
    }
  }

  const state = await buildStateFromManifest(personaId, manifest);
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
  const record = `${state.needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`;
  await fs.appendFile(segmentPath(personaId, state.activeSegmentName), record, 'utf8');
  return Buffer.byteLength(record, 'utf8');
}

async function rotateIfNeeded(
  personaId: string,
  state: PersonaRuntimeEventLogState,
): Promise<void> {
  const config = eventLogConfigOverride ?? readPersonaRuntimeEventLogConfig();
  const active = state.manifest.segments[state.manifest.segments.length - 1];
  if (
    state.activeEventCount === 0
    || (
      active.bytes < config.maxSegmentBytes
      && state.activeEventCount < config.maxSegmentEvents
    )
  ) {
    return;
  }
  const now = runtimeClock.now();
  const newName = segmentName(segmentIndex(active.name) + 1);
  const newPath = segmentPath(personaId, newName);
  await fs.writeFile(newPath, '', { flag: 'wx' });
  const nextManifest: PersonaRuntimeEventManifest = {
    ...state.manifest,
    activeSegment: newName,
    nextSeq: state.nextSeq,
    segments: [
      ...state.manifest.segments.slice(0, -1),
      { ...active, closedAt: now },
      {
        name: newName,
        firstSeq: state.nextSeq,
        lastSeq: state.nextSeq - 1,
        eventCount: 0,
        bytes: 0,
        createdAt: now,
      },
    ],
  };
  let identity;
  try {
    identity = await writeManifest(personaId, nextManifest);
  } catch (error) {
    await fs.unlink(newPath).catch(() => undefined);
    throw error;
  }
  state.manifest = nextManifest;
  state.manifestDev = identity.dev;
  state.manifestIno = identity.ino;
  state.manifestBytes = identity.bytes;
  state.activeSegmentName = newName;
  state.activeEventCount = 0;
  state.needsSeparator = false;
  state.dev = UNKNOWN_FILE_IDENTITY;
  state.ino = UNKNOWN_FILE_IDENTITY;
  state.parsedBytes = 0;
  state.tailBytes = EMPTY_BUFFER;
  state.mtimeMs = now;
  logWorkStats.rotations += 1;
}

export interface AppendPersonaRuntimeEventResult {
  event: PersonaRuntimeEvent;
  appended: boolean;
}

export async function appendPersonaRuntimeEvent(
  personaId: string,
  value: unknown,
): Promise<AppendPersonaRuntimeEventResult> {
  assertSafeCollectionId(personaId);
  const raw = RawPersonaRuntimeEventSchema.parse(value);
  return withPersonaRuntimeLock(eventWriterLockId(personaId), () =>
    enqueue(personaId, async () => {
      await assertEventLogNotDeleting(personaId);
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
        logStates.delete(cacheKey(personaId));
        try {
          const recovered = await syncState(personaId);
          const durable = recovered.recentEventIds.get(raw.eventId);
          if (durable) return { event: durable, appended: true };
        } catch {
          // Preserve the append error; a retry will reconcile from disk.
        }
        throw error;
      }
      state.parsedBytes += state.tailBytes.length + bytesWritten;
      state.tailBytes = EMPTY_BUFFER;
      state.needsSeparator = false;
      state.nextSeq = event.seq + 1;
      state.activeEventCount += 1;
      state.recentEventIds.remember(event);
      const active = state.manifest.segments[state.manifest.segments.length - 1];
      active.eventCount = state.activeEventCount;
      active.bytes = state.parsedBytes;
      active.lastSeq = event.seq;
      state.manifest.nextSeq = state.nextSeq;
      if (state.dev === UNKNOWN_FILE_IDENTITY) {
        try {
          const created = await fs.stat(
            segmentPath(personaId, state.activeSegmentName),
            { bigint: true },
          );
          state.dev = created.dev;
          state.ino = created.ino;
          state.mtimeMs = Number(created.mtimeMs);
        } catch {
          // The next sync performs a full active-segment reconciliation.
        }
      }
      await rotateIfNeeded(personaId, state);
      cacheLogState(cacheKey(personaId), state);
      return { event, appended: true };
    })
  );
}

export interface ReadPersonaRuntimeEventsOptions {
  fromSeq?: number;
  limit?: number;
  tail?: number;
}

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
    const state = await syncState(personaId);
    const workspaceId = getCurrentWorkspace();
    const events: PersonaRuntimeEvent[] = [];
    const seenIds = new Set<string>();
    let skipped = 0;
    let done = false;
    for (const segment of state.manifest.segments) {
      if (segment.closedAt !== undefined && segment.lastSeq < fromSeq) {
        logWorkStats.segmentsSkipped += 1;
        continue;
      }
      await scanLogLines(segmentPath(personaId, segment.name), 0, EMPTY_BUFFER, (line) => {
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
        if (events.length >= limit) {
          done = true;
          return false;
        }
      });
      if (done) break;
    }
    warnSkipped(skipped, personaId, workspaceId);
    return tail !== undefined && limit !== undefined ? events.slice(0, limit) : events;
  });
}

export async function latestPersonaRuntimeEventSequence(personaId: string): Promise<number> {
  assertSafeCollectionId(personaId);
  await flushPersonaRuntimeEvents(personaId);
  return withPersonaRuntimeLock(
    eventWriterLockId(personaId),
    async () => (await syncState(personaId)).nextSeq - 1,
  );
}

export async function flushPersonaRuntimeEvents(personaId: string): Promise<void> {
  assertSafeCollectionId(personaId);
  const pending = appendChains.get(cacheKey(personaId));
  if (pending) await pending.then(() => undefined, () => undefined);
}

export async function deletePersonaRuntimeEvents(personaId: string): Promise<void> {
  assertSafeCollectionId(personaId);
  await withPersonaRuntimeLock(eventWriterLockId(personaId), () =>
    enqueue(personaId, async () => {
      logStates.delete(cacheKey(personaId));
      await fs.rm(personaEventLogDir(personaId), { recursive: true, force: true });
      try {
        await fs.unlink(legacyEventLogPath(personaId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    })
  );
}

export interface PersonaRuntimeEventRetentionResult {
  personasExamined: number;
  segmentsExamined: number;
  segmentsRemoved: number;
  segmentsDeferred: number;
  errors: number;
}

export async function sweepPersonaRuntimeEventSegments(
  config: PersonaRuntimeEventLogConfig =
    eventLogConfigOverride ?? readPersonaRuntimeEventLogConfig(),
): Promise<PersonaRuntimeEventRetentionResult> {
  const result: PersonaRuntimeEventRetentionResult = {
    personasExamined: 0,
    segmentsExamined: 0,
    segmentsRemoved: 0,
    segmentsDeferred: 0,
    errors: 0,
  };
  if (config.retentionDays <= 0) return result;
  let entries;
  try {
    entries = await fs.readdir(eventLogDir(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  const cutoff = runtimeClock.now() - config.retentionDays * DAY_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      assertSafeCollectionId(entry.name);
    } catch {
      result.errors += 1;
      continue;
    }
    const personaId = entry.name;
    result.personasExamined += 1;
    try {
      await withPersonaRuntimeLock(eventWriterLockId(personaId), () =>
        enqueue(personaId, async () => {
          const state = await syncState(personaId);
          const closed = state.manifest.segments.filter(segment => segment.closedAt !== undefined);
          result.segmentsExamined += closed.length;
          const protectedNames = new Set(
            config.maxClosedSegments > 0
              ? closed.slice(-config.maxClosedSegments).map(segment => segment.name)
              : [],
          );
          const candidates = closed.filter(segment =>
            (segment.closedAt ?? Number.MAX_SAFE_INTEGER) < cutoff
            && !protectedNames.has(segment.name));
          if (candidates.length === 0) return;
          const renamed: Array<{ from: string; to: string }> = [];
          try {
            for (const segment of candidates) {
              const from = segmentPath(personaId, segment.name);
              const to = trashPath(personaId, segment.name);
              try {
                await fs.rename(from, to);
                renamed.push({ from, to });
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                result.segmentsDeferred += 1;
              }
            }
            const removedNames = new Set(
              renamed.map(item => path.basename(item.from)),
            );
            const nextManifest: PersonaRuntimeEventManifest = {
              ...state.manifest,
              segments: state.manifest.segments.filter(
                segment => !removedNames.has(segment.name),
              ),
            };
            const identity = await writeManifest(personaId, nextManifest);
            state.manifest = nextManifest;
            state.manifestDev = identity.dev;
            state.manifestIno = identity.ino;
            state.manifestBytes = identity.bytes;
            for (const item of renamed) {
              try {
                await fs.unlink(item.to);
                result.segmentsRemoved += 1;
              } catch {
                result.segmentsDeferred += 1;
              }
            }
          } catch (error) {
            for (const item of renamed.reverse()) {
              await fs.rename(item.to, item.from).catch(() => undefined);
            }
            throw error;
          }
        })
      );
    } catch (error) {
      result.errors += 1;
      log.warn(`Persona runtime event retention failed for ${personaId}.`, error);
    }
  }
  return result;
}

export function _setPersonaRuntimeEventLogRootForTests(
  root: string | undefined,
): string | undefined {
  const previous = eventLogRootOverride;
  eventLogRootOverride = root;
  appendChains.clear();
  logStates.clear();
  return previous;
}

export function _setPersonaRuntimeEventLogConfigForTests(
  config: PersonaRuntimeEventLogConfig | undefined,
): PersonaRuntimeEventLogConfig | undefined {
  const previous = eventLogConfigOverride;
  eventLogConfigOverride = config;
  appendChains.clear();
  logStates.clear();
  return previous;
}

export function _getPersonaRuntimeEventLogPathsForTests(personaId: string): {
  directory: string;
  legacy: string;
  manifest: string;
  activeSegment: string | undefined;
} {
  assertSafeCollectionId(personaId);
  const state = logStates.get(cacheKey(personaId));
  return {
    directory: personaEventLogDir(personaId),
    legacy: legacyEventLogPath(personaId),
    manifest: manifestPath(personaId),
    activeSegment: state
      ? segmentPath(personaId, state.activeSegmentName)
      : undefined,
  };
}

export function _getPersonaRuntimeEventLogStatsForTests(): PersonaRuntimeEventLogWorkStats {
  return { ...logWorkStats };
}

export function _resetPersonaRuntimeEventLogStatsForTests(): void {
  logWorkStats.fullRescans = 0;
  logWorkStats.tailReads = 0;
  logWorkStats.cacheHits = 0;
  logWorkStats.bytesParsed = 0;
  logWorkStats.linesParsed = 0;
  logWorkStats.rotations = 0;
  logWorkStats.migrations = 0;
  logWorkStats.segmentsSkipped = 0;
}

export function _setPersonaRuntimeEventIdempotencyWindowForTests(limit?: number): number {
  const previous = idempotencyWindowLimit;
  idempotencyWindowLimit = Number.isSafeInteger(limit) && (limit ?? 0) > 0
    ? limit!
    : RUNTIME_EVENT_IDEMPOTENCY_WINDOW;
  return previous;
}

export function _getPersonaRuntimeEventLogStateForTests(personaId: string): {
  nextSeq: number;
  parsedBytes: number;
  tailBytesLength: number;
  windowSize: number;
  needsSeparator: boolean;
  activeSegment: string;
  segmentCount: number;
} | undefined {
  const state = logStates.get(cacheKey(personaId));
  if (!state) return undefined;
  return {
    nextSeq: state.nextSeq,
    parsedBytes: state.parsedBytes,
    tailBytesLength: state.tailBytes.length,
    windowSize: state.recentEventIds.size,
    needsSeparator: state.needsSeparator,
    activeSegment: state.activeSegmentName,
    segmentCount: state.manifest.segments.length,
  };
}
