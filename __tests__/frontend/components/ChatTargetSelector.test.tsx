import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('@/frontend/components/Chat/FlowSelector', () => ({
  __esModule: true,
  default: ({ onSelectFlow }: { onSelectFlow: (id: string) => void }) => (
    <button type="button" onClick={() => onSelectFlow('flow-one')}>Flow target</button>
  ),
}));

import ChatTargetSelector from '@/frontend/components/Chat/ChatTargetSelector';

const mockFetch = jest.fn();

const personas = [
  {
    schemaVersion: 1,
    id: 'persona_active',
    name: 'Ada',
    roleVersionId: 'role-version-1',
    lifecycleState: 'idle',
    mission: 'Help with research',
    autonomyLevel: 'locked',
    interruptionPolicy: 'queue',
    provisioningState: 'ready',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    schemaVersion: 1,
    id: 'persona_disabled',
    name: 'Disabled Persona',
    roleVersionId: 'role-version-1',
    lifecycleState: 'disabled',
    autonomyLevel: 'locked',
    interruptionPolicy: 'queue',
    provisioningState: 'ready',
    createdAt: 1,
    updatedAt: 1,
  },
];

const composition = {
  personaRef: 'persona_active',
  name: 'Ada',
  description: 'Research partner',
  role: {},
  coreFlowRef: 'flow-main',
  core: {
    binding: { sourceFlowRef: 'flow-main' },
    effectiveFlowRef: 'flow-main',
    readiness: { state: 'ready', issues: [] },
  },
  appRefs: [],
  memories: [],
  behaviors: [],
  behaviorCards: [
    {
      ref: 'behavior-research',
      slotKey: 'research',
      name: 'Research specialist',
      description: 'Dig deeply into a question.',
      order: 0,
      binding: { sourceFlowRef: 'flow-research' },
      effectiveFlowRef: 'flow-research',
      readiness: { state: 'ready', issues: [] },
    },
  ],
  expectedUpdatedAt: 1,
};

describe('ChatTargetSelector', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: mockFetch });
  });

  beforeEach(() => {
    mockFetch.mockReset().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => String(input).includes('/composition') ? composition : personas,
    }));
  });

  it('offers active Personas alongside Flows and selects the recommended Main role', async () => {
    const onSelectPersona = jest.fn();
    const onSelectFlow = jest.fn();
    render(
      <ChatTargetSelector
        selectedFlowId={null}
        onSelectFlow={onSelectFlow}
        onSelectPersona={onSelectPersona}
      />,
    );

    const personaButton = await screen.findByRole('button', { name: 'Persona' });
    await waitFor(() => expect(personaButton).toBeEnabled());
    fireEvent.click(personaButton);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ada')).toBeInTheDocument();
    expect(within(dialog).queryByText('Disabled Persona')).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByText('Ada'));
    expect(onSelectPersona).not.toHaveBeenCalled();
    const mainRole = await within(dialog).findByText('Main role');
    expect(within(dialog).getByText('Recommended')).toBeInTheDocument();
    fireEvent.click(mainRole);
    expect(onSelectPersona).toHaveBeenCalledWith('persona_active', 'primary');
    expect(onSelectFlow).not.toHaveBeenCalled();
  });

  it('lets people choose a named specialist Behavior without exposing its slot key', async () => {
    const onSelectPersona = jest.fn();
    render(
      <ChatTargetSelector
        selectedFlowId={null}
        onSelectFlow={jest.fn()}
        onSelectPersona={onSelectPersona}
      />,
    );

    const personaButton = await screen.findByRole('button', { name: 'Persona' });
    await waitFor(() => expect(personaButton).toBeEnabled());
    fireEvent.click(personaButton);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByText('Ada'));

    const specialist = await within(dialog).findByText('Research specialist');
    expect(within(dialog).queryByText('research', { exact: true })).not.toBeInTheDocument();
    fireEvent.click(specialist);
    expect(onSelectPersona).toHaveBeenCalledWith('persona_active', 'research');
  });

  it('locks a selected Persona target instead of exposing a dead switch action', async () => {
    render(
      <ChatTargetSelector
        selectedFlowId={null}
        selectedPersonaId="persona_active"
        onSelectFlow={jest.fn()}
        onSelectPersona={jest.fn()}
      />,
    );

    const selected = await screen.findByRole('button', { name: /Ada/i });
    await waitFor(() => expect(selected).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Flow target' })).not.toBeInTheDocument();
  });

  it('shows the selected Behavior in ordinary language on a locked conversation', async () => {
    render(
      <ChatTargetSelector
        selectedFlowId={null}
        selectedPersonaId="persona_active"
        selectedPersonaBehaviorSlotKey="research"
        onSelectFlow={jest.fn()}
        onSelectPersona={jest.fn()}
      />,
    );

    const selected = await screen.findByRole('button', { name: /Ada.*Research specialist/i });
    expect(selected).toBeDisabled();
  });
});
