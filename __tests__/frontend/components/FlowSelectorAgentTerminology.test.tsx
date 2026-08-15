import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';

const mockLoadFlows = jest.fn();

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => mockLoadFlows(...args),
    updateFlow: jest.fn(),
  },
}));

jest.mock('@/frontend/hooks/useCardPicker', () => ({
  useCardPicker: (_kind: string, items: unknown[]) => ({
    items,
    groups: null,
    searchTerm: '',
    setSearchTerm: jest.fn(),
    collapsedKeys: new Set<string>(),
    toggleGroup: jest.fn(),
  }),
}));

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({ flow, onSelect }: { flow: { id: string; name: string }; onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => onSelect(flow.id)}>{flow.name}</button>
  ),
  FlowCardSkeleton: () => <div data-testid="agent-card-skeleton" />,
}));

jest.mock('@/frontend/components/shared/CardPickerDialog', () => ({
  __esModule: true,
  default: ({
    open,
    title,
    description,
    emptyMessage,
    searchPlaceholder,
    items,
    fullScreen,
  }: {
    open: boolean;
    title: string;
    description: string;
    emptyMessage: string;
    searchPlaceholder: string;
    items: Array<{ key: string; content: ReactNode }>;
    fullScreen?: boolean;
  }) => open ? (
    <div role="dialog" aria-label={title} data-full-screen={String(!!fullScreen)}>
      <h2>{title}</h2>
      <p>{description}</p>
      <input aria-label="Agent search" placeholder={searchPlaceholder} />
      {items.length > 0 ? items.map((item) => <div key={item.key}>{item.content}</div>) : <p>{emptyMessage}</p>}
    </div>
  ) : null,
}));

import FlowSelector from '@/frontend/components/Chat/FlowSelector';

const agents = [
  { id: 'flow-research', name: 'Research Agent', nodes: [], edges: [] },
  { id: 'flow-writing', name: 'Writing Agent', nodes: [], edges: [] },
];

describe('Talk agent picker terminology', () => {
  beforeEach(() => {
    mockLoadFlows.mockReset();
  });

  it('uses the Agent name while the picker is loading', () => {
    mockLoadFlows.mockReturnValue(new Promise(() => undefined));

    render(<FlowSelector selectedFlowId={null} onSelectFlow={() => undefined} />);

    expect(screen.getByText('Loading agents…')).toBeInTheDocument();
    expect(screen.queryByText(/Loading flows/i)).not.toBeInTheDocument();
  });

  it('uses the Agent name for its heading and empty state', async () => {
    mockLoadFlows.mockResolvedValue([]);

    render(<FlowSelector selectedFlowId={null} onSelectFlow={() => undefined} />);

    expect(screen.getByText('Select an agent')).toBeInTheDocument();
    expect(await screen.findByText('No agents available. Create an agent first.')).toBeInTheDocument();
    expect(screen.queryByText(/\bflows?\b/i)).not.toBeInTheDocument();
  });

  it('describes the active Agent and selection action in user language', async () => {
    mockLoadFlows.mockResolvedValue(agents);

    render(<FlowSelector selectedFlowId="flow-research" onSelectFlow={() => undefined} />);

    const openPicker = await screen.findByRole('button', { name: 'Research Agent' });
    expect(screen.getByText('Using “Research Agent” for this conversation')).toBeInTheDocument();

    fireEvent.click(openPicker);
    const dialog = screen.getByRole('dialog', { name: 'Select an agent' });
    expect(within(dialog).getByText('Choose the agent for this conversation.')).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText('Search agents…')).toBeInTheDocument();
    expect(within(dialog).queryByText(/\bflows?\b/i)).not.toBeInTheDocument();
  });

  it('prompts for an Agent when the conversation does not have one yet', async () => {
    mockLoadFlows.mockResolvedValue(agents);

    render(<FlowSelector selectedFlowId={null} onSelectFlow={() => undefined} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Select an agent' })).toBeInTheDocument());
    expect(screen.getByText('Select an agent for this conversation')).toBeInTheDocument();
  });

  it('uses a one-line selector and full-screen picker in compact mode', async () => {
    mockLoadFlows.mockResolvedValue(agents);

    render(
      <FlowSelector
        compact
        selectedFlowId="flow-research"
        onSelectFlow={() => undefined}
      />,
    );

    const openPicker = await screen.findByRole('button', { name: 'Research Agent' });
    expect(screen.queryByText('Using “Research Agent” for this conversation')).not.toBeInTheDocument();

    fireEvent.click(openPicker);
    expect(screen.getByRole('dialog', { name: 'Select an agent' })).toHaveAttribute('data-full-screen', 'true');
  });

  it('can keep the compact selector in a desktop-sized dialog', async () => {
    mockLoadFlows.mockResolvedValue(agents);

    render(
      <FlowSelector
        compact
        fullScreenPicker={false}
        selectedFlowId="flow-research"
        onSelectFlow={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Research Agent' }));
    expect(screen.getByRole('dialog', { name: 'Select an agent' })).toHaveAttribute('data-full-screen', 'false');
  });

  it('renders as an embedded picker and reports the selected Agent name to a shared trigger', async () => {
    mockLoadFlows.mockResolvedValue(agents);
    const onSelectedFlowNameChange = jest.fn();

    render(
      <FlowSelector
        embedded
        selectedFlowId="flow-research"
        onSelectFlow={() => undefined}
        onSelectedFlowNameChange={onSelectedFlowNameChange}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Research Agent' })).toBeInTheDocument();
    await waitFor(() => expect(onSelectedFlowNameChange).toHaveBeenCalledWith('Research Agent'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
