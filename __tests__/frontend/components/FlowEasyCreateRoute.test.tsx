import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockLoadFlows = jest.fn();
const mockCreateNewFlow = jest.fn();

jest.mock('next/navigation', () => ({
  // `isEditing` is now derived from the URL (#374), so push/replace must
  // actually move `window.location` for the component to observe the
  // change on its next render — mirroring what next/navigation's real
  // client-side router does.
  useRouter: () => ({
    push: (url: string) => { window.history.pushState({}, '', url); mockPush(url); },
    replace: (url: string) => { window.history.replaceState({}, '', url); mockReplace(url); },
    back: jest.fn(() => window.history.back()),
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
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
      props: { initialFlow?: { name?: string }; initialAuthoringMode?: string },
      _ref: React.ForwardedRef<unknown>,
    ) {
      return (
        <div data-testid="flow-builder" data-authoring-mode={props.initialAuthoringMode}>
          {props.initialFlow?.name}
        </div>
      );
    }),
  };
});

jest.mock('@/frontend/components/Flow/FlowDashboard', () => ({
  __esModule: true,
  default: () => <div data-testid="flow-dashboard" />,
}));

jest.mock('@/frontend/components/Flow/FlowManager/GenerateFlowDialog', () => ({
  __esModule: true,
  default: ({
    open,
    onGenerated,
  }: {
    open: boolean;
    onGenerated: (result: Record<string, unknown>) => void;
  }) => (
    <div data-testid="ai-generator">
      {String(open)}
      {open && (
        <button
          type="button"
          onClick={() => onGenerated({
            flow: {
              id: 'generated-flow',
              name: 'Generated agent',
              nodes: [{
                id: 'trigger',
                type: 'trigger',
                position: { x: 0, y: 0 },
                data: { label: 'Schedule', type: 'trigger' },
              }],
              edges: [],
            },
            flows: [],
            rootFlowId: 'generated-flow',
            errorCount: 0,
            warningCount: 0,
            attempts: 1,
            installedServers: [],
          })}
        >
          Continue to simple builder
        </button>
      )}
    </div>
  ),
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

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujoPage: jest.fn(),
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
    // The editor is now a real history entry (#374): entering it pushes
    // `?flow=<id>&mode=edit` rather than a bare replace to `/flows`.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/flows?flow=draft-assistant&mode=edit'));
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

  it('opens an AI-generated draft in the simple builder even when it has expert features', async () => {
    window.history.replaceState({}, '', '/flows');
    render(<FlowsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Create with AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue to simple builder' }));

    expect(await screen.findByTestId('flow-builder')).toHaveTextContent('Generated agent');
    expect(screen.getByTestId('flow-builder')).toHaveAttribute('data-authoring-mode', 'guided');
  });
});
