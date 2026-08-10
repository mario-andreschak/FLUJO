const routeMock = jest.fn();
const claimMock = jest.fn();
const releaseMock = jest.fn();
const renewMock = jest.fn();
const assertLeaseMock = jest.fn();
const commitLeaseMock = jest.fn();
const updateReferencesMock = jest.fn();
const completeActivityMock = jest.fn();
const cancelMailboxMock = jest.fn();
const getRevisionMock = jest.fn();
const getPersonaMock = jest.fn();
const getRoleVersionMock = jest.fn();
const pumpMock = jest.fn();

jest.mock('@/backend/services/enduringAgents/activityRuntime', () => {
  class PersonaBusyError extends Error {}
  class PersonaRuntimeUnavailableError extends Error {}
  return {
    PersonaBusyError,
    PersonaRuntimeUnavailableError,
    routePersonaMailboxItem: (...args: unknown[]) => routeMock(...args),
    claimPersonaMailboxItem: (...args: unknown[]) => claimMock(...args),
    releasePersonaActivityLease: (...args: unknown[]) => releaseMock(...args),
    renewPersonaActivityLease: (...args: unknown[]) => renewMock(...args),
    assertPersonaActivityLease: (...args: unknown[]) => assertLeaseMock(...args),
    commitWithPersonaActivityLease: (...args: unknown[]) => commitLeaseMock(...args),
    updatePersonaActivityReferences: (...args: unknown[]) => updateReferencesMock(...args),
    completePersonaActivity: (...args: unknown[]) => completeActivityMock(...args),
    cancelPersonaMailboxItem: (...args: unknown[]) => cancelMailboxMock(...args),
  };
});

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getBehaviorRevision: (...args: unknown[]) => getRevisionMock(...args),
  getPersona: (...args: unknown[]) => getPersonaMock(...args),
  getRoleVersion: (...args: unknown[]) => getRoleVersionMock(...args),
}));

jest.mock('@/backend/services/enduringAgents/personaDispatcher', () => ({
  pumpPersonaFlowDispatches: (...args: unknown[]) => pumpMock(...args),
}));

import {
  cancelMeetingPersonaReservations,
  completeMeetingPersonaReservations,
  MEETING_PERSONA_LEASE_TTL_MS,
  meetingPersonaReservationAttemptId,
  reserveMeetingPersonas,
  startMeetingPersonaHeartbeat,
  type MeetingPersonaReservation,
} from '@/backend/execution/meeting/personaReservations';
import { buildPersonaInstructionContext } from '@/backend/services/enduringAgents/personaInstructionContext';
import type { MeetingRecord } from '@/shared/types/meeting';

function snapshot(id: string) {
  return {
    id,
    name: id,
    nodes: [{ id: `${id}_start`, type: 'start', data: { type: 'start' } }],
    edges: [],
  };
}

function revision(personaId: string) {
  return {
    schemaVersion: 1,
    id: `revision_${personaId}`,
    behaviorId: `behavior_${personaId}`,
    personaId,
    slotKey: 'primary',
    revision: 1,
    contentHash: 'a'.repeat(64),
    flowSnapshot: snapshot(`flow_${personaId}`),
    source: { kind: 'role_version', roleVersionId: `role_${personaId}` },
    createdAt: 1,
  };
}

function persona(personaId: string) {
  return {
    id: personaId,
    name: `Persona ${personaId}`,
    mission: `Mission for ${personaId}.`,
    roleVersionId: `role_${personaId}`,
  };
}

function roleVersion(personaId: string) {
  return {
    id: `role_${personaId}`,
    name: `Role ${personaId}`,
    mission: `Role mission for ${personaId}.`,
    behaviorSlots: [{ key: 'primary' }],
  };
}

