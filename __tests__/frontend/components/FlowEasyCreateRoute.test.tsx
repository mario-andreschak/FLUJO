import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockLoadFlows = jest.fn();
const mockCreateNewFlow = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: (...args: unknown[]) => mockLoadFlows(...args),
    createNewFlow: (...args: unknown[]) => mockCreateNewFlow(...args),
    addFlow: jest.fn(),
    updateFlow: jest.fn(),
    deleteFlow: jest.fn(),
  },
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: React.forwardRef(function MockFlowBuilder(
      props: { initialFlow?: { name?: string } },
      _ref: React.ForwardedRef<unknown>,
    ) {
      return <div data-testid="flow-builder">{props.initialFlow?.name}</div>;
    }),
  };
});

jest.mock('@/frontend/components/Flow/FlowDashboard', () => ({
  __esModule: true,
  default: () => <div data-testid="flow-dashboard" />,
}));

jest.mock('@/frontend/components/Flow/FlowManager/GenerateFlowDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => <div data-testid="ai-generator">{String(open)}</div>,
}));

jest.mock('@/frontend/components/shared/PageHeader', () => ({
  __esModule: true,
  default: ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
    <header><h1>{title}</h1>{actions}</header>
  ),
}));

jest.mock('@/frontend/utils/navigationGuard', () => ({
  setNavigationGuard: jest.fn(),
  clearNavigationGuard: jest.fn(),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

import FlowsPage from '@/app/flows/page';

describe('easy agent creation deep link', () => {
  beforeEach(() => {
    mockReplace.mockReset();
    mockPush.mockReset();
    mockLoadFlows.mockReset().mockResolvedValue([]);
    mockCreateNewFlow.mockReset().mockReturnValue({
      id: 'draft-assistant',
      name: 'Untitled agent',
      nodes: [],
      edges: [],
    });
    window.localStorage.clear();
    window.history.replaceState({}, '', '/flows?create=assistant');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('opens a blank draft in simple mode without showing the AI generator', async () => {
    render(<FlowsPage />);

    expect(await screen.findByTestId('flow-builder')).toHaveTextContent('Untitled agent');
    expect(mockCreateNewFlow).toHaveBeenCalledWith('Untitled agent');
    expect(window.localStorage.getItem('flujo-ui:flow-builder:mode')).toBe(JSON.stringify('guided'));
    expect(screen.getByTestId('ai-generator')).toHaveTextContent('false');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/flows'));
  });

  it('offers a third creation path that starts directly in Expert view', async () => {
    window.history.replaceState({}, '', '/flows');
    render(<FlowsPage />);

    expect(await screen.findByRole('button', { name: 'Create with AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start simple' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start expert' }));

    expect(await screen.findByTestId('flow-builder')).toHaveTextContent('Untitled agent');
    expect(window.localStorage.getItem('flujo-ui:flow-builder:mode')).toBe(JSON.stringify('advanced'));
  });
});
