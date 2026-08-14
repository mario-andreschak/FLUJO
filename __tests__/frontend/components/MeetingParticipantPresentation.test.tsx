/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';

import MeetingTable from '@/frontend/components/Meetings/MeetingTable';
import {
  friendlyBehaviorName,
  meetingParticipantSourceLabel,
} from '@/frontend/components/Meetings/meetingParticipantPresentation';
import type { Translator } from '@/frontend/i18n/core';
import type { MeetingParticipant } from '@/shared/types/meeting';

const mockT: Translator = (key, values) => {
  if (key === 'meetings.participant.personaMainRole') return 'Persona · Main role';
  if (key === 'meetings.participant.personaBehavior') return `Persona · ${values?.behavior}`;
  if (key === 'meetings.participant.formerPersona') return 'Former Persona';
  if (key === 'meetings.participant.flow') return 'Flow';
  return key;
};

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: mockT }),
}));

function participant(
  input: Pick<MeetingParticipant, 'id' | 'name'>
    & Partial<Pick<
      MeetingParticipant,
      'personaId' | 'flowId' | 'behaviorSlotKey' | 'behaviorName'
    >>,
): MeetingParticipant {
  return {
    conversationId: `conversation_${input.id}`,
    role: 'participant',
    status: 'idle',
    lastDeliveredSeq: -1,
    ...input,
  };
}

describe('meeting participant presentation', () => {
  it('turns stable Behavior keys into ordinary names', () => {
    expect(friendlyBehaviorName('research_specialist')).toBe('Research Specialist');
    expect(meetingParticipantSourceLabel({
      personaId: 'persona_jim',
      behaviorSlotKey: 'research_specialist',
    }, mockT)).toBe('Persona · Research Specialist');
    expect(meetingParticipantSourceLabel({ personaId: 'persona_jim' }, mockT))
      .toBe('Persona · Main role');
  });

  it('visibly labels Persona Behaviors and direct Flows at the meeting table', () => {
    render(<MeetingTable participants={[
      participant({
        id: 'jim',
        name: 'Jim',
        personaId: 'persona_jim',
        behaviorSlotKey: 'research_specialist',
        behaviorName: 'Evidence investigator',
      }),
      participant({ id: 'flow', name: 'Direct Flow', flowId: 'flow_direct' }),
    ]} />);

    expect(screen.getByText('Persona · Evidence investigator')).toBeInTheDocument();
    expect(screen.getByText('Flow')).toBeInTheDocument();
  });
});
