import {
  claimNextPersonaActivity,
  completePersonaActivity,
  enqueuePersonaMailboxItem,
  getPersonaActivity,
  listPersonaMailboxItems,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents';
import { createPersonaFromRole } from '../enduringAgents/fixtures/personaFactory';
import {
  completeMeetingPersonaReservations,
  MEETING_PERSONA_LEASE_TTL_MS,
  meetingPersonaReservationAttemptId,
  reserveMeetingPersonas,
} from '@/backend/execution/meeting/personaReservations';
import type { MeetingRecord } from '@/shared/types/meeting';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `meeting-persona-runtime-${process.pid}-${workspaceSequence}`,
    task,
  );
}

function fence(claim: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claim.lease.workspaceId,
    personaId: claim.lease.personaId,
    activityId: claim.activity.id,
    leaseId: claim.lease.id,
    holderId: claim.lease.holderId,
    fencingToken: claim.lease.fencingToken,
  };
}

function meeting(personaId: string): MeetingRecord {
  return {
    version: 1,
    id: 'meeting_runtime',
    title: 'Runtime council',
    openingPrompt: 'Coordinate safely.',
    status: 'draft',
    phase: 'draft',
    participants: [
      {
        id: 'living',
        name: 'Living',
        personaId,
        conversationId: 'conversation_living',
        role: 'participant',
        status: 'idle',
        lastDeliveredSeq: -1,
      },
      {
        id: 'legacy',
        name: 'Legacy',
        flowId: 'flow_legacy',
        conversationId: 'conversation_legacy',
        role: 'participant',
        status: 'idle',
        lastDeliveredSeq: -1,
      },
    ],
    policy: {
      roundMode: 'barrier',
      entryMode: 'start-each-round',
      maxRounds: 1,
      concurrencyLimit: 2,
      errorStrategy: 'collect-all',
      moderatorMode: 'none',
      finishThreshold: 'majority',
      allSilentBehavior: 'finish',
    },
    roundNumber: 0,
    motions: [],
    lastEventSeq: -1,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('meeting Persona reservation against the durable runtime', () => {
  it('does not claim unrelated head work and releases the Persona to queued work after completion', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Runtime participant',
        idempotencyKey: 'meeting-runtime-persona',
        interruptionPolicy: 'queue',
      });
      const unrelated = await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'unrelated-before-meeting',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'before-meeting' },
        summary: 'Earlier unrelated work',
      });

      let reportWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => { reportWaiting = resolve; });
      const reservationPromise = reserveMeetingPersonas(meeting(persona.id), {
        onWaiting: reportWaiting,
      });
      await waiting;

      const before = await listPersonaMailboxItems(persona.id);
      expect(before.find((item) => item.id === unrelated.item.id)?.status).toBe('queued');
      expect(before.find((item) => item.payloadRef === 'meeting:meeting_runtime:living')?.status)
        .toBe('queued');

      const earlierClaim = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 });
      expect(earlierClaim?.mailboxItem.id).toBe(unrelated.item.id);
      await completePersonaActivity({
        ...fence(earlierClaim!),
        status: 'completed',
        outcomeRef: 'test:earlier',
      });

      const reservations = await reservationPromise;
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toMatchObject({
        meetingId: 'meeting_runtime',
        participantId: 'living',
        personaId: persona.id,
      });
      expect(await getPersonaActivity(
        reservations[0].claim.activity.personaId,
        reservations[0].claim.activity.id,
      )).toMatchObject({
        status: 'running',
        meetingId: 'meeting_runtime',
        conversationId: 'conversation_living',
      });

      const queuedAfter = await enqueuePersonaMailboxItem({
        personaId: persona.id,
        idempotencyKey: 'queued-after-meeting',
        kind: 'assignment',
        source: { kind: 'assignment', sourceId: 'after-meeting' },
        summary: 'Queued behind meeting',
      });
      await completeMeetingPersonaReservations(reservations, 'completed');

      expect(await getPersonaActivity(
        reservations[0].claim.activity.personaId,
        reservations[0].claim.activity.id,
      )).toMatchObject({
        status: 'completed',
        outcomeRef: 'meeting:meeting_runtime',
      });
      const resumed = await claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 });
      expect(resumed?.mailboxItem.id).toBe(queuedAfter.item.id);
      await completePersonaActivity({
        ...fence(resumed!),
        status: 'completed',
        outcomeRef: 'test:after',
      });
    });
  });

  it('uses a new reservation attempt after recovered-round reconciliation and retires the expired pre-crash Activity', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Restarted meeting participant',
        idempotencyKey: 'meeting-runtime-restart-persona',
        interruptionPolicy: 'queue',
      });
      const initialMeeting = meeting(persona.id);
      const initialReservations = await reserveMeetingPersonas(initialMeeting);
      const initialReservation = initialReservations[0];

      const recoveredMeeting: MeetingRecord = {
        ...initialMeeting,
        status: 'paused',
        phase: 'discussion',
        roundNumber: 1,
        lastEventSeq: 9,
        activeRound: {
          id: `${initialMeeting.id}-round-1`,
          number: 1,
          phase: 'discussion',
          status: 'completed',
          snapshotSeq: 3,
          eligibleParticipantIds: ['living', 'legacy'],
          participantTurnIds: {
            living: `${initialMeeting.id}-round-1:living`,
            legacy: `${initialMeeting.id}-round-1:legacy`,
          },
          startedAt: 4,
          completedAt: 8,
        },
        updatedAt: 9,
      };

      expect(initialReservation.attemptId).not.toBe(
        meetingPersonaReservationAttemptId(recoveredMeeting),
      );
      let reportWaiting!: () => void;
      const waiting = new Promise<void>((resolve) => { reportWaiting = resolve; });
      const resumedPromise = reserveMeetingPersonas(recoveredMeeting, {
        onWaiting: reportWaiting,
      });
      await waiting;

      const whileBlocked = await listPersonaMailboxItems(persona.id);
      const meetingItems = whileBlocked.filter(
        (item) => item.payloadRef === 'meeting:meeting_runtime:living',
      );
      expect(meetingItems).toHaveLength(2);
      expect(meetingItems.find((item) => item.id === initialReservation.mailboxItemId)?.status)
        .toBe('claimed');
      expect(meetingItems.find((item) => item.id !== initialReservation.mailboxItemId)?.status)
        .toBe('queued');

      const initialExpiry = initialReservation.claim.lease.expiresAt;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(
        initialExpiry + MEETING_PERSONA_LEASE_TTL_MS,
      );
      try {
        const resumedReservations = await resumedPromise;
        const resumedReservation = resumedReservations[0];
        expect(resumedReservation.attemptId).not.toBe(initialReservation.attemptId);
        expect(resumedReservation.mailboxItemId).not.toBe(initialReservation.mailboxItemId);
        expect(await getPersonaActivity(
          initialReservation.claim.activity.personaId,
          initialReservation.claim.activity.id,
        )).toMatchObject({
          status: 'error',
        });
        expect(await getPersonaActivity(
          resumedReservation.claim.activity.personaId,
          resumedReservation.claim.activity.id,
        )).toMatchObject({
          status: 'running',
          meetingId: 'meeting_runtime',
        });
        await completeMeetingPersonaReservations(resumedReservations, 'completed');
      } finally {
        nowSpy.mockRestore();
      }
    });
  });
});
