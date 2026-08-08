import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';

const HIDDEN_TRANSCRIPT_EVENTS = new Set<MeetingEvent['type']>([
  'meeting:created',
  'round:started',
  'round:completed',
  'participant:started',
  'vote:cast',
  'meeting:closing',
  'meeting:paused',
]);

/** Events that carry useful human-facing content rather than runtime bookkeeping. */
export function isTranscriptVisibleEvent(event: MeetingEvent): boolean {
  return !HIDDEN_TRANSCRIPT_EVENTS.has(event.type);
}

/** Moderator-only bookends/synthesis turns are orchestration, not discussion rounds. */
export function countDiscussionRounds(meeting: MeetingRecord, events: MeetingEvent[]): number {
  const discussionRoundIds = new Set<string>();
  for (const event of events) {
    if (event.type !== 'round:started' || event.round.phase !== 'discussion') continue;
    const includesDiscussant = meeting.policy.moderatorMode === 'none'
      || event.round.eligibleParticipantIds.some((id) => id !== meeting.moderatorParticipantId);
    if (includesDiscussant) discussionRoundIds.add(event.round.id);
  }
  return discussionRoundIds.size;
}
