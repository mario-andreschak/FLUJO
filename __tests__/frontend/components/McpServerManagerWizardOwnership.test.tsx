import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import ServerManager from '@/frontend/components/mcp/MCPServerManager';

const retryMock = jest.fn();
const reserveMock = jest.fn();
const openMock = jest.fn();
let latestWizardProps: { onInstalled: (name: string) => Promise<void>; onAuthenticate: (name: string) => Promise<void> };
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
jest.mock('@/frontend/contexts/ThemeContext', () => ({ useTheme: () => ({ visualStyle: 'modern' }) }));
jest.mock('@/frontend/hooks/useServerStatus', () => ({ useServerStatus: () => ({
  servers: [], connectingServers: new Set(), retryServer: retryMock,
}) }));
jest.mock('@/frontend/hooks/useUiPreference', () => ({ useWorkspaceUiPreference: (_key: string, initial: unknown) => React.useState(initial) }));
jest.mock('@/frontend/hooks/useAutoFocusSearch', () => ({ useAutoFocusSearch: () => React.useRef(null) }));
jest.mock('@/frontend/hooks/useListScrollNav', () => ({ useListScrollNav: () => ({ ref: React.useRef(null), clusterProps: {} }) }));
jest.mock('@/frontend/utils/oauth', () => ({ reserveOAuthPopup: (...args: unknown[]) => reserveMock(...args), openOAuthPopup: (...args: unknown[]) => openMock(...args) }));
jest.mock('@/frontend/components/shared/PageHeader', () => ({ __esModule: true, default: ({ actions }: { actions: React.ReactNode }) => <div>{actions}</div> }));
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerList', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/Modals/ServerModal', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/ServerDetailsModal', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/McpAgentJourney', () => () => null);
jest.mock('@/frontend/components/mcp/McpAppsDashboard', () => () => null);
jest.mock('@/frontend/components/mcp/MCPServerManager/McpConnectionWizard', () => ({
  __esModule: true,
  default: (props: { open: boolean; onClose: () => void; onInstalled: (name: string) => Promise<void>; onAuthenticate: (name: string) => Promise<void> }) => {
    latestWizardProps = props;
    return props.open ? <div data-testid="wizard">
    <button onClick={props.onClose}>External close</button>
    <button onClick={() => void props.onInstalled('search')}>Installed callback</button>
    <button onClick={() => void props.onAuthenticate('search')}>Authenticate callback</button>
  </div> : null;
  },
}));

function connect() {
  fireEvent.click(document.querySelector('[data-tour="add-mcp-server"]')!);
}

describe('MCP manager wizard callback ownership', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it.each(['installation', 'authentication'])('rejects the retained %s callback before it starts refresh or OAuth', async (operation) => {
    const previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ alreadyAuthorized: true }) })) as unknown as typeof fetch;
    retryMock.mockResolvedValue(undefined);
    reserveMock.mockReturnValue({ close: jest.fn() });
    try {
      render(<ThemeProvider theme={createTheme()}><ServerManager /></ThemeProvider>);
      connect();
      const oldCallbacks = latestWizardProps;
      fireEvent.click(screen.getByText('External close'));
      connect();
      await act(async () => {
        if (operation === 'installation') await oldCallbacks.onInstalled('old');
        else await oldCallbacks.onAuthenticate('old');
      });
      expect(retryMock).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
      expect(reserveMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('wizard')).toBeInTheDocument();
    } finally { global.fetch = previousFetch; }
  });

  it('does not close the reopened authentication window when the old request finishes', async () => {
    const finishes: Array<(value: Response) => void> = [];
    const previousFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise((resolve) => { finishes.push(resolve); })) as typeof fetch;
    const windows = new Map<string, { close: jest.Mock }>();
    reserveMock.mockImplementation((name: string) => {
      if (!windows.has(name)) windows.set(name, { close: jest.fn() });
      return windows.get(name);
    });
    try {
      render(<ThemeProvider theme={createTheme()}><ServerManager /></ThemeProvider>);
      connect();
      fireEvent.click(screen.getByText('Authenticate callback'));
      fireEvent.click(screen.getByText('External close'));
      connect();
      fireEvent.click(screen.getByText('Authenticate callback'));
      const newPopup = reserveMock.mock.results[1].value;
      await act(async () => { finishes[0]({ ok: true, json: async () => ({ alreadyAuthorized: true }) } as Response); });
      expect(newPopup.close).not.toHaveBeenCalled();
      await act(async () => { finishes[1]({ ok: true, json: async () => ({ alreadyAuthorized: true }) } as Response); });
      expect(retryMock).toHaveBeenCalledTimes(1);
      expect(retryMock).toHaveBeenCalledWith('search');
      expect(newPopup.close).toHaveBeenCalledTimes(1);
    } finally { global.fetch = previousFetch; }
  });

  it('closes the current wizard after its own refresh finishes', async () => {
    retryMock.mockResolvedValue(undefined);
    render(<ThemeProvider theme={createTheme()}><ServerManager /></ThemeProvider>);
    connect();
    await act(async () => { fireEvent.click(screen.getByText('Installed callback')); });
    expect(retryMock).toHaveBeenCalledWith('search');
    expect(screen.queryByTestId('wizard')).not.toBeInTheDocument();
  });

  it('does not close a reopened wizard when the old refresh finishes', async () => {
    let finish!: () => void;
    retryMock.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ThemeProvider theme={createTheme()}><ServerManager /></ThemeProvider>);
    connect();
    fireEvent.click(screen.getByText('Installed callback'));
    fireEvent.click(screen.getByText('External close'));
    connect();
    await act(async () => { finish(); });
    expect(screen.getByTestId('wizard')).toBeInTheDocument();
  });

  it('does not start old OAuth navigation after the wizard is closed', async () => {
    let finish!: (value: Response) => void;
    const previousFetch = global.fetch;
    global.fetch = jest.fn(() => new Promise((resolve) => { finish = resolve; })) as typeof fetch;
    const popup = { close: jest.fn() };
    reserveMock.mockReturnValue(popup);
    try {
      render(<ThemeProvider theme={createTheme()}><ServerManager /></ThemeProvider>);
      connect();
      fireEvent.click(screen.getByText('Authenticate callback'));
      fireEvent.click(screen.getByText('External close'));
      connect();
      await act(async () => { finish({ ok: true, json: async () => ({ authorizationUrl: 'https://example.com/auth' }) } as Response); });
      expect(openMock).not.toHaveBeenCalled();
      expect(retryMock).not.toHaveBeenCalled();
      expect(popup.close).toHaveBeenCalled();
    } finally { global.fetch = previousFetch; }
  });
});
