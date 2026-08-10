import { createHash } from 'crypto';

import type { FlowExecutionAuthority } from '@/backend/execution/flow/types';
import {
  PersonaBusyError,
  PersonaRuntimeUnavailableError,
  assertPersonaActivityLease,
  cancelPersonaMailboxItem,
  claimPersonaMailboxItem,
  commitWithPersonaActivityLease,
  completePersonaActivity,
  releasePersonaActivityLease,
  renewPersonaActivityLease,
  routePersonaMailboxItem,
  updatePersonaActivityReferences,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents/activityRuntime';
import {
  getBehaviorRevision,
  getPersona,
  getRoleVersion,
} from '@/backend/services/enduringAgents/store';
import { buildPersonaInstructionContext } from '@/backend/services/enduringAgents/personaInstructionContext';
import {
  PersonaRuntimeLockTimeoutError,
  withWorkspaceRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import type { BehaviorRevision, PersonaInstructionContext } from '@/shared/types/enduringAgent';
import type { MeetingParticipant, MeetingRecord } from '@/shared/types/meeting';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/execution/meeting/personaReservations');

export const MEETING_PERSONA_LEASE_TTL_MS = 30_000;
const MEETING_PERSONA_RETRY_MS = 100;
const MEETING_RESERVATION_COORDINATOR = 'meeting_reservation_coordinator';

interface MeetingPersonaReservationOptions {
  signal?: AbortSignal;
  onWaiting?: () => void | Promise<void>;
  attemptId?: string;
}

export interface MeetingPersonaReservation {
  meetingId: string;
  attemptId: string;
  participantId: string;
  personaId: string;
  mailboxItemId: string;
  claim: PersonaActivityClaim;
  fence: PersonaLeaseFence;
  revision: BehaviorRevision;
  /** Frozen with the exact claimed Activity and pinned Behavior/Role versions. */
  instructionContext: PersonaInstructionContext;
}

export interface MeetingPersonaHeartbeat {
  authorityFor(participantId: string): FlowExecutionAuthority | undefined;
  lost(): boolean;
  stop(): Promise<void>;
}

function fenceForClaim(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.lease.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function payloadRef(meeting: MeetingRecord, participant: MeetingParticipant): string {
  return `meeting:${meeting.id}:${participant.id}`;
}

function isActivePersonaParticipant(
  participant: MeetingParticipant,
): participant is MeetingParticipant & { personaId: string } {
  return typeof participant.personaId === 'string'
    && participant.status !== 'left'
    && !participant.personaRetired
    && !participant.personaArchived;
}

/**
 * Stable for one persisted start barrier, but different after crash recovery
 * advances or projects that barrier. A resumed meeting therefore cannot reuse
 * a terminal mailbox item from the lease generation that died with the old
 * process.
 */
export function meetingPersonaReservationAttemptId(
  meeting: MeetingRecord,
  generation = meeting.personaReservationGeneration ?? 0,
): string {
  const barrier = meeting.activeRound
    ? {
        id: meeting.activeRound.id,
        number: meeting.activeRound.number,
        status: meeting.activeRound.status,
        snapshotSeq: meeting.activeRound.snapshotSeq,
        completedAt: meeting.activeRound.completedAt ?? null,
      }
    : null;
  const personaBehaviorPins = meeting.participants
    .filter(isActivePersonaParticipant)
    .map((participant) => ({
      participantId: participant.id,
      personaId: participant.personaId,
      slotKey: participant.behaviorSlotKey ?? 'primary',
      behaviorRevisionId: participant.behaviorRevisionId ?? null,
    }))
    .sort((left, right) => compareStableIds(left.participantId, right.participantId));
  return createHash('sha256')
    .update(JSON.stringify({
      meetingId: meeting.id,
      reservationGeneration: generation,
      roundNumber: meeting.roundNumber,
      lastEventSeq: meeting.lastEventSeq,
      barrier,
      personaBehaviorPins,
    }))
    .digest('hex')
    .slice(0, 24);
}

function reservationIdempotencyKey(
  meeting: MeetingRecord,
  participant: MeetingParticipant,
  attemptId: string,
): string {
  return `meeting:${meeting.id}:${attemptId}:${participant.id}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Meeting start cancelled.'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal?.reason ?? new Error('Meeting start cancelled.'));
    };
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

async function withMeetingReservationCoordinator<T>(
  signal: AbortSignal | undefined,
  task: () => Promise<T>,
): Promise<T> {
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error('Meeting start cancelled.');
    }
    try {
      return await withWorkspaceRuntimeLock(MEETING_RESERVATION_COORDINATOR, async (lock) => {
        await lock.assertOwned();
        return task();
      });
    } catch (error) {
      // The generic filesystem lock uses a bounded acquisition attempt. A
      // coordinator waiter must remain queued across those attempts; surfacing
      // the timeout would turn ordinary long Persona work into a failed start.
      if (!(error instanceof PersonaRuntimeLockTimeoutError)) throw error;
      await delay(MEETING_PERSONA_RETRY_MS, signal);
    }
  }
}

async function releasePartialReservations(
  reservations: MeetingPersonaReservation[],
): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(reservations.map(async (reservation) => {
    try {
      await releasePersonaActivityLease(reservation.fence);
    } catch (error) {
      failures.push(error);
      log.warn('Could not roll back partial meeting Persona reservation', {
        personaId: reservation.personaId,
        participantId: reservation.participantId,
        error,
      });
    }
  }));
  if (failures.length > 0) {
    throw new Error(
      `Could not roll back ${failures.length} partial meeting Persona reservation(s).`,
      { cause: failures[0] },
    );
  }
}

function compareStableIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Enqueue every Persona participant, then acquire in deterministic Persona-id
 * order. A failed pass releases every partial claim before retrying, so two
 * overlapping meetings cannot deadlock or partially start.
 */
async function reserveMeetingPersonasWhileCoordinated(
  meeting: MeetingRecord,
  options: MeetingPersonaReservationOptions = {},
): Promise<MeetingPersonaReservation[]> {
  const attemptId = options.attemptId ?? meetingPersonaReservationAttemptId(meeting);
  const participants = meeting.participants
    .filter(isActivePersonaParticipant)
    .sort((left, right) =>
      compareStableIds(left.personaId, right.personaId)
      || compareStableIds(left.id, right.id));
  if (participants.length === 0) return [];
  if (new Set(participants.map((participant) => participant.personaId)).size !== participants.length) {
    throw new Error('A Persona may participate in a meeting only once.');
  }

  const mailboxByParticipant = new Map<string, string>();
  for (const participant of participants) {
    const routed = await routePersonaMailboxItem({
      personaId: participant.personaId,
      idempotencyKey: reservationIdempotencyKey(meeting, participant, attemptId),
      kind: 'meeting',
      priority: 'normal',
      source: {
        kind: 'meeting',
        sourceId: meeting.id,
        idempotencyKey: reservationIdempotencyKey(meeting, participant, attemptId),
      },
      ...(participant.behaviorSlotKey ? { behaviorSlotKey: participant.behaviorSlotKey } : {}),
      relationKey: `meeting:${meeting.id}`,
      summary: `${meeting.title} · ${participant.name}`,
      payloadRef: payloadRef(meeting, participant),
    });
    if (routed.decision !== 'queued' && routed.decision !== 'duplicate') {
      throw new Error(
        `Meeting reservation for Persona ${participant.personaId} was routed as ${routed.decision}.`,
      );
    }
    if (routed.item.payloadRef !== payloadRef(meeting, participant)) {
      throw new Error(`Meeting reservation payload conflict for Persona ${participant.personaId}.`);
    }
    mailboxByParticipant.set(participant.id, routed.item.id);
  }

  let waitingReported = false;
  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('Meeting start cancelled.');
    }
    const acquired: MeetingPersonaReservation[] = [];
    let retry = false;
    try {
      for (const participant of participants) {
        const mailboxItemId = mailboxByParticipant.get(participant.id)!;
        let claim: PersonaActivityClaim | null;
        try {
          claim = await claimPersonaMailboxItem({
            personaId: participant.personaId,
            expectedMailboxItemId: mailboxItemId,
            ttlMs: MEETING_PERSONA_LEASE_TTL_MS,
          });
        } catch (error) {
          if (error instanceof PersonaBusyError) {
            retry = true;
            break;
          }
          if (error instanceof PersonaRuntimeUnavailableError) throw error;
          throw error;
        }
        if (!claim) {
          retry = true;
          break;
        }
        const claimFence = fenceForClaim(claim);
        let revision: BehaviorRevision;
        let instructionContext: PersonaInstructionContext;
        try {
          if (
            claim.mailboxItem.id !== mailboxItemId
            || claim.mailboxItem.payloadRef !== payloadRef(meeting, participant)
            || claim.activity.personaId !== participant.personaId
            || !claim.activity.behaviorId
            || !claim.activity.behaviorRevisionId
          ) {
            throw new Error(`Persona ${participant.personaId} returned a foreign meeting claim.`);
          }
          const resolvedRevision = await getBehaviorRevision(claim.activity.behaviorRevisionId);
          if (
            !resolvedRevision
            || resolvedRevision.personaId !== participant.personaId
            || resolvedRevision.behaviorId !== claim.activity.behaviorId
            || resolvedRevision.slotKey !== (participant.behaviorSlotKey ?? 'primary')
            || resolvedRevision.id !== claim.activity.behaviorRevisionId
          ) {
            throw new Error(`Persona ${participant.personaId} has an invalid pinned Behavior revision.`);
          }
          if (
            participant.behaviorRevisionId
            && resolvedRevision.id !== participant.behaviorRevisionId
          ) {
            throw new Error(
              `Meeting participant ${participant.id} is pinned to Behavior revision `
              + `${participant.behaviorRevisionId}, but its Activity claimed ${resolvedRevision.id}.`,
            );
          }
          const persona = await getPersona(participant.personaId);
          if (!persona || persona.id !== participant.personaId) {
            throw new Error(`Persona ${participant.personaId} no longer exists.`);
          }
          const roleVersion = await getRoleVersion(persona.roleVersionId);
          if (!roleVersion) {
            throw new Error(`Persona ${participant.personaId} has no pinned Role version.`);
          }
          revision = resolvedRevision;
          instructionContext = buildPersonaInstructionContext({
            persona,
            roleVersion,
            revision,
            activityId: claim.activity.id,
          });
        } catch (error) {
          try {
            await releasePersonaActivityLease(claimFence);
          } catch (rollbackError) {
            throw new Error('Meeting Persona claim validation failed and rollback was incomplete.', {
              cause: rollbackError,
            });
          }
          throw error;
        }
        acquired.push({
          meetingId: meeting.id,
          attemptId,
          participantId: participant.id,
          personaId: participant.personaId,
          mailboxItemId,
          claim,
          fence: claimFence,
          revision,
          instructionContext,
        });
      }

      if (!retry && acquired.length === participants.length) {
        // Attach safe meeting/conversation references only after the complete
        // reservation set exists. A failed attach rolls every lease back.
        for (const reservation of acquired) {
          const participant = meeting.participants.find(
            (candidate) => candidate.id === reservation.participantId,
          )!;
          await updatePersonaActivityReferences({
            ...reservation.fence,
            meetingId: meeting.id,
            conversationId: participant.conversationId,
          });
        }
        // The first deterministic claim may have been held while the remaining
        // Personas were assembled. Refresh every fence at the all-or-none
        // boundary so the heartbeat starts from a full TTL for every member.
        await Promise.all(acquired.map((reservation) => renewPersonaActivityLease({
          ...reservation.fence,
          ttlMs: MEETING_PERSONA_LEASE_TTL_MS,
        })));
        return acquired;
      }
    } catch (error) {
      try {
        await releasePartialReservations(acquired);
      } catch (rollbackError) {
        throw new Error('Meeting Persona reservation failed and rollback was incomplete.', {
          cause: rollbackError,
        });
      }
      throw error;
    }

    await releasePartialReservations(acquired);
    if (!waitingReported) {
      waitingReported = true;
      await options.onWaiting?.();
    }
    await delay(MEETING_PERSONA_RETRY_MS, options.signal);
  }
}

/**
 * Keep route-and-claim assembly globally ordered. Without this coordinator,
 * two meetings can enqueue opposite Persona queue orders before either has
 * assembled its all-or-none lease set, leaving both permanently resumable but
 * unable to claim every expected head item.
 */
export async function reserveMeetingPersonas(
  meeting: MeetingRecord,
  options: MeetingPersonaReservationOptions = {},
): Promise<MeetingPersonaReservation[]> {
  return withMeetingReservationCoordinator(options.signal, () =>
    reserveMeetingPersonasWhileCoordinated(meeting, options));
}

/** Reject durable meeting admissions when start is cancelled before reservation. */
async function cancelMeetingPersonaReservationsWhileCoordinated(
  meeting: MeetingRecord,
  attemptId = meetingPersonaReservationAttemptId(meeting),
): Promise<void> {
  const participants = meeting.participants.filter(
    isActivePersonaParticipant,
  );
  await Promise.all(participants.map(async (participant) => {
    try {
      const routed = await routePersonaMailboxItem({
        personaId: participant.personaId,
        idempotencyKey: reservationIdempotencyKey(meeting, participant, attemptId),
        kind: 'meeting',
        priority: 'normal',
        source: {
          kind: 'meeting',
          sourceId: meeting.id,
          idempotencyKey: reservationIdempotencyKey(meeting, participant, attemptId),
        },
        ...(participant.behaviorSlotKey ? { behaviorSlotKey: participant.behaviorSlotKey } : {}),
        relationKey: `meeting:${meeting.id}`,
        summary: `${meeting.title} · ${participant.name}`,
        payloadRef: payloadRef(meeting, participant),
      });
      await cancelPersonaMailboxItem({
        personaId: participant.personaId,
        mailboxItemId: routed.item.id,
      });
    } catch (error) {
      log.warn('Could not cancel queued meeting Persona reservation', {
        meetingId: meeting.id,
        personaId: participant.personaId,
        error,
      });
    }
  }));
}

export async function cancelMeetingPersonaReservations(
  meeting: MeetingRecord,
  attemptId = meetingPersonaReservationAttemptId(meeting),
): Promise<void> {
  return withMeetingReservationCoordinator(undefined, () =>
    cancelMeetingPersonaReservationsWhileCoordinated(meeting, attemptId));
}

/** Keep every participant lease alive for the full meeting lifetime. */
export function startMeetingPersonaHeartbeat(
  reservations: MeetingPersonaReservation[],
  abortController: AbortController,
): MeetingPersonaHeartbeat {
  let stopped = false;
  let leaseLost = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  const intervalMs = Math.min(5_000, Math.floor(MEETING_PERSONA_LEASE_TTL_MS / 3));

  const schedule = () => {
    if (stopped || reservations.length === 0) return;
    timer = setTimeout(() => {
      if (stopped) return;
      inFlight = Promise.all(reservations.map((reservation) =>
        renewPersonaActivityLease({
          ...reservation.fence,
          ttlMs: MEETING_PERSONA_LEASE_TTL_MS,
        })))
        .then(() => undefined)
        .catch((error) => {
          leaseLost = true;
          abortController.abort(error);
        })
        .finally(() => {
          inFlight = undefined;
          schedule();
        });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    authorityFor(participantId: string): FlowExecutionAuthority | undefined {
      const reservation = reservations.find((item) => item.participantId === participantId);
      if (!reservation) return undefined;
      return {
        signal: abortController.signal,
        assertCurrent: async () => {
          if (leaseLost || abortController.signal.aborted) {
            throw new Error('Meeting Persona execution authority was lost.');
          }
          try {
            await assertPersonaActivityLease(reservation.fence);
          } catch (error) {
            leaseLost = true;
            abortController.abort(error);
            throw error;
          }
        },
        commitWhileCurrent: async <T>(task: () => Promise<T>): Promise<T> => {
          if (leaseLost || abortController.signal.aborted) {
            throw new Error('Meeting Persona execution authority was lost.');
          }
          try {
            return await commitWithPersonaActivityLease(reservation.fence, task);
          } catch (error) {
            leaseLost = true;
            abortController.abort(error);
            throw error;
          }
        },
      };
    },
    lost: () => leaseLost,
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

/** Close meeting Activities and wake each Persona's remaining mailbox. */
export async function completeMeetingPersonaReservations(
  reservations: MeetingPersonaReservation[],
  status: 'completed' | 'cancelled' | 'error',
  error?: string,
): Promise<void> {
  const personas = new Set<string>();
  await Promise.all(reservations.map(async (reservation) => {
    personas.add(reservation.personaId);
    try {
      await completePersonaActivity({
        ...reservation.fence,
        status,
        outcomeRef: `meeting:${reservation.meetingId}`,
        ...(status === 'error' ? { error: error ?? 'Meeting failed.' } : {}),
      });
    } catch (completionError) {
      log.warn('Could not close meeting Persona Activity with its original fence', {
        personaId: reservation.personaId,
        participantId: reservation.participantId,
        error: completionError,
      });
    }
  }));
  await Promise.all([...personas].map(async (personaId) => {
    try {
      const { pumpPersonaFlowDispatches } = await import(
        '@/backend/services/enduringAgents/personaDispatcher'
      );
      await pumpPersonaFlowDispatches(personaId);
    } catch (error) {
      log.warn('Could not wake Persona dispatcher after meeting', { personaId, error });
    }
  }));
}
