/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react';

import PersonaDetailShell from '@/frontend/components/Personas/PersonaDetailShell';
import {
  parseMeetingLaunchIntent,
  personaMeetingPath,
} from '@/frontend/components/Meetings/meetingLaunchIntent';
import type { PersonaDetail } from '@/frontend/services/personas';

const mockReplace = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const detail = {
  persona: {
    id: 'persona_jim',
    name: 'Jim & Co',
    lifecycleState: 'idle',
    provisioningState: 'ready',
    mission: 'Make careful decisions.',
  },
  roleVersion: { name: 'Developer', version: 1 },
} as PersonaDetail;

describe('Persona meeting entry', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    window.history.replaceState({}, '', '/personas/persona_jim?area=overview');
  });

  it('links to a meeting setup prefilled with the current Persona', () => {
    render(
      <PersonaDetailShell
        detail={detail}
        busy={false}
        refresh={jest.fn().mockResolvedValue(undefined)}
        startConversation={jest.fn().mockResolvedValue(undefined)}
        renderArea={() => null}
      />,
    );

    const meet = screen.getByRole('link', { name: 'meetings.persona.meet' });
    const href = meet.getAttribute('href');
    expect(href).toContain('/meetings?');
    expect(href).toContain('new=persona');
    expect(href).toContain('personaId=persona_jim');

    const parsed = parseMeetingLaunchIntent(new URL(href!, window.location.origin).search);
    expect(parsed?.participants).toEqual([{
      personaId: 'persona_jim',
      name: 'Jim & Co',
    }]);
  });

  it('encodes Persona names safely in the shared launch path', () => {
    const path = personaMeetingPath({ id: 'persona_jim', name: 'Jim & Co' });
    expect(parseMeetingLaunchIntent(new URL(path, window.location.origin).search)?.participants[0])
      .toEqual({ personaId: 'persona_jim', name: 'Jim & Co' });
  });
});
