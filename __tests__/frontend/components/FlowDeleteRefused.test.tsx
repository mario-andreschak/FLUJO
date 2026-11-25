import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockLoadFlows = jest.fn();
const mockDeleteFlow = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (url: string) => window.history.pushState({}, '', url),
    replace: (url: string) => window.history.replaceState({}, '', url),
    back: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => mockLoadFlows(...args),
    createNewFlow: jest.fn(),
    addFlow: jest.fn(),
    updateFlow: jest.fn(),
    deleteFlow: (...args: unknown[]) => mockDeleteFlow(...args),
  },
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockFlowBuilder() {
      return <div data-testid="flow-builder" />;
    }),
  };
});

jest.mock('@/frontend/components/Flow/FlowDashboard', () => ({
  __esModule: true,
  default: ({ flows, onDeleteFlow }: {
    flows: Array<{ id: string; name: string }>;
    onDeleteFlow: (flowId: string) => void;
  }) => (
    <ul>
      {flows.map(flow => (
        <li key={flow.id}>
          {flow.name}
          <button type="button" onClick={() => onDeleteFlow(flow.id)}>Delete {flow.name}</button>
        </li>
      ))}
    </ul>
  ),
}));

jest.mock('@/frontend/components/Flow/FlowManager/GenerateFlowDialog', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/frontend/components/shared/PageHeader', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <header><h1>{title}</h1></header>,
}));

jest.mock('@/frontend/utils/navigationGuard', () => ({
  setNavigationGuard: jest.fn(),
  clearNavigationGuard: jest.fn(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({ useAskFlujoPage: jest.fn() }));

import FlowsPage from '@/app/flows/page';

const flow = { id: 'bound-flow', name: 'Bound flow', nodes: [], edges: [] };
const replacement = { id: 'new-flow', name: 'New flow', nodes: [], edges: [] };
const usage = {
  flowId: 'bound-flow',
  flowName: 'Bound flow',
  uses: [{
    key: 'persona:jim:core',
    place: { kind: 'persona-core', personaId: 'jim', personaName: 'Jim' },
    canRemove: true,
    removePauses: true,
  }],
  copySources: [],
};

function chooseForJim(option: string) {
  fireEvent.mouseDown(within(screen.getByRole('group', { name: 'Jim: Persona, Core Flow' })).getByRole('combobox'));
  fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('deleting a flow from the flow list', () => {
  beforeEach(() => {
    mockLoadFlows.mockReset().mockResolvedValue([flow, replacement]);
    mockDeleteFlow.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/flows');
  });

  it('keeps the flow and shows the reason when the server refuses', async () => {
    const reason = 'The flow could not be deleted right now.';
    mockDeleteFlow.mockResolvedValue({ success: false, error: reason });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(reason);
    expect(screen.getByRole('button', { name: 'Delete Bound flow' })).toBeInTheDocument();
  });

  it('asks what happens to the Persona that uses the flow, then switches it and deletes (#1389)', async () => {
    mockDeleteFlow
      .mockResolvedValueOnce({ success: false, error: 'in use', usage })
      .mockResolvedValueOnce({ success: true, summary: { personas: ['Jim'], pausedPersonas: [], automations: [], turnedOffAutomations: [], flows: [] } });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Jim')).toBeInTheDocument();
    // The open dialog hides the list from assistive tech; the flow is still in it.
    expect(screen.getByRole('button', { name: 'Delete Bound flow', hidden: true })).toBeInTheDocument();

    chooseForJim('New flow');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete Bound flow', hidden: true })).not.toBeInTheDocument();
    });
    expect(mockDeleteFlow).toHaveBeenLastCalledWith('bound-flow', {
      choices: { 'persona:jim:core': { replaceWith: 'new-flow' } },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says which Persona was paused after taking the flow away from it', async () => {
    mockDeleteFlow
      .mockResolvedValueOnce({ success: false, error: 'in use', usage })
      .mockResolvedValueOnce({ success: true, summary: { personas: ['Jim'], pausedPersonas: ['Jim'], automations: [], turnedOffAutomations: [], flows: [] } });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));
    await screen.findByRole('dialog');
    chooseForJim('Remove it and pause Jim');
    fireEvent.click(screen.getByRole('button', { name: 'Delete agent' }));

    expect(await screen.findByText('Agent deleted. Now paused: Jim.')).toBeInTheDocument();
  });

  it('never hides a flow that was not deleted: cancel and failed deletes keep it', async () => {
    mockDeleteFlow
      .mockResolvedValueOnce({ success: false, error: 'in use', usage })
      .mockResolvedValueOnce({ success: false, error: 'Persona "Jim" is working right now. The flow was not deleted.' });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));
    const dialog = await screen.findByRole('dialog');
    chooseForJim('New flow');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete agent' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('is working right now');
    expect(screen.getByRole('button', { name: 'Delete Bound flow', hidden: true })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Delete Bound flow' })).toBeInTheDocument();
  });

  it('removes the flow when the server confirms the delete', async () => {
    mockDeleteFlow.mockResolvedValue({ success: true });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete Bound flow' })).not.toBeInTheDocument();
    });
  });
});
