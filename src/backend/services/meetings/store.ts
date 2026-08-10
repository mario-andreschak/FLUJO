import { randomUUID } from 'crypto';
import type {
  CreateMeetingInput,
  MeetingParticipant,
  MeetingPolicy,
  MeetingRecord,
  MeetingSummary,
} from '@/shared/types/meeting';
import {
  BehaviorSlotKeySchema,
  EnduringAgentIdSchema,
} from '@/shared/types/enduringAgent';
import {
  DEFAULT_MEETING_POLICY,
  MEETING_SCHEMA_VERSION,
} from '@/shared/types/meeting';
import {
  assertSafeCollectionId,
  deleteCollectionItem,
  listCollectionItemEntriesStrict,
  listCollectionItems,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { createLogger } from '@/utils/logger';
import {
  anonymizeMeetingParticipantEvents,
  deleteMeetingEventLog,
} from './eventLog';
import { withMeetingControlLock } from './controlLock';
import { ARCHIVED_MEETING_PARTICIPANT_NAME } from '@/shared/types/meeting';

const log = createLogger('backend/services/meetings/store');

export const MEETINGS_COLLECTION = 'meetings';
export const MIN_MEETING_PARTICIPANTS = 2;
export const MAX_MEETING_PARTICIPANTS = 16;

function requireNonEmpty(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is required`);
  try {
    assertSafeCollectionId(value);
  } catch {
    throw new Error(`${label} is unsafe`);
  }
  return value;
}

function requireBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function normalizeMeetingPolicy(input: Partial<MeetingPolicy> = {}): MeetingPolicy {
  const policy: MeetingPolicy = { ...DEFAULT_MEETING_POLICY, ...input };
  if (policy.roundMode !== 'barrier') throw new Error('Unsupported meeting round mode');
  if (policy.entryMode !== 'start-each-round') throw new Error('Unsupported meeting entry mode');
  policy.maxRounds = requireBoundedInteger(policy.maxRounds, 'maxRounds', 1, 100);
  policy.concurrencyLimit = requireBoundedInteger(
    policy.concurrencyLimit,
    'concurrencyLimit',
    1,
    MAX_MEETING_PARTICIPANTS,
  );
  if (!['collect-all', 'fail-fast'].includes(policy.errorStrategy)) {
    throw new Error('Unsupported meeting error strategy');
  }
  if (!['none', 'bookends', 'facilitated'].includes(policy.moderatorMode)) {
    throw new Error('Unsupported meeting moderator mode');
  }
  if (!['majority', 'unanimous'].includes(policy.finishThreshold)) {
    throw new Error('Unsupported meeting finish threshold');
  }
  if (!['finish', 'continue'].includes(policy.allSilentBehavior)) {
    throw new Error('Unsupported all-silent behavior');
  }
  return policy;
}

function normalizeParticipants(
  input: CreateMeetingInput,
  moderatorIdFromInput?: string,
): { participants: MeetingParticipant[]; moderatorParticipantId?: string } {
  if (!Array.isArray(input.participants)) throw new Error('participants must be an array');
  if (
    input.participants.length < MIN_MEETING_PARTICIPANTS
    || input.participants.length > MAX_MEETING_PARTICIPANTS
  ) {
    throw new Error(
      `A meeting requires between ${MIN_MEETING_PARTICIPANTS} and ${MAX_MEETING_PARTICIPANTS} participants`,
    );
  }

  const participants = input.participants.map((candidate, index): MeetingParticipant => {
    const hasFlow = typeof candidate.flowId === 'string' && candidate.flowId.length > 0;
    const hasPersona = typeof candidate.personaId === 'string' && candidate.personaId.length > 0;
    if (hasFlow === hasPersona) {
      throw new Error(`participants[${index}] must target exactly one Flow or Persona`);
    }
    if (candidate.behaviorSlotKey !== undefined && !hasPersona) {
      throw new Error(`participants[${index}].behaviorSlotKey requires a Persona target`);
    }
    const personaId = hasPersona
      ? EnduringAgentIdSchema.parse(candidate.personaId)
      : undefined;
    const behaviorSlotKey = candidate.behaviorSlotKey === undefined
      ? undefined
      : BehaviorSlotKeySchema.parse(candidate.behaviorSlotKey);
    return {
      id: candidate.id === undefined
        ? randomUUID()
        : requireSafeId(candidate.id, `participants[${index}].id`),
      name: requireNonEmpty(candidate.name, `participants[${index}].name`, 80),
      ...(hasFlow
        ? { flowId: requireSafeId(candidate.flowId!, `participants[${index}].flowId`) }
        : { personaId }),
      ...(behaviorSlotKey ? { behaviorSlotKey } : {}),
      conversationId: candidate.conversationId === undefined
        ? randomUUID()
        : requireSafeId(candidate.conversationId, `participants[${index}].conversationId`),
      role: candidate.role ?? 'participant',
      status: 'idle',
      lastDeliveredSeq: -1,
    };
  });

  const participantIds = new Set<string>();
  const conversationIds = new Set<string>();
  const names = new Set<string>();
  const personaIds = new Set<string>();
  for (const participant of participants) {
    if (!['participant', 'moderator'].includes(participant.role)) {
      throw new Error(`Unsupported role for participant ${participant.id}`);
    }
    if (participantIds.has(participant.id)) throw new Error(`Duplicate participant id: ${participant.id}`);
    if (conversationIds.has(participant.conversationId)) {
      throw new Error(`Duplicate participant conversation id: ${participant.conversationId}`);
    }
    const foldedName = participant.name.toLocaleLowerCase();
    if (names.has(foldedName)) throw new Error(`Duplicate participant name: ${participant.name}`);
    participantIds.add(participant.id);
    conversationIds.add(participant.conversationId);
    names.add(foldedName);
    if (participant.personaId) {
      if (personaIds.has(participant.personaId)) {
        throw new Error(`Duplicate Persona participant: ${participant.personaId}`);
      }
      personaIds.add(participant.personaId);
    }
  }

  const roleModerators = participants.filter((participant) => participant.role === 'moderator');
  if (roleModerators.length > 1) throw new Error('A meeting can have at most one moderator');

  const moderatorParticipantId = moderatorIdFromInput ?? roleModerators[0]?.id;
  if (moderatorParticipantId !== undefined) {
    requireSafeId(moderatorParticipantId, 'moderatorParticipantId');
    if (!participantIds.has(moderatorParticipantId)) {
      throw new Error('moderatorParticipantId must reference a meeting participant');
    }
    if (roleModerators.length === 1 && roleModerators[0].id !== moderatorParticipantId) {
      throw new Error('Participant role and moderatorParticipantId disagree');
    }
    for (const participant of participants) {
      participant.role = participant.id === moderatorParticipantId ? 'moderator' : 'participant';
    }
  }

  return { participants, moderatorParticipantId };
}

/** Pure, validated construction used by the service and import/recovery code. */
export function createMeetingRecord(input: CreateMeetingInput): MeetingRecord {
  const id = input.id === undefined ? randomUUID() : requireSafeId(input.id, 'meeting id');
  const title = requireNonEmpty(input.title, 'title', 160);
  const openingPrompt = requireNonEmpty(input.openingPrompt, 'openingPrompt', 100_000);
  const parentMeetingId = input.parentMeetingId === undefined
    ? undefined
    : requireSafeId(input.parentMeetingId, 'parentMeetingId');
  if (parentMeetingId === id) throw new Error('A meeting cannot be its own parent');

  const policy = normalizeMeetingPolicy(input.policy);
  const { participants, moderatorParticipantId } = normalizeParticipants(
    input,
    input.moderatorParticipantId,
  );
  if (policy.moderatorMode !== 'none' && !moderatorParticipantId) {
    throw new Error(`${policy.moderatorMode} moderator mode requires a moderator participant`);
  }

  const now = Date.now();
  return {
    version: MEETING_SCHEMA_VERSION,
    id,
    title,
    openingPrompt,
    status: 'draft',
    phase: 'draft',
    ...(parentMeetingId ? { parentMeetingId } : {}),
    participants,
    ...(moderatorParticipantId ? { moderatorParticipantId } : {}),
    policy,
    roundNumber: 0,
    motions: [],
    lastEventSeq: -1,
    createdAt: now,
    updatedAt: now,
  };
}

function assertMeetingRecord(record: MeetingRecord): void {
  if (!record || record.version !== MEETING_SCHEMA_VERSION) {
    throw new Error('Unsupported or missing meeting schema version');
  }
  requireSafeId(record.id, 'meeting id');
  requireNonEmpty(record.title, 'title', 160);
  requireNonEmpty(record.openingPrompt, 'openingPrompt', 100_000);
  if (!Array.isArray(record.participants)) throw new Error('participants must be an array');
  if (record.participants.length < MIN_MEETING_PARTICIPANTS) {
    throw new Error(`A meeting requires at least ${MIN_MEETING_PARTICIPANTS} participants`);
  }
  const ids = new Set<string>();
  const conversationIds = new Set<string>();
  const personaIds = new Set<string>();
  for (const participant of record.participants) {
    requireSafeId(participant.id, 'participant id');
    const hasFlow = typeof participant.flowId === 'string' && participant.flowId.length > 0;
    const hasPersona = typeof participant.personaId === 'string' && participant.personaId.length > 0;
    const hasArchivedPersona = participant.personaArchived === true;
    const hasRetiredPersona = participant.personaRetired === true;
    if (Number(hasFlow) + Number(hasPersona) + Number(hasArchivedPersona) !== 1) {
      throw new Error(
        `Participant ${participant.id} must target exactly one Flow, Persona, or archived Persona`,
      );
    }
    if (participant.personaArchived !== undefined && !hasArchivedPersona) {
      throw new Error(`Participant ${participant.id} has an invalid archived Persona marker`);
    }
    if (participant.personaRetired !== undefined && !hasRetiredPersona) {
      throw new Error(`Participant ${participant.id} has an invalid retired Persona marker`);
    }
    if (hasRetiredPersona && !hasPersona && !hasArchivedPersona) {
      throw new Error(`Retired participant ${participant.id} must retain or archive its Persona target`);
    }
    if ((hasArchivedPersona || hasRetiredPersona) && participant.status !== 'left') {
      throw new Error(`Archived or retired participant ${participant.id} must have left the meeting`);
    }
    if (hasFlow) requireSafeId(participant.flowId!, 'participant flow id');
    if (hasPersona) {
      EnduringAgentIdSchema.parse(participant.personaId);
      if (personaIds.has(participant.personaId!)) {
        throw new Error(`Duplicate Persona participant: ${participant.personaId}`);
      }
      personaIds.add(participant.personaId!);
    }
    if (participant.behaviorSlotKey !== undefined) {
      if (!hasPersona && !hasArchivedPersona) {
        throw new Error('A participant Behavior slot requires a Persona target');
      }
      BehaviorSlotKeySchema.parse(participant.behaviorSlotKey);
    }
    if (participant.activityId !== undefined) EnduringAgentIdSchema.parse(participant.activityId);
    if (participant.behaviorRevisionId !== undefined) {
      if (!hasPersona) throw new Error('A participant Behavior revision pin requires a Persona target');
      EnduringAgentIdSchema.parse(participant.behaviorRevisionId);
    }
    requireSafeId(participant.conversationId, 'participant conversation id');
    requireNonEmpty(participant.name, 'participant name', 80);
    if (ids.has(participant.id)) throw new Error(`Duplicate participant id: ${participant.id}`);
    if (conversationIds.has(participant.conversationId)) {
      throw new Error(`Duplicate participant conversation id: ${participant.conversationId}`);
    }
    ids.add(participant.id);
    conversationIds.add(participant.conversationId);
  }
  if (record.moderatorParticipantId && !ids.has(record.moderatorParticipantId)) {
    throw new Error('moderatorParticipantId must reference a meeting participant');
  }
  normalizeMeetingPolicy(record.policy);
  if (!Number.isSafeInteger(record.roundNumber) || record.roundNumber < 0) {
    throw new Error('roundNumber must be a non-negative integer');
  }
  if (!Number.isSafeInteger(record.lastEventSeq) || record.lastEventSeq < -1) {
    throw new Error('lastEventSeq must be -1 or a non-negative integer');
  }
  if (
    record.personaReservationGeneration !== undefined
    && (
      !Number.isSafeInteger(record.personaReservationGeneration)
      || record.personaReservationGeneration < 1
    )
  ) {
    throw new Error('personaReservationGeneration must be a positive safe integer');
  }
  const intent = record.personaReservationIntent;
  if (intent) {
    if (
      !Number.isSafeInteger(intent.generation)
      || intent.generation < 1
      || intent.generation !== record.personaReservationGeneration
    ) {
      throw new Error('Persona reservation intent generation must match the meeting generation');
    }
    requireNonEmpty(intent.attemptId, 'Persona reservation intent attemptId', 160);
    requireNonEmpty(intent.ownerId, 'Persona reservation intent ownerId', 160);
    if (intent.state !== 'reserving' && intent.state !== 'running') {
      throw new Error('Unsupported Persona reservation intent state');
    }
    for (const [label, timestamp] of [
      ['createdAt', intent.createdAt],
      ['updatedAt', intent.updatedAt],
      ['expiresAt', intent.expiresAt],
    ] as const) {
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error(`Persona reservation intent ${label} must be a non-negative safe integer`);
      }
    }
    if (intent.updatedAt < intent.createdAt || intent.expiresAt <= intent.updatedAt) {
      throw new Error('Persona reservation intent timestamps are inconsistent');
    }
  }
}

export interface MeetingPersonaAnonymizationResult {
  meetings: number;
  participants: number;
  events: number;
}

export interface MeetingPersonaRetirementResult {
  meetings: number;
  participants: number;
}

function isTerminalMeeting(meeting: MeetingRecord): boolean {
  return meeting.status === 'completed'
    || meeting.status === 'cancelled'
    || meeting.status === 'error';
}

/** Live and archived Persona meetings share the strict-local read boundary. */
export function isPersonaScopedMeeting(meeting: Pick<MeetingRecord, 'participants'>): boolean {
  return meeting.participants.some((participant) => Boolean(
    participant.personaId || participant.personaArchived || participant.personaRetired,
  ));
}

function fenceMeetingRuntime(meeting: MeetingRecord): void {
  meeting.personaReservationGeneration = (meeting.personaReservationGeneration ?? 0) + 1;
  meeting.personaReservationIntent = undefined;
}

/**
 * Stop exact Persona participants in live meetings without changing retained
 * attribution evidence. Terminal meeting snapshots are deliberately untouched.
 */
export async function retireMeetingPersonaParticipants(
  personaId: string,
): Promise<MeetingPersonaRetirementResult> {
  EnduringAgentIdSchema.parse(personaId);
  const result: MeetingPersonaRetirementResult = { meetings: 0, participants: 0 };
  const entries = await listCollectionItemEntriesStrict<MeetingRecord>(MEETINGS_COLLECTION);
  for (const { id, item } of entries) {
    assertMeetingRecord(item);
    if (item.id !== id) {
      throw new Error(`Meeting snapshot ${id} contains mismatched id ${item.id}`);
    }
    await withMeetingControlLock(id, async () => {
      const current = await loadCollectionItem<MeetingRecord | null>(MEETINGS_COLLECTION, id, null);
      if (!current) return;
      assertMeetingRecord(current);
      if (current.id !== id || isTerminalMeeting(current)) return;
      const retired = structuredClone(current);
      let changed = 0;
      for (const participant of retired.participants) {
        if (participant.personaId !== personaId || participant.personaRetired) continue;
        participant.status = 'left';
        participant.personaRetired = true;
        changed += 1;
      }
      if (changed === 0) return;
      // Advancing and clearing the durable start intent makes every stale
      // MeetingEngine handle fail assertOwnedStartIntent before its next commit.
      fenceMeetingRuntime(retired);
      assertMeetingRecord(retired);
      await saveCollectionItem(MEETINGS_COLLECTION, id, retired);
      result.meetings += 1;
      result.participants += changed;
    });
  }
  return result;
}

/**
 * Replace exact Persona participant references with a nonidentifying archival
 * marker. Event-log names are rewritten first so a retry can always recover
 * the participant-id association from the still-identifying snapshot.
 */
export async function anonymizeMeetingPersonaAttribution(
  personaId: string,
): Promise<MeetingPersonaAnonymizationResult> {
  EnduringAgentIdSchema.parse(personaId);
  const result: MeetingPersonaAnonymizationResult = {
    meetings: 0,
    participants: 0,
    events: 0,
  };
  const entries = await listCollectionItemEntriesStrict<MeetingRecord>(MEETINGS_COLLECTION);
  for (const { id, item } of entries) {
    assertMeetingRecord(item);
    if (item.id !== id) {
      throw new Error(`Meeting snapshot ${id} contains mismatched id ${item.id}`);
    }
    await withMeetingControlLock(id, async () => {
      const current = await loadCollectionItem<MeetingRecord | null>(MEETINGS_COLLECTION, id, null);
      if (!current) return;
      assertMeetingRecord(current);
      if (current.id !== id) {
        throw new Error(`Meeting snapshot ${id} contains mismatched id ${current.id}`);
      }
      const targets = current.participants
        .filter((participant) => participant.personaId === personaId);
      if (targets.length === 0) return;
      const participantIds = targets.map((participant) => participant.id);

      // Keep the exact participant-id association durable until cached event
      // names have been scrubbed; a crash between writes remains retryable.
      result.events += await anonymizeMeetingParticipantEvents(id, participantIds);
      const archived = structuredClone(current);
      if (!isTerminalMeeting(archived) && targets.some((participant) => !participant.personaRetired)) {
        fenceMeetingRuntime(archived);
      }
      for (const participant of archived.participants) {
        if (participant.personaId !== personaId) continue;
        delete participant.personaId;
        delete participant.activityId;
        delete participant.behaviorRevisionId;
        participant.personaRetired = true;
        participant.personaArchived = true;
        participant.name = ARCHIVED_MEETING_PARTICIPANT_NAME;
        participant.status = 'left';
        result.participants += 1;
      }
      assertMeetingRecord(archived);
      await saveCollectionItem(MEETINGS_COLLECTION, id, archived);
      result.meetings += 1;
    });
  }
  return result;
}

export function summarizeMeeting(meeting: MeetingRecord): MeetingSummary {
  return {
    id: meeting.id,
    title: meeting.title,
    status: meeting.status,
    phase: meeting.phase,
    roundNumber: meeting.roundNumber,
    participantCount: meeting.participants.length,
    activeParticipantCount: meeting.participants.filter(
      (participant) => participant.status !== 'left' && participant.status !== 'error',
    ).length,
    participantNames: meeting.participants.map((participant) => participant.name),
    ...(meeting.moderatorParticipantId
      ? { moderatorParticipantId: meeting.moderatorParticipantId }
      : {}),
    createdAt: meeting.createdAt,
    updatedAt: meeting.updatedAt,
    ...(meeting.startedAt === undefined ? {} : { startedAt: meeting.startedAt }),
    ...(meeting.completedAt === undefined ? {} : { completedAt: meeting.completedAt }),
  };
}

/** Remove internal owner/fencing metadata before serializing a meeting to an API client. */
export function sanitizeMeetingForApi(meeting: MeetingRecord): MeetingRecord {
  const {
    personaReservationGeneration: _generation,
    personaReservationIntent: _intent,
    ...visible
  } = meeting;
  return structuredClone(visible) as MeetingRecord;
}

export async function createMeeting(
  input: CreateMeetingInput,
  personaBehaviorRevisionPins: ReadonlyMap<string, string> = new Map(),
): Promise<MeetingRecord> {
  const record = createMeetingRecord(input);
  const pinnedPersonaIds = new Set<string>();
  for (const participant of record.participants) {
    if (!participant.personaId) continue;
    const revisionId = personaBehaviorRevisionPins.get(participant.personaId);
    if (!revisionId) continue;
    participant.behaviorRevisionId = EnduringAgentIdSchema.parse(revisionId);
    pinnedPersonaIds.add(participant.personaId);
  }
  if (pinnedPersonaIds.size !== personaBehaviorRevisionPins.size) {
    throw new Error('A meeting Behavior revision pin must reference a Persona participant');
  }
  assertMeetingRecord(record);
  const existing = await loadCollectionItem<MeetingRecord | null>(
    MEETINGS_COLLECTION,
    record.id,
    null,
  );
  if (existing) throw new Error(`Meeting already exists: ${record.id}`);
  await saveCollectionItem(MEETINGS_COLLECTION, record.id, record);
  return record;
}

export async function getMeeting(meetingId: string): Promise<MeetingRecord | null> {
  assertSafeCollectionId(meetingId);
  const meeting = await loadCollectionItem<MeetingRecord | null>(
    MEETINGS_COLLECTION,
    meetingId,
    null,
  );
  if (!meeting) return null;
  try {
    assertMeetingRecord(meeting);
    return meeting;
  } catch (error) {
    log.warn(`Ignoring invalid meeting snapshot ${meetingId}`, { error });
    return null;
  }
}

/** Persist a coordinator-owned snapshot and refresh its updatedAt timestamp. */
export async function saveMeeting(record: MeetingRecord): Promise<MeetingRecord> {
  assertMeetingRecord(record);
  const persisted = { ...record, updatedAt: Date.now() };
  await saveCollectionItem(MEETINGS_COLLECTION, persisted.id, persisted);
  return persisted;
}

export async function listMeetings(): Promise<MeetingRecord[]> {
  const meetings = await listCollectionItems<MeetingRecord>(MEETINGS_COLLECTION);
  const valid: MeetingRecord[] = [];
  for (const meeting of meetings) {
    try {
      assertMeetingRecord(meeting);
      valid.push(meeting);
    } catch (error) {
      log.warn('Ignoring invalid meeting snapshot while listing', {
        meetingId: meeting?.id,
        error,
      });
    }
  }
  return valid.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function listMeetingSummaries(): Promise<MeetingSummary[]> {
  return (await listMeetings()).map(summarizeMeeting);
}

/** Delete both the projection snapshot and its lossless transcript. */
export async function deleteMeeting(meetingId: string): Promise<void> {
  assertSafeCollectionId(meetingId);
  await Promise.all([
    deleteCollectionItem(MEETINGS_COLLECTION, meetingId),
    deleteMeetingEventLog(meetingId),
  ]);
}
