import type { MeetingEvent, MeetingRecord } from '@/shared/types/meeting';
import type { ModelMediaPart } from '@/shared/types/model/media';

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

function compactExcerpt(value: string, maxLength = 480): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Deterministic context for a distinct follow-up meeting; the lossless log is attached separately. */
export function meetingFollowupSummary(meeting: MeetingRecord, events: MeetingEvent[]): string {
  const terminal = [...events].reverse().find((event) =>
    event.type === 'meeting:completed'
    || event.type === 'meeting:cancelled'
    || event.type === 'meeting:error');
  const outcome = terminal?.type === 'meeting:error'
    ? terminal.error
    : terminal && 'reason' in terminal
      ? terminal.reason
      : undefined;
  const acceptedMotions = meeting.motions.filter((motion) => motion.status === 'accepted');
  const latestContributionByParticipant = new Map<string, Extract<MeetingEvent, { type: 'participant:spoke' }>>();
  for (const event of [...events].reverse()) {
    if (event.type !== 'participant:spoke' || latestContributionByParticipant.has(event.participantId)) continue;
    latestContributionByParticipant.set(event.participantId, event);
  }
  const conclusions = meeting.participants
    .map((participant) => latestContributionByParticipant.get(participant.id))
    .filter((event): event is Extract<MeetingEvent, { type: 'participant:spoke' }> => Boolean(event));

  return [
    'Previous meeting summary:',
    `- Status: ${meeting.status}`,
    `- Previous outcome: ${outcome?.trim() || 'No explicit outcome was recorded.'}`,
    acceptedMotions.length
      ? `- Accepted decisions: ${acceptedMotions.map((motion) => compactExcerpt(motion.proposal ?? motion.reason ?? motion.kind, 240)).join('; ')}`
      : undefined,
    conclusions.length ? '- Latest participant conclusions:' : undefined,
    ...conclusions.map((event) => `  - ${event.participantName}: ${compactExcerpt(event.content)}`),
    '- The full public prior-meeting log is attached to this brief.',
  ].filter((line): line is string => Boolean(line)).join('\n');
}

function utf8Base64(value: string): string {
  const encodedUri = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let index = 0; index < encodedUri.length; index++) {
    if (encodedUri[index] === '%') {
      bytes.push(Number.parseInt(encodedUri.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(encodedUri.charCodeAt(index));
    }
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triplet = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(triplet >> 18) & 63];
    encoded += alphabet[(triplet >> 12) & 63];
    encoded += second === undefined ? '=' : alphabet[(triplet >> 6) & 63];
    encoded += third === undefined ? '=' : alphabet[triplet & 63];
  }
  return encoded;
}

/** Full public transcript delivered to every participant in a newly created follow-up. */
export function meetingLogAttachment(meeting: MeetingRecord, events: MeetingEvent[]): ModelMediaPart {
  const stem = meeting.title
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 80) || 'meeting';
  return {
    type: 'file',
    mimeType: 'text/markdown',
    name: `${stem}-full-log.md`,
    data: utf8Base64(meetingLogMarkdown(
      meeting,
      events.filter((event) => event.audience === 'public'),
    )),
  };
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
      case 'meeting:resumed': lines.push(`> Meeting continued · ${time}: ${event.direction ?? 'No additional direction.'}`, ''); break;
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
