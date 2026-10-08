import { randomUUID } from 'crypto';
import {
  createMeeting,
  createMeetingRecord,
  deleteMeeting,
  getMeeting,
  anonymizeMeetingPersonaAttribution,
  retireMeetingPersonaParticipants,
  listMeetingSummaries,
  listMeetings,
  sanitizeMeetingForApi,
  saveMeeting,
} from '@/backend/services/meetings/store';
import { appendMeetingEvent, readMeetingEvents } from '@/backend/services/meetings/eventLog';
import {
  ARCHIVED_MEETING_PARTICIPANT_NAME,
  type CreateMeetingInput,
} from '@/shared/types/meeting';

function input(overrides: Partial<CreateMeetingInput> = {}): CreateMeetingInput {
  return {
    id: `meeting-${randomUUID()}`,
    title: 'Architecture council',
    openingPrompt: 'Choose a durable coordination design.',
    participants: [
      { id: 'alice', name: 'Alice', flowId: 'flow-a', conversationId: randomUUID() },
      { id: 'bob', name: 'Bob', flowId: 'flow-b', conversationId: randomUUID() },
    ],
    ...overrides,
  };
}

describe('meeting snapshot store', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    await Promise.all(createdIds.splice(0).map((id) => deleteMeeting(id)));
  });

  it('constructs a versioned draft with participant conversations and policy defaults', () => {
    const record = createMeetingRecord(input({ id: undefined }));

    expect(record).toMatchObject({
      version: 1,
      status: 'draft',
      phase: 'draft',
      roundNumber: 0,
      lastEventSeq: -1,
      policy: {
        roundMode: 'barrier',
        entryMode: 'start-each-round',
        maxRounds: 6,
        concurrencyLimit: 4,
      },
    });
    expect(record.participants).toHaveLength(2);
    expect(record.participants.every((participant) => participant.lastDeliveredSeq === -1)).toBe(true);
    expect(new Set(record.participants.map((participant) => participant.conversationId)).size).toBe(2);
  });

  it('preserves opening brief attachments without sharing mutable input objects', () => {
    const openingMedia = [{ type: 'file' as const, name: 'brief.pdf', mimeType: 'application/pdf', data: 'cGRm' }];
    const record = createMeetingRecord(input({ openingMedia }));

    expect(record.openingMedia).toEqual(openingMedia);
    expect(record.openingMedia).not.toBe(openingMedia);
    expect(record.openingMedia?.[0]).not.toBe(openingMedia[0]);
  });

  it('normalizes the selected moderator and validates moderator policies', () => {
    const record = createMeetingRecord(input({
      moderatorParticipantId: 'bob',
      policy: { moderatorMode: 'facilitated' },
    }));
    expect(record.moderatorParticipantId).toBe('bob');
    expect(record.participants.find((participant) => participant.id === 'bob')?.role).toBe('moderator');
    expect(record.participants.find((participant) => participant.id === 'alice')?.role).toBe('participant');

    expect(() => createMeetingRecord(input({
      policy: { moderatorMode: 'bookends' },
    }))).toThrow(/requires a moderator/i);
  });

  it('rejects unsafe, duplicate, and invalid participant data', () => {
    expect(() => createMeetingRecord(input({ id: '../outside' }))).toThrow(/unsafe/i);
    expect(() => createMeetingRecord(input({
      participants: [
        { id: 'same', name: 'Alice', flowId: 'flow-a' },
        { id: 'same', name: 'Bob', flowId: 'flow-b' },
      ],
    }))).toThrow(/duplicate participant id/i);
    expect(() => createMeetingRecord(input({
      participants: [{ name: 'Only', flowId: 'flow-a' }],
    }))).toThrow(/requires between 2 and 16/i);
    expect(() => createMeetingRecord(input({
      policy: { maxRounds: 0 },
    }))).toThrow(/maxRounds/i);
  });

  it('accepts mixed Flow and Persona participants with exactly one target each', () => {
    const record = createMeetingRecord(input({
      participants: [
        { id: 'legacy', name: 'Legacy', flowId: 'flow-a' },
        {
          id: 'living',
          name: 'Living',
          personaId: 'persona_living',
          behaviorSlotKey: 'council',
          behaviorName: 'Decision council',
        },
      ],
    }));

    expect(record.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'legacy', flowId: 'flow-a' }),
      expect.objectContaining({
        id: 'living',
        personaId: 'persona_living',
        behaviorSlotKey: 'council',
        behaviorName: 'Decision council',
      }),
    ]));
    expect(record.participants.find((participant) => participant.id === 'legacy'))
      .not.toHaveProperty('personaId');
    expect(record.participants.find((participant) => participant.id === 'living'))
      .not.toHaveProperty('flowId');
  });

  it('strips durable reservation owners and attempt identities from API records', () => {
    const record = createMeetingRecord(input());
    record.personaReservationGeneration = 4;
    record.personaReservationIntent = {
      generation: 4,
      attemptId: 'private_attempt',
      ownerId: 'private_owner',
      state: 'running',
      createdAt: 10,
      updatedAt: 11,
      expiresAt: 30_011,
    };

    const serialized = JSON.stringify(sanitizeMeetingForApi(record));

    expect(serialized).not.toContain('private_attempt');
    expect(serialized).not.toContain('private_owner');
    expect(serialized).not.toContain('personaReservationIntent');
    expect(serialized).not.toContain('personaReservationGeneration');
  });

  it('atomically persists an additive Persona Behavior revision pin at creation', async () => {
    const creation = input({
      participants: [
        { id: 'legacy', name: 'Legacy', flowId: 'flow-a' },
        { id: 'living', name: 'Living', personaId: 'persona_living' },
      ],
    });
    createdIds.push(creation.id!);

    const created = await createMeeting(
      creation,
      new Map([['persona_living', 'revision_living']]),
    );

    expect(created.participants.find((participant) => participant.id === 'living'))
      .toMatchObject({ behaviorRevisionId: 'revision_living' });
    expect(created.participants.find((participant) => participant.id === 'legacy'))
      .not.toHaveProperty('behaviorRevisionId');
    expect(await getMeeting(created.id)).toEqual(created);
  });

  it('retires exact live Persona participants without rewriting retained evidence', async () => {
    const makePersonaMeeting = async (suffix: string, status: 'running' | 'completed') => {
      const creation = input({
        id: `meeting-retire-${suffix}-${randomUUID()}`,
        participants: [
          {
            id: `persona-${suffix}`,
            name: 'Retained Persona Name',
            personaId: 'persona_retire_exact',
            behaviorSlotKey: 'council',
            conversationId: randomUUID(),
          },
          {
            id: `unrelated-${suffix}`,
            name: 'Unrelated participant',
            flowId: 'flow-unrelated',
            conversationId: randomUUID(),
          },
        ],
      });
      createdIds.push(creation.id!);
      const record = createMeetingRecord(creation);
      record.status = status;
      record.participants[0].activityId = `activity-retire-${suffix}`;
      record.participants[0].behaviorRevisionId = `revision-retire-${suffix}`;
      return saveMeeting(record);
    };
    const live = await makePersonaMeeting('live', 'running');
    const completed = await makePersonaMeeting('completed', 'completed');
    const retainedEvent = (await appendMeetingEvent(live.id, {
      type: 'participant:spoke',
      audience: 'public',
      participantId: live.participants[0].id,
      participantName: live.participants[0].name,
      turnId: 'turn-retire-live',
      content: 'Retain this live contribution.',
      eventId: 'event-retire-live',
    })).event;

    await expect(retireMeetingPersonaParticipants('persona_retire_exact'))
      .resolves.toEqual({ meetings: 1, participants: 1 });
    const retired = await getMeeting(live.id);
    expect(retired?.participants[0]).toEqual({
      ...live.participants[0],
      status: 'left',
      personaRetired: true,
    });
    expect(retired?.participants[1]).toEqual(live.participants[1]);
    expect(retired?.personaReservationGeneration).toBe(1);
    expect(retired?.personaReservationIntent).toBeUndefined();
    expect(retired?.createdAt).toBe(live.createdAt);
    expect(retired?.updatedAt).toBe(live.updatedAt);
    await expect(readMeetingEvents(live.id)).resolves.toEqual([retainedEvent]);
    await expect(getMeeting(completed.id)).resolves.toEqual(completed);

    const firstRetirement = structuredClone(retired);
    await expect(retireMeetingPersonaParticipants('persona_retire_exact'))
      .resolves.toEqual({ meetings: 0, participants: 0 });
    await expect(getMeeting(live.id)).resolves.toEqual(firstRetirement);
    await expect(getMeeting(completed.id)).resolves.toEqual(completed);
  });

  it('anonymizes one exact Persona participant and its cached event names idempotently', async () => {
    const creation = input({
      participants: [
        {
          id: 'archived-persona',
          name: 'Private Persona Name',
          personaId: 'persona_archive_exact',
          behaviorSlotKey: 'council',
          conversationId: randomUUID(),
        },
        {
          id: 'unrelated-flow',
          name: 'Unrelated participant',
          flowId: 'flow-unrelated',
          conversationId: randomUUID(),
        },
      ],
    });
    createdIds.push(creation.id!);
    const record = createMeetingRecord(creation);
    record.participants[0].activityId = 'activity_archive_exact';
    record.participants[0].behaviorRevisionId = 'revision_archive_exact';
    const saved = await saveMeeting(record);
    const targetEvent = (await appendMeetingEvent(saved.id, {
      type: 'participant:spoke',
      audience: 'public',
      participantId: 'archived-persona',
      participantName: 'Private Persona Name',
      turnId: 'turn-archive',
      content: 'Retain this authored contribution.',
      eventId: 'event-archive-target',
    })).event;
    const unrelatedEvent = (await appendMeetingEvent(saved.id, {
      type: 'participant:spoke',
      audience: 'public',
      participantId: 'unrelated-flow',
      participantName: 'Unrelated participant',
      turnId: 'turn-unrelated',
      content: 'Retain this unrelated contribution.',
      eventId: 'event-archive-unrelated',
    })).event;

    await expect(anonymizeMeetingPersonaAttribution('persona_archive_exact'))
      .resolves.toEqual({ meetings: 1, participants: 1, events: 1 });
    const archived = await getMeeting(saved.id);
    expect(archived).toMatchObject({
      title: saved.title,
      openingPrompt: saved.openingPrompt,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      participants: [
        {
          id: 'archived-persona',
          name: ARCHIVED_MEETING_PARTICIPANT_NAME,
          personaArchived: true,
          behaviorSlotKey: 'council',
          status: 'left',
        },
        saved.participants[1],
      ],
    });
    expect(archived?.participants[0]).not.toHaveProperty('personaId');
    expect(archived?.participants[0]).not.toHaveProperty('activityId');
    expect(archived?.participants[0]).not.toHaveProperty('behaviorRevisionId');

    const events = await readMeetingEvents(saved.id);
    expect(events[0]).toEqual({
      ...targetEvent,
      participantName: ARCHIVED_MEETING_PARTICIPANT_NAME,
    });
    expect(events[1]).toEqual(unrelatedEvent);
    expect(events[0]).toMatchObject({
      content: 'Retain this authored contribution.',
      timestamp: targetEvent.timestamp,
    });

    const firstArchive = structuredClone(archived);
    const firstEvents = structuredClone(events);
    await expect(anonymizeMeetingPersonaAttribution('persona_archive_exact'))
      .resolves.toEqual({ meetings: 0, participants: 0, events: 0 });
    await expect(getMeeting(saved.id)).resolves.toEqual(firstArchive);
    await expect(readMeetingEvents(saved.id)).resolves.toEqual(firstEvents);
  });

  it('rejects missing, ambiguous, and duplicate Persona targets', () => {
    expect(() => createMeetingRecord(input({
      participants: [
        { id: 'ambiguous', name: 'Ambiguous', flowId: 'flow-a', personaId: 'persona_a' },
        { id: 'legacy', name: 'Legacy', flowId: 'flow-b' },
      ],
    }))).toThrow(/exactly one Flow or Persona/i);
    expect(() => createMeetingRecord(input({
      participants: [
        { id: 'missing', name: 'Missing' },
        { id: 'legacy', name: 'Legacy', flowId: 'flow-b' },
      ],
    }))).toThrow(/exactly one Flow or Persona/i);
    expect(() => createMeetingRecord(input({
      participants: [
        { id: 'first', name: 'First', personaId: 'persona_same' },
        { id: 'second', name: 'Second', personaId: 'persona_same' },
      ],
    }))).toThrow(/Duplicate Persona participant/i);
    expect(() => createMeetingRecord(input({
      participants: [
        { id: 'persona', name: 'Persona', personaId: 'persona_named', behaviorName: 'Unbound label' },
        { id: 'legacy', name: 'Legacy', flowId: 'flow-b' },
      ],
    }))).toThrow(/Behavior selection/i);
  });

  it('creates, updates, lists, summarizes, and fully deletes a meeting', async () => {
    const creation = input();
    createdIds.push(creation.id!);
    const created = await createMeeting(creation);
    expect(await getMeeting(created.id)).toEqual(created);

    const saved = await saveMeeting({ ...created, title: 'Updated council', updatedAt: 1 });
    expect(saved.title).toBe('Updated council');
    expect(saved.updatedAt).toBeGreaterThan(1);
    expect((await listMeetings()).some((meeting) => meeting.id === created.id)).toBe(true);

    const summary = (await listMeetingSummaries()).find((item) => item.id === created.id);
    expect(summary).toMatchObject({
      title: 'Updated council',
      participantCount: 2,
      activeParticipantCount: 2,
      participantNames: ['Alice', 'Bob'],
    });

    await appendMeetingEvent(created.id, {
      type: 'meeting:created',
      audience: 'public',
      title: created.title,
    });
    expect(await readMeetingEvents(created.id)).toHaveLength(1);

    await deleteMeeting(created.id);
    createdIds.splice(createdIds.indexOf(created.id), 1);
    expect(await getMeeting(created.id)).toBeNull();
    expect(await readMeetingEvents(created.id)).toEqual([]);
  });

  it('does not overwrite an explicitly duplicated meeting id', async () => {
    const creation = input();
    createdIds.push(creation.id!);
    await createMeeting(creation);
    await expect(createMeeting(creation)).rejects.toThrow(/already exists/i);
  });
});
