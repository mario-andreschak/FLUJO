import type { Translator } from '@/frontend/i18n/core';

interface MeetingParticipantTarget {
  personaId?: string;
  personaArchived?: true;
  behaviorSlotKey?: string;
  behaviorName?: string;
}

export function friendlyBehaviorName(slotKey: string): string {
  return slotKey
    .replaceAll('_', ' ')
    .replaceAll('-', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function meetingParticipantSourceLabel(
  participant: MeetingParticipantTarget,
  t: Translator,
): string {
  if (participant.personaId || participant.personaArchived) {
    if (participant.behaviorSlotKey && participant.behaviorSlotKey !== 'primary') {
      return t('meetings.participant.personaBehavior', {
        behavior: participant.behaviorName
          || friendlyBehaviorName(participant.behaviorSlotKey),
      });
    }
    return participant.personaArchived
      ? t('meetings.participant.formerPersona')
      : t('meetings.participant.personaMainRole');
  }
  return t('meetings.participant.flow');
}
