import type { UsageTotals } from './execution/events';
import type { ModelMediaPart } from './model/media';

/** Persisted schema version for the first multi-agent meeting runtime. */
export const MEETING_SCHEMA_VERSION = 1 as const;
export const ARCHIVED_MEETING_PARTICIPANT_NAME = 'Archived participant' as const;

export type MeetingStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'error';

export type MeetingPhase =
  | 'draft'
  | 'opening'
  | 'discussion'
  | 'ballot'
  | 'breakout'
  | 'closing'
  | 'completed';

export type MeetingParticipantRole = 'participant' | 'moderator';

export type MeetingParticipantStatus =
  | 'idle'
  | 'running'
  | 'breakout'
  | 'left'
  | 'error';

export interface MeetingParticipant {
  id: string;
  name: string;
  /** Legacy direct-Flow target; absent for a Persona participant. */
  flowId?: string;
  /** Trusted Persona target. Absence means intentionally Persona-less. */
  personaId?: string;
  /**
   * Nonidentifying tombstone for a participant whose Persona attribution was
   * erased. Archived participants are retained as meeting evidence but cannot
   * be scheduled for another turn.
  */
  personaArchived?: true;
  /** Permanent runtime fence when a deleted Persona id remains as evidence. */
  personaRetired?: true;
  /** Optional Role Behavior slot used when reserving the Persona. */
  behaviorSlotKey?: string;
  /** Friendly Behavior name frozen for meeting display; never used for execution. */
  behaviorName?: string;
  /** Safe attribution for the currently owned meeting Activity lease. */
  activityId?: string;
  /**
   * Durable immutable BehaviorRevision admitted for this participant. New
   * meetings persist it at creation; legacy snapshots backfill it once before
   * reservation so pause/crash recovery cannot adopt a changed binding.
   */
  behaviorRevisionId?: string;
  /** A participant owns a private, durable flow conversation. */
  conversationId: string;
  role: MeetingParticipantRole;
  status: MeetingParticipantStatus;
  /** Last public/private meeting event delivered to this participant. */
  lastDeliveredSeq: number;
  /** Stable id of the participant's most recently scheduled turn. */
  lastTurnId?: string;
  error?: string;
}

export type MeetingModeratorMode = 'none' | 'bookends' | 'facilitated';

export interface MeetingPolicy {
  roundMode: 'barrier';
  entryMode: 'start-each-round';
  maxRounds: number;
  concurrencyLimit: number;
  errorStrategy: 'collect-all' | 'fail-fast';
  moderatorMode: MeetingModeratorMode;
  finishThreshold: 'majority' | 'unanimous';
  allSilentBehavior: 'finish' | 'continue';
}

export const DEFAULT_MEETING_POLICY: Readonly<MeetingPolicy> = Object.freeze({
  roundMode: 'barrier',
  entryMode: 'start-each-round',
  maxRounds: 6,
  concurrencyLimit: 4,
  errorStrategy: 'collect-all',
  moderatorMode: 'none',
  finishThreshold: 'majority',
  allSilentBehavior: 'finish',
});

export type MeetingRoundPhase = Exclude<MeetingPhase, 'draft' | 'completed'>;
export type MeetingRoundStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'error';

