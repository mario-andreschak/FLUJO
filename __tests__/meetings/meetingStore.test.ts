import { randomUUID } from 'crypto';
import {
  createMeeting,
  createMeetingRecord,
  deleteMeeting,
  getMeeting,
  listMeetingSummaries,
  listMeetings,
  saveMeeting,
} from '@/backend/services/meetings/store';
import { appendMeetingEvent, readMeetingEvents } from '@/backend/services/meetings/eventLog';
import type { CreateMeetingInput } from '@/shared/types/meeting';

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
