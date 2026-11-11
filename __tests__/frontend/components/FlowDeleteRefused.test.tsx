import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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

describe('deleting a flow from the flow list', () => {
  beforeEach(() => {
    mockLoadFlows.mockReset().mockResolvedValue([flow]);
    mockDeleteFlow.mockReset();
    window.localStorage.clear();
    window.history.replaceState({}, '', '/flows');
  });

  it('keeps the flow and shows the reason when the server refuses', async () => {
    const reason = 'Flow "Bound flow" is used by Persona "Jim". Replace or remove that binding first.';
    mockDeleteFlow.mockResolvedValue({ success: false, error: reason });
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete Bound flow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(reason);
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