export interface MeetingRound {
  id: string;
  number: number;
  phase: MeetingRoundPhase;
  status: MeetingRoundStatus;
  /** Last committed meeting event visible when this round was frozen. */
  snapshotSeq: number;
  eligibleParticipantIds: string[];
  /** Stable participant -> turn mapping used for crash reconciliation. */
  participantTurnIds: Record<string, string>;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/**
 * Durable owner/fence for a Persona meeting runtime. The generation is never
 * reused: a successor that observes an expired intent advances it before it
 * routes any new Persona mailbox work.
 */
export interface MeetingPersonaReservationIntent {
  generation: number;
  attemptId: string;
  ownerId: string;
  state: 'reserving' | 'running';
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type MeetingMotionKind = 'finish' | 'cancel' | 'followup';
export type MeetingVoteChoice = 'yes' | 'no' | 'abstain';
export type MeetingMotionStatus = 'open' | 'accepted' | 'rejected' | 'cancelled';

export interface MeetingVote {
  participantId: string;
  choice: MeetingVoteChoice;
  rationale?: string;
  castAt: number;
}

export interface MeetingMotion {
  id: string;
  kind: MeetingMotionKind;
  proposal?: string;
  reason?: string;
  proposedByParticipantId: string;
  roundId: string;
  status: MeetingMotionStatus;
  votes: MeetingVote[];
  createdAt: number;
  resolvedAt?: number;
}

export interface MeetingRecord {
  version: typeof MEETING_SCHEMA_VERSION;
  id: string;
  title: string;
  openingPrompt: string;
  /** Optional files delivered with the opening brief on each participant's first turn. */
  openingMedia?: ModelMediaPart[];
  status: MeetingStatus;
  phase: MeetingPhase;
  parentMeetingId?: string;
  participants: MeetingParticipant[];
  moderatorParticipantId?: string;
  policy: MeetingPolicy;
  /** Number of the latest round created; zero before execution starts. */
  roundNumber: number;
  activeRound?: MeetingRound;
  motions: MeetingMotion[];
  usage?: UsageTotals;
  /** Snapshot high-water mark in the append-only meeting event log. */
  lastEventSeq: number;
  /** Highest durable start/reservation generation ever allocated for this meeting. */
  personaReservationGeneration?: number;
  /** Internal live start/runtime ownership fence (also identifies Persona reservations). */
  personaReservationIntent?: MeetingPersonaReservationIntent;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface CreateMeetingParticipantInput {
  id?: string;
  name: string;
  /** Exactly one of flowId or personaId is required. */
  flowId?: string;
  personaId?: string;
  behaviorSlotKey?: string;
  /** Friendly display snapshot for a selected specialist Behavior. */
  behaviorName?: string;
  conversationId?: string;
  role?: MeetingParticipantRole;
}

export interface CreateMeetingInput {
  /** Optional for import/recovery and deterministic tests; generated otherwise. */
  id?: string;
  title: string;
  openingPrompt: string;
  openingMedia?: ModelMediaPart[];
  participants: CreateMeetingParticipantInput[];
  moderatorParticipantId?: string;
  policy?: Partial<MeetingPolicy>;
  parentMeetingId?: string;
}

export interface MeetingSummary {
  id: string;
  title: string;
  status: MeetingStatus;
  phase: MeetingPhase;
  roundNumber: number;
  participantCount: number;
  activeParticipantCount: number;
  participantNames: string[];
  moderatorParticipantId?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** Actions accepted from the fixed synthetic meeting tool block. */
export type MeetingToolAction =
  | {
      type: 'control';
      action: 'silent' | 'leave';
      reason?: string;
    }
  | {
      type: 'private-message';
      to: string[];
      content: string;
    }
  | {
      type: 'propose-motion';
      kind: MeetingMotionKind;
      proposal?: string;
      reason?: string;
    }
  | {
      type: 'cast-vote';
      motionId: string;
      choice: MeetingVoteChoice;
      rationale?: string;
    }
  | {
      type: 'request-breakout';
      participants: string[];
      topic: string;
      maxRounds?: number;
    };

/** `public` is visible to the whole meeting; an array is an explicit ACL. */
export type MeetingEventAudience = 'public' | string[];

export type MeetingEventType =
  | 'meeting:created'
  | 'meeting:started'
  | 'meeting:paused'
  | 'meeting:closing'
  | 'meeting:completed'
  | 'meeting:cancelled'
  | 'meeting:error'
  | 'round:started'
  | 'round:completed'
  | 'participant:started'
  | 'participant:spoke'
  | 'participant:silent'
  | 'participant:left'
  | 'participant:error'
  | 'private-message'
  | 'private-note'
  | 'moderator:intervention'
  | 'motion:opened'
  | 'vote:cast'
  | 'motion:resolved'
  | 'breakout:queued'
  | 'breakout:started'
  | 'breakout:completed';

export interface MeetingEventBase {
  version: typeof MEETING_SCHEMA_VERSION;
  meetingId: string;
  /** Stable producer idempotency key. */
  eventId: string;
  /** Durable, zero-based, monotonically increasing sequence per meeting. */
  seq: number;
  timestamp: number;
  type: MeetingEventType;
  audience: MeetingEventAudience;
  roundId?: string;
}

export interface MeetingCreatedEvent extends MeetingEventBase {
  type: 'meeting:created';
  title: string;
}

export interface MeetingStartedEvent extends MeetingEventBase {
  type: 'meeting:started';
  openingPrompt: string;
}

export interface MeetingPausedEvent extends MeetingEventBase {
  type: 'meeting:paused';
  reason?: string;
}

export interface MeetingClosingEvent extends MeetingEventBase {
  type: 'meeting:closing';
  reason?: string;
}

export interface MeetingCompletedEvent extends MeetingEventBase {
  type: 'meeting:completed';
  reason?: string;
}

export interface MeetingCancelledEvent extends MeetingEventBase {
  type: 'meeting:cancelled';
  reason?: string;
}

export interface MeetingErrorEvent extends MeetingEventBase {
  type: 'meeting:error';
  error: string;
}

export interface MeetingRoundStartedEvent extends MeetingEventBase {
  type: 'round:started';
  round: MeetingRound;
}

export interface MeetingRoundCompletedEvent extends MeetingEventBase {
  type: 'round:completed';
  roundNumber: number;
  participantTurnIds: Record<string, string>;
}

interface MeetingParticipantEventBase extends MeetingEventBase {
  participantId: string;
  participantName: string;
  turnId?: string;
}

export interface MeetingParticipantStartedEvent extends MeetingParticipantEventBase {
  type: 'participant:started';
  turnId: string;
}

export interface MeetingParticipantSpokeEvent extends MeetingParticipantEventBase {
  type: 'participant:spoke';
  turnId: string;
  content: string;
  media?: ModelMediaPart[];
}

export interface MeetingParticipantSilentEvent extends MeetingParticipantEventBase {
  type: 'participant:silent';
  turnId: string;
  reason?: string;
}

export interface MeetingParticipantLeftEvent extends MeetingParticipantEventBase {
  type: 'participant:left';
  reason?: string;
}

export interface MeetingParticipantErrorEvent extends MeetingParticipantEventBase {
  type: 'participant:error';
  turnId?: string;
  error: string;
}

export interface MeetingPrivateMessageEvent extends MeetingEventBase {
  type: 'private-message';
  fromParticipantId: string;
  toParticipantIds: string[];
  content: string;
  media?: ModelMediaPart[];
}

/** Human-authored note retained in the log but never delivered to an agent. */
export interface MeetingPrivateNoteEvent extends MeetingEventBase {
  type: 'private-note';
  content: string;
}

/** Human steering instruction delivered to every participant on the next round snapshot. */
export interface MeetingModeratorInterventionEvent extends MeetingEventBase {
  type: 'moderator:intervention';
  content: string;
}

export interface MeetingMotionOpenedEvent extends MeetingEventBase {
  type: 'motion:opened';
  motion: MeetingMotion;
}

export interface MeetingVoteCastEvent extends MeetingEventBase {
  type: 'vote:cast';
  motionId: string;
  participantId: string;
  choice: MeetingVoteChoice;
  rationale?: string;
}

export interface MeetingMotionResolvedEvent extends MeetingEventBase {
  type: 'motion:resolved';
  motionId: string;
  outcome: Exclude<MeetingMotionStatus, 'open'>;
  tally: Record<MeetingVoteChoice, number>;
}

export interface MeetingBreakoutQueuedEvent extends MeetingEventBase {
  type: 'breakout:queued';
  requestParticipantId: string;
  participantIds: string[];
  topic: string;
  maxRounds: number;
}

export interface MeetingBreakoutStartedEvent extends MeetingEventBase {
  type: 'breakout:started';
  childMeetingId: string;
  participantIds: string[];
  topic: string;
}

export interface MeetingBreakoutCompletedEvent extends MeetingEventBase {
  type: 'breakout:completed';
  childMeetingId: string;
  participantIds: string[];
  summary: string;
}

export type MeetingEvent =
  | MeetingCreatedEvent
  | MeetingStartedEvent
  | MeetingPausedEvent
  | MeetingClosingEvent
  | MeetingCompletedEvent
  | MeetingCancelledEvent
  | MeetingErrorEvent
  | MeetingRoundStartedEvent
  | MeetingRoundCompletedEvent
  | MeetingParticipantStartedEvent
  | MeetingParticipantSpokeEvent
  | MeetingParticipantSilentEvent
  | MeetingParticipantLeftEvent
  | MeetingParticipantErrorEvent
  | MeetingPrivateMessageEvent
  | MeetingPrivateNoteEvent
  | MeetingModeratorInterventionEvent
  | MeetingMotionOpenedEvent
  | MeetingVoteCastEvent
  | MeetingMotionResolvedEvent
  | MeetingBreakoutQueuedEvent
  | MeetingBreakoutStartedEvent
  | MeetingBreakoutCompletedEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** The log/bus stamps these fields; a caller may supply eventId to dedupe retries. */
export type RawMeetingEvent = DistributiveOmit<
  MeetingEvent,
  'version' | 'meetingId' | 'eventId' | 'seq' | 'timestamp'
> & { eventId?: string };

export type MeetingEmitFn = (event: RawMeetingEvent) => Promise<MeetingEvent>;
