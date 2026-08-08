import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import {
  countDiscussionRounds,
  isTranscriptVisibleEvent,
} from '@/frontend/components/Meetings/meetingTranscriptProjection';

const base = {
  version: 1 as const,
  meetingId: 'meeting-1',
  eventId: 'event-1',
  seq: 0,
  timestamp: 1,
  audience: 'public' as const,
};

describe('meeting transcript projection', () => {
  it('hides bookkeeping events from the human transcript', () => {
    const created: MeetingEvent = {
      ...base,
      type: 'meeting:created',
      title: 'Planning',
    };
    const modelStarted: MeetingEvent = {
      ...base,
      type: 'participant:started',
      participantId: 'agent-1',
      participantName: 'Strategist',
      turnId: 'turn-1',
    };

    expect(isTranscriptVisibleEvent(created)).toBe(false);
    expect(isTranscriptVisibleEvent(modelStarted)).toBe(false);
  });

  it('keeps published speech and meaningful lifecycle events', () => {
    const speech: MeetingEvent = {
      ...base,
      type: 'participant:spoke',
      participantId: 'agent-1',
      participantName: 'Strategist',
      turnId: 'turn-1',
      content: 'I recommend option B.',
    };
    const completed: MeetingEvent = {
      ...base,
      type: 'meeting:completed',
      reason: 'Consensus reached',
    };

    expect(isTranscriptVisibleEvent(speech)).toBe(true);
    expect(isTranscriptVisibleEvent(completed)).toBe(true);
  });

  it('does not count moderator-only synthesis turns as discussion rounds', () => {
    const meeting = {
      moderatorParticipantId: 'moderator',
      policy: { moderatorMode: 'facilitated', maxRounds: 6 },
    } as MeetingRecord;
    const events: MeetingEvent[] = [
      {
        ...base,
        eventId: 'round-1-event',
        type: 'round:started',
        round: {
          id: 'round-1', number: 1, phase: 'opening', status: 'running', snapshotSeq: 0,
          eligibleParticipantIds: ['moderator'], participantTurnIds: {},
        },
      },
      {
        ...base,
        eventId: 'round-2-event',
        type: 'round:started',
        round: {
          id: 'round-2', number: 2, phase: 'discussion', status: 'running', snapshotSeq: 1,
          eligibleParticipantIds: ['agent-1', 'moderator'], participantTurnIds: {},
        },
      },
      {
        ...base,
        eventId: 'round-3-event',
        type: 'round:started',
        round: {
          id: 'round-3', number: 3, phase: 'discussion', status: 'running', snapshotSeq: 2,
          eligibleParticipantIds: ['moderator'], participantTurnIds: {},
        },
      },
    ];

    expect(countDiscussionRounds(meeting, events)).toBe(1);
  });
});
