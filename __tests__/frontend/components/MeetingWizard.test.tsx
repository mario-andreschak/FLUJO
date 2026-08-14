/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import MeetingWizard from '@/frontend/components/Meetings/MeetingWizard';
import type { PersonaComposition } from '@/shared/types/enduringAgent';
import type { CreateMeetingInput } from '@/shared/types/meeting';

const mockLoadFlows = jest.fn();
const mockListPersonas = jest.fn();
const mockGetComposition = jest.fn();

const mockTranslations: Record<string, string> = {
  'meetings.participants.source.persona': 'A Persona',
  'meetings.participants.source.flow': 'A Flow',
  'meetings.participants.source.recommended': 'Recommended',
  'meetings.participants.source.personaHelp': 'Uses identity and memory',
  'meetings.participants.source.flowHelp': 'Uses a Flow directly',
  'meetings.participants.behavior': 'How should {name} join?',
  'meetings.participants.mainRole': 'Main role',
};

jest.mock('@/frontend/contexts/I18nContext', () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const template = mockTranslations[key] ?? key;
      return Object.entries(values ?? {}).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        template,
      );
    },
  }),
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: (...args: unknown[]) => mockLoadFlows(...args) },
}));

jest.mock('@/frontend/services/personas', () => ({
  personasService: {
    list: (...args: unknown[]) => mockListPersonas(...args),
    getComposition: (...args: unknown[]) => mockGetComposition(...args),
  },
}));

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({ flow }: { flow: { name: string } }) => <div>{flow.name}</div>,
}));

jest.mock('@/frontend/components/shared/DialogHeaderActions', () => ({
  __esModule: true,
  default: ({ title }: { title: React.ReactNode }) => <div>{title}</div>,
}));

function composition(
  personaId: string,
  behaviors: Array<{ slotKey: string; name: string; description?: string }> = [],
): PersonaComposition {
  return {
    personaRef: personaId,
    name: personaId,
    description: '',
    role: { ref: 'role', name: 'Role', prompt: '', suggestedAppRefs: [] },
    coreFlowRef: `flow_${personaId}`,
    core: {
      binding: { mode: 'shared', sharedFlowRef: `flow_${personaId}` },
      effectiveFlowRef: `flow_${personaId}`,
      readiness: { state: 'ready', issues: [] },
    },
    appRefs: [],
    memories: [],
    behaviors: [],
    behaviorCards: behaviors.map((behavior, index) => ({
      ref: `behavior_${personaId}_${index}`,
      slotKey: behavior.slotKey,
      name: behavior.name,
      description: behavior.description,
      order: index,
      binding: { mode: 'shared', sharedFlowRef: `flow_${behavior.slotKey}` },
      effectiveFlowRef: `flow_${behavior.slotKey}`,
      readiness: { state: 'ready', issues: [] },
    })),
    expectedUpdatedAt: 1,
  };
}

function renderWizard(initialInput: CreateMeetingInput, onSubmit = jest.fn()) {
  render(
    <MeetingWizard
      open
      initialInput={initialInput}
      onClose={jest.fn()}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
}

async function advance() {
  const next = screen.getByRole('button', { name: 'common.next' });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
}

describe('MeetingWizard Persona participants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadFlows.mockResolvedValue([
      { id: 'flow_alpha', name: 'Alpha Flow', nodes: [], edges: [] },
      { id: 'flow_beta', name: 'Beta Flow', nodes: [], edges: [] },
    ]);
    mockListPersonas.mockResolvedValue([
      {
        id: 'persona_jim',
        name: 'Jim',
        lifecycleState: 'idle',
        provisioningState: 'ready',
        mission: 'Research the hard parts.',
      },
      {
        id: 'persona_sara',
        name: 'Sara',
        lifecycleState: 'idle',
        provisioningState: 'ready',
        mission: 'Challenge assumptions.',
      },
    ]);
    mockGetComposition.mockImplementation((personaId: string) => Promise.resolve(
      personaId === 'persona_jim'
        ? composition(personaId, [{
          slotKey: 'research_specialist',
          name: 'Research specialist',
          description: 'Investigates evidence.',
        }])
        : composition(personaId),
    ));
  });

  it('submits a Persona with a named specialist Behavior and a main-role Persona', async () => {
    const onSubmit = renderWizard({
      title: 'Launch decision',
      openingPrompt: 'Compare the evidence and recommend the safest launch plan.',
      participants: [
        { id: 'participant_jim', personaId: 'persona_jim', name: 'Jim' },
        { id: 'participant_sara', personaId: 'persona_sara', name: 'Sara' },
      ],
    });

    await advance();

    expect(await screen.findByRole('radio', { name: /A Persona/ })).toBeChecked();
    const jimBehavior = await screen.findByLabelText('How should Jim join?');
    fireEvent.mouseDown(jimBehavior);
    fireEvent.click(await screen.findByRole('option', { name: 'Research specialist' }));

    await advance();
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'meetings.review.start' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as CreateMeetingInput;
    expect(submitted.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'participant_jim',
        personaId: 'persona_jim',
        behaviorSlotKey: 'research_specialist',
        behaviorName: 'Research specialist',
        name: 'Jim',
      }),
      expect.objectContaining({
        id: 'participant_sara',
        personaId: 'persona_sara',
        behaviorSlotKey: undefined,
        name: 'Sara',
      }),
    ]));
    expect(submitted.participants.every((participant) => participant.flowId === undefined)).toBe(true);
  });

  it('preserves the existing Flow-only selection and payload', async () => {
    const onSubmit = renderWizard({
      title: 'Flow review',
      openingPrompt: 'Compare both Flow outputs and agree on the next action.',
      participants: [
        { id: 'participant_alpha', flowId: 'flow_alpha', name: 'Alpha' },
        { id: 'participant_beta', flowId: 'flow_beta', name: 'Beta' },
      ],
    });

    await advance();
    expect(await screen.findByRole('radio', { name: /A Flow/ })).toBeChecked();

    await advance();
    await advance();
    fireEvent.click(screen.getByRole('button', { name: 'meetings.review.start' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as CreateMeetingInput;
    expect(submitted.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'participant_alpha', flowId: 'flow_alpha', name: 'Alpha' }),
      expect.objectContaining({ id: 'participant_beta', flowId: 'flow_beta', name: 'Beta' }),
    ]));
    expect(submitted.participants.every((participant) => participant.personaId === undefined)).toBe(true);
  });
});
