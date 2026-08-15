import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import {
  countDiscussionRounds,
  isTranscriptVisibleEvent,
  meetingFollowupSummary,
  meetingLogAttachment,
  meetingLogMarkdown,
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

  it('keeps human notes and steering in the visible log projection', () => {
    const note: MeetingEvent = { ...base, type: 'private-note', audience: [], content: 'Check the assumptions.' };
    const steering: MeetingEvent = { ...base, eventId: 'event-2', type: 'moderator:intervention', content: 'Compare the two launch dates.' };

    expect(isTranscriptVisibleEvent(note)).toBe(true);
    expect(isTranscriptVisibleEvent(steering)).toBe(true);
  });

  it('does not count moderator-only synthesis turns as discussion rounds', () => {
    const meeting = {
      moderatorParticipantId: 'moderator',
      policy: { moderatorMode: 'facilitated', maxRounds: 6 },
    } as unknown as MeetingRecord;
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

  it('exports a readable markdown log with speech, notes, and votes', () => {
    const meeting = {
      title: 'Launch council', status: 'completed', phase: 'completed', createdAt: 1,
      openingPrompt: 'Choose a launch date.',
      participants: [{ id: 'agent-1', name: 'Strategist' }],
    } as MeetingRecord;
    const events: MeetingEvent[] = [
      { ...base, type: 'participant:spoke', participantId: 'agent-1', participantName: 'Strategist', turnId: 'turn-1', content: 'Launch on Tuesday.' },
      { ...base, eventId: 'note-1', seq: 1, type: 'private-note', audience: [], content: 'Validate demand.' },
      { ...base, eventId: 'vote-1', seq: 2, type: 'vote:cast', motionId: 'motion-1', participantId: 'agent-1', choice: 'yes' },
    ];

    const markdown = meetingLogMarkdown(meeting, events);
    expect(markdown).toContain('# Launch council');
    expect(markdown).toContain('### Strategist');
    expect(markdown).toContain('Private note');
    expect(markdown).toContain('Vote · Strategist: yes');
  });

  it('builds follow-up context with an outcome summary and a full transcript attachment', () => {
    const meeting = {
      title: 'Launch council', status: 'completed', phase: 'completed', createdAt: 1,
      openingPrompt: 'Choose a launch date.',
      motions: [],
      participants: [
        { id: 'agent-1', name: 'Strategist' },
        { id: 'agent-2', name: 'Operator' },
      ],
    } as unknown as MeetingRecord;
    const events: MeetingEvent[] = [
      { ...base, type: 'participant:spoke', participantId: 'agent-1', participantName: 'Strategist', turnId: 'turn-1', content: 'Launch on Tuesday after the smoke test.' },
      { ...base, eventId: 'speech-2', seq: 1, type: 'participant:spoke', participantId: 'agent-2', participantName: 'Operator', turnId: 'turn-2', content: 'The smoke test is the remaining gate.' },
      { ...base, eventId: 'completed', seq: 2, type: 'meeting:completed', reason: 'Tuesday launch, gated by smoke tests.' },
      { ...base, eventId: 'private-note', seq: 3, type: 'private-note', audience: [], content: 'Moderator-only note.' },
    ];

    const summary = meetingFollowupSummary(meeting, events);
    const attachment = meetingLogAttachment(meeting, events);

    expect(summary).toContain('Previous outcome: Tuesday launch, gated by smoke tests.');
    expect(summary).toContain('Strategist: Launch on Tuesday');
    expect(summary).toContain('Operator: The smoke test');
    expect(attachment.name).toBe('launch-council-full-log.md');
    const attachedLog = Buffer.from(attachment.data!, 'base64').toString('utf8');
    expect(attachedLog).toContain('### Strategist');
    expect(attachedLog).not.toContain('Moderator-only note.');
  });
});
