import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import McpAppsDashboard from '@/frontend/components/mcp/McpAppsDashboard';
import { mcpService } from '@/frontend/services/mcp';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(),
    listServerResources: jest.fn(),
    listServerTools: jest.fn(),
    clearCapabilitiesCache: jest.fn(),
    clearToolsCache: jest.fn(),
  },
}));

jest.mock('@/frontend/components/Chat/McpAppFrame', () => ({
  __esModule: true,
  default: ({ serverName, uri }: { serverName: string; uri: string }) => (
    <div data-testid="mcp-app-frame" data-server={serverName} data-uri={uri} />
  ),
}));

const service = mcpService as jest.Mocked<typeof mcpService>;
const APP_MIME = 'text/html;profile=mcp-app';

const renderDashboard = (onOpenToolTester = jest.fn()) => {
  const onClose = jest.fn();
  render(
    <ThemeProvider theme={createTheme()}>
      <McpAppsDashboard open onClose={onClose} onOpenToolTester={onOpenToolTester} />
    </ThemeProvider>,
  );
  return { onClose, onOpenToolTester };
};

describe('McpAppsDashboard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.listServerResources.mockResolvedValue({ resources: [], resourceTemplates: [] });
    service.listServerTools.mockResolvedValue({ tools: [] });
  });

  it('discovers only authorized servers and strictly valid UI resources', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'enabled-apps', disabled: false, enableMcpApps: true },
      { name: 'disabled-apps', disabled: true, enableMcpApps: true },
      { name: 'not-opted-in', disabled: false, enableMcpApps: false },
      { name: 'flujo', disabled: false, builtIn: true },
    ] as any);
    service.listServerResources.mockImplementation(async (serverName: string) => ({
      resources: serverName === 'enabled-apps'
        ? [
            { uri: 'ui://valid', name: 'Valid App', mimeType: APP_MIME },
            { uri: 'https://invalid', name: 'Bad URI', mimeType: APP_MIME },
            { uri: 'ui://bad-mime', name: 'Bad MIME', mimeType: 'text/html' },
          ]
        : [{ uri: 'ui://built-in', name: 'Built-in App', mimeType: APP_MIME }],
      resourceTemplates: [],
    }));

    renderDashboard();

    expect(await screen.findByText('Valid App')).toBeInTheDocument();
    expect(screen.getByText('Built-in App')).toBeInTheDocument();
    expect(screen.queryByText('Bad URI')).not.toBeInTheDocument();
    expect(screen.queryByText('Bad MIME')).not.toBeInTheDocument();
    expect(service.listServerResources).toHaveBeenCalledTimes(2);
    expect(service.listServerResources).toHaveBeenCalledWith('enabled-apps');
    expect(service.listServerResources).toHaveBeenCalledWith('flujo');

    fireEvent.click(screen.getByText('Valid App'));
    const frame = await screen.findByTestId('mcp-app-frame');
    expect(frame).toHaveAttribute('data-server', 'enabled-apps');
    expect(frame).toHaveAttribute('data-uri', 'ui://valid');
  });

  it('keeps per-server discovery errors while showing empty states for other servers', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'offline', disabled: false, enableMcpApps: true },
      { name: 'empty', disabled: false, enableMcpApps: true },
    ] as any);
    service.listServerResources.mockImplementation(async (serverName: string) => (
      serverName === 'offline'
        ? { resources: [], resourceTemplates: [], error: 'Connection unavailable' }
        : { resources: [], resourceTemplates: [] }
    ));

    renderDashboard();

    expect(await screen.findByText('Unavailable or disconnected')).toBeInTheDocument();
    expect(screen.getByText('Connection unavailable')).toBeInTheDocument();
    expect(screen.getByText('No eligible apps discovered for this server.')).toBeInTheDocument();
  });

  it('routes tool-linked apps to the existing Tool Tester contract', async () => {
    const onOpenToolTester = jest.fn();
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true },
    ] as any);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }],
      resourceTemplates: [],
    });
    service.listServerTools.mockResolvedValue({
      tools: [{ name: 'get_forecast', _meta: { ui: { resourceUri: 'ui://forecast' } } }],
    });

    renderDashboard(onOpenToolTester);
    fireEvent.click(await screen.findByText('Forecast'));
    fireEvent.click(await screen.findByRole('button', { name: 'Test get_forecast' }));

    expect(onOpenToolTester).toHaveBeenCalledWith('weather', 'get_forecast');
  });

  it('invalidates an active preview when server app access is revoked', async () => {
    service.loadServerConfigs
      .mockResolvedValueOnce([
        { name: 'weather', disabled: false, enableMcpApps: true },
      ] as any)
      .mockResolvedValueOnce([
        { name: 'weather', disabled: false, enableMcpApps: false },
      ] as any);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }],
      resourceTemplates: [],
    });

    renderDashboard();
    fireEvent.click(await screen.findByText('Forecast'));
    expect(await screen.findByTestId('mcp-app-frame')).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('flujo:mcp-server-config-changed', {
        detail: { serverName: 'weather', config: { enableMcpApps: false } },
      }));
    });

    await waitFor(() => expect(screen.queryByTestId('mcp-app-frame')).not.toBeInTheDocument());
    expect(await screen.findByText('No MCP Apps-capable servers are enabled')).toBeInTheDocument();
    expect(service.clearCapabilitiesCache).toHaveBeenCalledWith('weather');
  });
});
