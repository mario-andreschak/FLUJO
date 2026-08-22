import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import McpAppsDashboard from '@/frontend/components/mcp/McpAppsDashboard';
import { useMcpAppsDiscovery } from '@/frontend/components/mcp/useMcpAppsDiscovery';
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
      { name: 'flujo', disabled: false, enableMcpApps: false },
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
    expect(screen.queryByText('Built-in App')).not.toBeInTheDocument();
    expect(screen.queryByText('Bad URI')).not.toBeInTheDocument();
    expect(screen.queryByText('Bad MIME')).not.toBeInTheDocument();
    expect(service.listServerResources).toHaveBeenCalledTimes(1);
    expect(service.listServerResources).toHaveBeenCalledWith('enabled-apps');
    expect(service.listServerResources).not.toHaveBeenCalledWith('flujo');

    fireEvent.click(screen.getByText('Valid App'));
    const frame = await screen.findByTestId('mcp-app-frame');
    expect(frame).toHaveAttribute('data-server', 'enabled-apps');
    expect(frame).toHaveAttribute('data-uri', 'ui://valid');
  });

  it('can retain ordinary enabled MCP servers without probing them for App resources', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'enabled-apps', disabled: false, enableMcpApps: true },
      { name: 'tools-only', disabled: false, enableMcpApps: false },
      { name: 'disabled-tools', disabled: true, enableMcpApps: false },
    ] as any);

    const { result } = renderHook(() => useMcpAppsDiscovery({
      active: true,
      includeAllServers: true,
    }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.servers.map((server) => server.name))
      .toEqual(['enabled-apps', 'tools-only']);
    expect(service.listServerResources).toHaveBeenCalledTimes(1);
    expect(service.listServerResources).toHaveBeenCalledWith('enabled-apps');
  });

  it('refreshes discovery when the user returns to the window', async () => {
    service.loadServerConfigs
      .mockResolvedValueOnce([
        { name: 'first-app', disabled: false, enableMcpApps: true },
      ] as any)
      .mockResolvedValueOnce([
        { name: 'first-app', disabled: false, enableMcpApps: true },
        { name: 'new-app', disabled: false, enableMcpApps: true },
      ] as any);

    const { result } = renderHook(() => useMcpAppsDiscovery({ active: true }));
    await waitFor(() => expect(result.current.servers).toHaveLength(1));

    fireEvent.focus(window);

    await waitFor(() => expect(result.current.servers).toHaveLength(2));
    expect(service.loadServerConfigs).toHaveBeenCalledTimes(2);
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
      tools: [{ name: 'get_forecast', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://forecast' } } }],
    });

    renderDashboard(onOpenToolTester);
    fireEvent.click(await screen.findByText('Forecast'));
    fireEvent.click(await screen.findByRole('button', { name: 'Test get_forecast' }));

    expect(onOpenToolTester).toHaveBeenCalledWith('weather', 'get_forecast');
  });

  it('discovers tool-linked apps even when resources/list omits the UI resource', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'terminal-server', disabled: false, enableMcpApps: true },
    ] as any);
    service.listServerResources.mockResolvedValue({
      resources: [],
      resourceTemplates: [],
      error: 'resources/list is unavailable',
    });
    service.listServerTools.mockResolvedValue({
      tools: [{ name: 'open_terminal', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://bash/real-terminal' } } }],
    });

    renderDashboard();

    expect(await screen.findByText('Real Terminal')).toBeInTheDocument();
    expect(screen.getByText('Tool-discovered')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Real Terminal'));
    expect(await screen.findByTestId('mcp-app-frame')).toHaveAttribute('data-uri', 'ui://bash/real-terminal');
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

  it('previews the app a caller preselected instead of the first one (#396)', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true },
    ] as any);
    service.listServerResources.mockResolvedValue({
      resources: [
        { uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME },
        { uri: 'ui://radar', name: 'Radar', mimeType: APP_MIME },
      ],
      resourceTemplates: [],
    });

    render(
      <ThemeProvider theme={createTheme()}>
        <McpAppsDashboard
          open
          onClose={jest.fn()}
          onOpenToolTester={jest.fn()}
          initialSelection={{ serverName: 'weather', uri: 'ui://radar' }}
        />
      </ThemeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('mcp-app-frame')).toHaveAttribute('data-uri', 'ui://radar'));
  });

  it('uses fullScreen dialog and opts out of backdropFilter so fixed descendants are not clipped', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'enabled-apps', disabled: false, enableMcpApps: true },
    ] as any);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://valid', name: 'Valid App', mimeType: APP_MIME }],
      resourceTemplates: [],
    });

    renderDashboard();
    await waitFor(() => expect(screen.getByText('Valid App')).toBeInTheDocument());

    const paper = document.querySelector('.MuiDialog-paper') as HTMLElement;
    expect(paper).toBeInTheDocument();
    // MUI v6 fullScreen adds this class to the paper element
    expect(paper.className).toContain('MuiDialog-paperFullScreen');
    // The sx prop on slotProps.paper sets backdropFilter: 'none' so that a
    // position:fixed MCP App panel resolves against the real viewport (#371).
    // Emotion emits it as a generated class, so assert on the injected rules
    // that actually apply to this paper element.
    const paperClasses = paper.className.split(/\s+/).filter(Boolean);
    // Emotion may keep rules only in the CSSOM ("speedy" insertion), so read
    // both the style tag text and the live stylesheets.
    const emotionRules = [
      ...Array.from(document.querySelectorAll('style')).map((tag) => tag.textContent ?? ''),
      ...Array.from(document.styleSheets).flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules).map((rule) => rule.cssText);
        } catch {
          return [];
        }
      }),
    ].join('').replace(/\s+/g, '');
    const backdropRule = paperClasses.some((className) => (
      new RegExp(`\\.${className}\\{[^}]*backdrop-filter:none`).test(emotionRules)
    ));
    expect(backdropRule).toBe(true);
  });
});
