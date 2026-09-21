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
  useI18n: () => ({ t: (key: string) => key, locale: 'en', formatList: (items: Iterable<string>) => Array.from(items).join(', ') }),
}));

const detail: PersonaDetail = {
  persona: {
    schemaVersion: 2,
    id: 'persona_jim',
    name: 'Jim & Co',
    lifecycleState: 'idle',
    provisioningState: 'ready',
    mission: 'Make careful decisions.',
    roleVersionId: 'developer-v1',
    autonomyLevel: 'propose_overrides',
    interruptionPolicy: 'queue',
    createdAt: 1,
    updatedAt: 1,
  },
  roleVersion: { schemaVersion: 3, id: 'developer-v1', roleDefinitionId: 'developer',
    name: 'Developer', version: 1, mission: 'Make careful decisions.', behaviorSlots: [], createdAt: 1 },
  behaviorBindings: [],
  behaviorRevisions: [],
  appGrants: [],
  memoryItems: [],
  workItems: [],
  activities: [],
  mailboxItems: [],
  lease: null,
  runtime: {
    projection: { personaId: 'persona_jim', lifecycleState: 'idle',
      mailbox: { queued: 0, ready: 0, delayed: 0, claimed: 0, coalesced: 0, completed: 0, rejected: 0 },
      activities: { running: 0, waiting: 0, terminal: 0 }, active: null, waitingActivityIds: [],
      leaseStatus: 'none', stuck: false, stuckIndicators: [] },
    detectedStuckIndicators: [], reconciliation: { attempted: false, changed: false, remainingStuck: false }, recentEvents: [],
  },
  presentation: { conversations: [], tasks: [], history: [], current: null, queuedInputCount: 0 },
};

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
