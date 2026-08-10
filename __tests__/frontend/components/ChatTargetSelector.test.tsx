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

describe('ChatTargetSelector', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: mockFetch });
  });

  beforeEach(() => {
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => personas,
    });
  });

  it('offers active Personas alongside Flows and selects by Persona id', async () => {
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
    expect(onSelectPersona).toHaveBeenCalledWith('persona_active');
    expect(onSelectFlow).not.toHaveBeenCalled();
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
});
