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

/** Portable, lossless-enough human log used by the meeting page download action. */
export function meetingLogMarkdown(meeting: MeetingRecord, events: MeetingEvent[]): string {
  const participantName = (id: string) => meeting.participants.find((item) => item.id === id)?.name ?? id;
  const lines = [
    `# ${meeting.title}`,
    '',
    `- Status: ${meeting.status}`,
    `- Phase: ${meeting.phase}`,
    `- Created: ${new Date(meeting.createdAt).toISOString()}`,
    `- Participants: ${meeting.participants.map((item) => item.name).join(', ')}`,
    '',
    '## Opening brief',
    '',
    meeting.openingPrompt,
    '',
    '## Transcript',
    '',
  ];
  for (const event of events) {
    const time = new Date(event.timestamp).toISOString();
    switch (event.type) {
      case 'participant:spoke': lines.push(`### ${event.participantName} · ${time}`, '', event.content, ''); break;
      case 'private-message': lines.push(`> Private · ${participantName(event.fromParticipantId)} → ${event.toParticipantIds.map(participantName).join(', ')}: ${event.content}`, ''); break;
      case 'private-note': lines.push(`> Private note · ${time}: ${event.content}`, ''); break;
      case 'moderator:intervention': lines.push(`> Steering prompt · ${time}: ${event.content}`, ''); break;
      case 'motion:opened': lines.push(`> Motion opened · ${event.motion.kind}: ${event.motion.proposal ?? event.motion.reason ?? ''}`, ''); break;
      case 'vote:cast': lines.push(`> Vote · ${participantName(event.participantId)}: ${event.choice}${event.rationale ? ` — ${event.rationale}` : ''}`, ''); break;
      case 'motion:resolved': lines.push(`> Motion ${event.outcome} · yes ${event.tally.yes}, no ${event.tally.no}, abstain ${event.tally.abstain}`, ''); break;
      case 'participant:error': lines.push(`> Error · ${event.participantName}: ${event.error}`, ''); break;
      case 'meeting:error': lines.push(`> Meeting error: ${event.error}`, ''); break;
      case 'meeting:completed': lines.push(`> Meeting completed: ${event.reason ?? ''}`, ''); break;
      case 'meeting:cancelled': lines.push(`> Meeting stopped: ${event.reason ?? ''}`, ''); break;
      case 'breakout:completed': lines.push(`> Breakout report: ${event.summary}`, ''); break;
      default: break;
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}