function meeting(): MeetingRecord {
  return {
    version: 1,
    id: 'meeting_reservation',
    title: 'Reservation council',
    openingPrompt: 'Coordinate.',
    status: 'draft',
    phase: 'draft',
    participants: [
      {
        id: 'participant_z',
        name: 'Zulu',
        personaId: 'persona_z',
        behaviorRevisionId: 'revision_persona_z',
        conversationId: 'conversation_z',
        role: 'participant',
        status: 'idle',
        lastDeliveredSeq: -1,
      },
      {
        id: 'participant_a',
        name: 'Alpha',
        personaId: 'persona_a',
        behaviorRevisionId: 'revision_persona_a',
        conversationId: 'conversation_a',
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

function mailboxId(personaId: string): string {
  return `mailbox_${personaId}`;
}

function claimFor(personaId: string, participantId: string) {
  const activityId = `activity_${personaId}`;
  return {
    mailboxItem: {
      id: mailboxId(personaId),
      personaId,
      payloadRef: `meeting:meeting_reservation:${participantId}`,
    },
    activity: {
      id: activityId,
      personaId,
      behaviorId: `behavior_${personaId}`,
      behaviorRevisionId: `revision_${personaId}`,
    },
    lease: {
      id: `lease_${personaId}`,
      workspaceId: 'default',
      personaId,
      activityId,
      holderId: `holder_${personaId}`,
      fencingToken: 1,
    },
  };
}

function reservation(personaId = 'persona_a'): MeetingPersonaReservation {
  const participantId = personaId === 'persona_a' ? 'participant_a' : 'participant_z';
  const claim = claimFor(personaId, participantId) as any;
  return {
    meetingId: 'meeting_reservation',
    attemptId: meetingPersonaReservationAttemptId(meeting()),
    participantId,
    personaId,
    mailboxItemId: mailboxId(personaId),
    claim,
    fence: {
      workspaceId: 'default',
      personaId,
      activityId: claim.activity.id,
      leaseId: claim.lease.id,
      holderId: claim.lease.holderId,
      fencingToken: 1,
    },
    revision: revision(personaId) as any,
    instructionContext: buildPersonaInstructionContext({
      persona: persona(personaId) as any,
      roleVersion: roleVersion(personaId) as any,
      revision: revision(personaId) as any,
      activityId: claim.activity.id,
    }),
  };
}

beforeEach(() => {
  routeMock.mockReset();
  claimMock.mockReset();
  releaseMock.mockReset().mockResolvedValue(undefined);
  renewMock.mockReset().mockResolvedValue(undefined);
  assertLeaseMock.mockReset().mockResolvedValue(undefined);
  commitLeaseMock.mockReset().mockImplementation(
    async (_fence: unknown, task: () => Promise<unknown>) => task(),
  );
  updateReferencesMock.mockReset().mockResolvedValue(undefined);
  completeActivityMock.mockReset().mockResolvedValue(undefined);
  cancelMailboxMock.mockReset().mockResolvedValue(undefined);
  getRevisionMock.mockReset().mockImplementation(async (id: string) => {
    const personaId = id.replace(/^revision_/, '');
    return revision(personaId);
  });
  getPersonaMock.mockReset().mockImplementation(async (personaId: string) => persona(personaId));
  getRoleVersionMock.mockReset().mockImplementation(async (id: string) => {
    const personaId = id.replace(/^role_/, '');
    return roleVersion(personaId);
  });
  pumpMock.mockReset().mockResolvedValue(undefined);
  routeMock.mockImplementation(async (input: { personaId: string; payloadRef: string }) => ({
    decision: 'queued',
    item: {
      id: mailboxId(input.personaId),
      personaId: input.personaId,
      payloadRef: input.payloadRef,
    },
  }));
});

describe('meeting Persona reservation coordinator', () => {
  it('restarts remaining participants without reserving or cancelling a retired Persona', async () => {
    const recovered = meeting();
    recovered.status = 'paused';
    recovered.participants[1].status = 'left';
    recovered.participants[1].personaRetired = true;
    claimMock.mockImplementation(async (input: { personaId: string }) =>
      claimFor(input.personaId, 'participant_z'));

    await expect(reserveMeetingPersonas(recovered)).resolves.toEqual([
      expect.objectContaining({ personaId: 'persona_z', participantId: 'participant_z' }),
    ]);
    expect(routeMock.mock.calls.map(([input]) => input.personaId)).toEqual(['persona_z']);
    expect(claimMock.mock.calls.map(([input]) => input.personaId)).toEqual(['persona_z']);

    routeMock.mockClear();
    cancelMailboxMock.mockClear();
    await cancelMeetingPersonaReservations(recovered);
    expect(routeMock.mock.calls.map(([input]) => input.personaId)).toEqual(['persona_z']);
    expect(cancelMailboxMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_z',
    }));
    expect(cancelMailboxMock).not.toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_a',
    }));
  });

  it('derives a stable attempt id that advances with a recovered barrier', () => {
    const initial = meeting();
    const same = { ...initial, updatedAt: 999, status: 'paused' as const };
    const recovered = {
      ...initial,
      status: 'paused' as const,
      roundNumber: 1,
      lastEventSeq: 12,
      activeRound: {
        id: 'meeting_reservation-round-1',
        number: 1,
        phase: 'discussion' as const,
        status: 'completed' as const,
        snapshotSeq: 2,
        eligibleParticipantIds: ['participant_a', 'participant_z'],
        participantTurnIds: {},
        startedAt: 2,
        completedAt: 12,
      },
    };

    expect(meetingPersonaReservationAttemptId(same))
      .toBe(meetingPersonaReservationAttemptId(initial));
    expect(meetingPersonaReservationAttemptId(recovered))
      .not.toBe(meetingPersonaReservationAttemptId(initial));
    expect(meetingPersonaReservationAttemptId(initial, 2))
      .not.toBe(meetingPersonaReservationAttemptId(initial, 1));
    const prePinSnapshot = {
      ...initial,
      participants: initial.participants.map((participant) => {
        const { behaviorRevisionId: _pin, ...legacyParticipant } = participant;
        return legacyParticipant;
      }),
    };
    expect(meetingPersonaReservationAttemptId(prePinSnapshot))
      .not.toBe(meetingPersonaReservationAttemptId(initial));
  });

  it('claims in stable Persona order, attaches references, and refreshes the full reservation set', async () => {
    claimMock.mockImplementation(async (input: { personaId: string }) => {
      const participantId = input.personaId === 'persona_a' ? 'participant_a' : 'participant_z';
      return claimFor(input.personaId, participantId);
    });

    const reservations = await reserveMeetingPersonas(meeting());

    expect(routeMock.mock.calls.map(([input]) => input.personaId))
      .toEqual(['persona_a', 'persona_z']);
    expect(claimMock.mock.calls.map(([input]) => input.personaId))
      .toEqual(['persona_a', 'persona_z']);
    expect(claimMock.mock.calls.every(([input]) =>
      input.expectedMailboxItemId === mailboxId(input.personaId))).toBe(true);
    expect(updateReferencesMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_a',
      meetingId: 'meeting_reservation',
      conversationId: 'conversation_a',
    }));
    expect(renewMock).toHaveBeenCalledTimes(2);
    expect(renewMock.mock.calls.every(([input]) =>
      input.ttlMs === MEETING_PERSONA_LEASE_TTL_MS)).toBe(true);
    expect(reservations.map((item) => item.meetingId))
      .toEqual(['meeting_reservation', 'meeting_reservation']);
    expect(new Set(reservations.map((item) => item.attemptId)).size).toBe(1);
    expect(reservations[0].instructionContext).toMatchObject({
      personaId: 'persona_a',
      activityId: 'activity_persona_a',
      behaviorRevisionId: 'revision_persona_a',
      roleVersionId: 'role_persona_a',
      personaName: 'Persona persona_a',
      roleName: 'Role persona_a',
    });
    expect(reservations[0].instructionContext.instruction)
      .toContain('# TRUSTED PERSONA CONTEXT');
  });

  it('serializes overlapping multi-Persona route-and-claim assembly', async () => {
    const firstMeeting = { ...meeting(), id: 'meeting_a' };
    const secondMeeting = { ...meeting(), id: 'meeting_b' };
    const queues = new Map<string, string[]>();
    const itemPayloads = new Map<string, string>();
    let signalFirstRoute!: () => void;
    let releaseFirstRoute!: () => void;
    const firstRouteEntered = new Promise<void>((resolve) => { signalFirstRoute = resolve; });
    const firstRouteGate = new Promise<void>((resolve) => { releaseFirstRoute = resolve; });

    routeMock.mockImplementation(async (input: {
      personaId: string;
      payloadRef: string;
      source: { sourceId: string };
    }) => {
      const itemId = `mailbox_${input.source.sourceId}_${input.personaId}`;
      const queue = queues.get(input.personaId) ?? [];
      queue.push(itemId);
      queues.set(input.personaId, queue);
      itemPayloads.set(itemId, input.payloadRef);
      if (input.source.sourceId === firstMeeting.id && input.personaId === 'persona_a') {
        signalFirstRoute();
        await firstRouteGate;
      }
      return {
        decision: 'queued',
        item: { id: itemId, personaId: input.personaId, payloadRef: input.payloadRef },
      };
    });
    claimMock.mockImplementation(async (input: {
      personaId: string;
      expectedMailboxItemId: string;
    }) => {
      const queue = queues.get(input.personaId) ?? [];
      if (queue[0] !== input.expectedMailboxItemId) return null;
      queue.shift();
      const participantId = input.personaId === 'persona_a' ? 'participant_a' : 'participant_z';
      const activityId = `activity_${input.expectedMailboxItemId}`;
      return {
        mailboxItem: {
          id: input.expectedMailboxItemId,
          personaId: input.personaId,
          payloadRef: itemPayloads.get(input.expectedMailboxItemId),
        },
        activity: {
          id: activityId,
          personaId: input.personaId,
          behaviorId: `behavior_${input.personaId}`,
          behaviorRevisionId: `revision_${input.personaId}`,
        },
        lease: {
          id: `lease_${input.expectedMailboxItemId}`,
          workspaceId: 'default',
          personaId: input.personaId,
          activityId,
          holderId: `holder_${input.expectedMailboxItemId}`,
          fencingToken: 1,
        },
      };
    });

    const first = reserveMeetingPersonas(firstMeeting);
    await firstRouteEntered;
    const second = reserveMeetingPersonas(secondMeeting);
    await Promise.resolve();
    await Promise.resolve();
    expect(routeMock).toHaveBeenCalledTimes(1);

    releaseFirstRoute();
    const [firstReservations, secondReservations] = await Promise.all([first, second]);
    expect(firstReservations).toHaveLength(2);
    expect(secondReservations).toHaveLength(2);
    expect(routeMock.mock.calls.map(([input]) => [input.source.sourceId, input.personaId]))
      .toEqual([
        ['meeting_a', 'persona_a'],
        ['meeting_a', 'persona_z'],
        ['meeting_b', 'persona_a'],
        ['meeting_b', 'persona_z'],
      ]);
    expect([...queues.values()].every((queue) => queue.length === 0)).toBe(true);
  });

  it('rejects and releases an Activity that does not match the durable meeting pin', async () => {
    const foreignRevision = {
      ...revision('persona_a'),
      id: 'revision_persona_a_rebound',
    };
    getRevisionMock.mockResolvedValue(foreignRevision);
    claimMock.mockImplementation(async (input: { personaId: string }) => {
      const claim = claimFor(input.personaId, 'participant_a');
      claim.activity.behaviorRevisionId = foreignRevision.id;
      return claim;
    });

    await expect(reserveMeetingPersonas(meeting())).rejects.toThrow(
      /pinned to Behavior revision revision_persona_a.*claimed revision_persona_a_rebound/i,
    );
    expect(releaseMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_a',
      activityId: 'activity_persona_a',
    }));
  });

  it('rolls back a deterministic partial claim and never asks the runtime for unrelated work', async () => {
    claimMock.mockImplementation(async (input: { personaId: string }) => {
      if (input.personaId === 'persona_z') throw new Error('claim failed');
      return claimFor('persona_a', 'participant_a');
    });

    await expect(reserveMeetingPersonas(meeting())).rejects.toThrow('claim failed');

    expect(claimMock.mock.calls.map(([input]) => ({
      personaId: input.personaId,
      expectedMailboxItemId: input.expectedMailboxItemId,
    }))).toEqual([
      { personaId: 'persona_a', expectedMailboxItemId: 'mailbox_persona_a' },
      { personaId: 'persona_z', expectedMailboxItemId: 'mailbox_persona_z' },
    ]);
    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(expect.objectContaining({
      personaId: 'persona_a',
      activityId: 'activity_persona_a',
    }));
    expect(updateReferencesMock).not.toHaveBeenCalled();
  });

  it('retries a busy all-or-none pass only after releasing every partial lease', async () => {
    let zuluAttempts = 0;
    const order: string[] = [];
    claimMock.mockImplementation(async (input: { personaId: string }) => {
      order.push(`claim:${input.personaId}`);
      const participantId = input.personaId === 'persona_a' ? 'participant_a' : 'participant_z';
      if (input.personaId === 'persona_z' && zuluAttempts++ === 0) return null;
      return claimFor(input.personaId, participantId);
    });
    releaseMock.mockImplementation(async (input: { personaId: string }) => {
      order.push(`release:${input.personaId}`);
    });
    updateReferencesMock.mockImplementation(async (input: { personaId: string }) => {
      order.push(`attach:${input.personaId}`);
    });
    const onWaiting = jest.fn();

    await expect(reserveMeetingPersonas(meeting(), { onWaiting })).resolves.toHaveLength(2);

    expect(order).toEqual([
      'claim:persona_a',
      'claim:persona_z',
      'release:persona_a',
      'claim:persona_a',
      'claim:persona_z',
      'attach:persona_a',
      'attach:persona_z',
    ]);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('renews every lease for the full heartbeat lifetime and stops cleanly', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const heartbeat = startMeetingPersonaHeartbeat(
        [reservation('persona_a'), reservation('persona_z')],
        abortController,
      );

      await jest.advanceTimersByTimeAsync(5_000);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(renewMock).toHaveBeenCalledTimes(4);
      expect(heartbeat.lost()).toBe(false);

      await heartbeat.stop();
      await jest.advanceTimersByTimeAsync(15_000);
      expect(renewMock).toHaveBeenCalledTimes(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('turns an authority assertion failure into meeting-wide lease loss and abort', async () => {
    const failure = new Error('stale fence');
    assertLeaseMock.mockRejectedValue(failure);
    const abortController = new AbortController();
    const heartbeat = startMeetingPersonaHeartbeat([reservation()], abortController);

    await expect(heartbeat.authorityFor('participant_a')!.assertCurrent())
      .rejects.toThrow('stale fence');
    expect(heartbeat.lost()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(failure);
    await heartbeat.stop();
  });

  it('holds the Persona lease across authoritative writes and exposes the required signal', async () => {
    const abortController = new AbortController();
    const ownedReservation = reservation();
    const heartbeat = startMeetingPersonaHeartbeat([ownedReservation], abortController);
    const authority = heartbeat.authorityFor('participant_a')!;
    const task = jest.fn().mockResolvedValue('committed');

    await expect(authority.commitWhileCurrent!(task)).resolves.toBe('committed');

    expect(authority.signal).toBe(abortController.signal);
    expect(commitLeaseMock).toHaveBeenCalledWith(ownedReservation.fence, task);
    await heartbeat.stop();
  });

  it.each(['completed', 'cancelled', 'error'] as const)(
    'closes Activities as %s and wakes each Persona queue',
    async (status) => {
      const reservations = [reservation('persona_a'), reservation('persona_z')];
      await completeMeetingPersonaReservations(
        reservations,
        status,
        status === 'error' ? 'meeting failed' : undefined,
      );

      expect(completeActivityMock).toHaveBeenCalledTimes(2);
      expect(completeActivityMock).toHaveBeenCalledWith(expect.objectContaining({
        personaId: 'persona_a',
        status,
        outcomeRef: 'meeting:meeting_reservation',
        ...(status === 'error' ? { error: 'meeting failed' } : {}),
      }));
      expect(pumpMock.mock.calls.map(([personaId]) => personaId).sort())
        .toEqual(['persona_a', 'persona_z']);
    },
  );
});
