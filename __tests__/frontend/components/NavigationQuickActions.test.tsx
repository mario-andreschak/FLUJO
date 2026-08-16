import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import QuickActionsMenu from '@/frontend/components/Navigation/QuickActionsMenu';
import { mcpService } from '@/frontend/services/mcp';
import {
  subscribeLaunchGlobalMcpApp,
  subscribeNewChatRequests,
} from '@/frontend/utils/quickActions';

jest.mock('@/frontend/services/mcp', () => ({
  mcpService: {
    loadServerConfigs: jest.fn(),
    listServerResources: jest.fn(),
    listServerTools: jest.fn(),
    clearCapabilitiesCache: jest.fn(),
    clearToolsCache: jest.fn(),
    callTool: jest.fn(),
  },
}));

const service = mcpService as unknown as {
  loadServerConfigs: jest.Mock;
  listServerResources: jest.Mock;
  listServerTools: jest.Mock;
  clearCapabilitiesCache: jest.Mock;
  clearToolsCache: jest.Mock;
  callTool: jest.Mock;
};

const APP_MIME = 'text/html;profile=mcp-app';

const renderMenu = (pathname = '/models') => {
  const onNavigate = jest.fn();
  const onAction = jest.fn();
  render(
    <ThemeProvider theme={createTheme()}>
      <QuickActionsMenu pathname={pathname} onNavigate={onNavigate} onAction={onAction} />
    </ThemeProvider>,
  );
  return { onNavigate, onAction };
};

const openQuickActions = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }));

const openMcpBranch = async () => {
  openQuickActions();
  fireEvent.click(screen.getByTestId('quick-action-mcp-app'));
};

describe('Navigation quick actions (#396)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.loadServerConfigs.mockResolvedValue([]);
    service.listServerResources.mockResolvedValue({ resources: [], resourceTemplates: [] });
    service.listServerTools.mockResolvedValue({ tools: [] });
  });

  it('exposes an accessible trigger with New Chat and MCP App', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Quick actions' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('quick-action-new-chat')).toBeInTheDocument();
    expect(screen.getByTestId('quick-action-mcp-app')).toBeInTheDocument();
    // Opening the menu must not touch MCP at all.
    expect(service.loadServerConfigs).not.toHaveBeenCalled();
  });

  it('routes New Chat through a one-shot /chat intent from another page', () => {
    const { onNavigate } = renderMenu('/models');
    openQuickActions();
    fireEvent.click(screen.getByTestId('quick-action-new-chat'));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0][0]).toMatch(/^\/chat\?new=qa-/);
  });

  it('requests New Chat in place when the chat page is already open', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeNewChatRequests((token) => seen.push(token));
    const { onNavigate } = renderMenu('/chat');

    openQuickActions();
    fireEvent.click(screen.getByTestId('quick-action-new-chat'));
    unsubscribe();

    expect(onNavigate).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^qa-/);
  });

  it('lists only favorited, app-enabled servers that actually publish apps', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true, favorite: true },
      { name: 'not-favorite', disabled: false, enableMcpApps: true, favorite: false },
      { name: 'disabled-favorite', disabled: true, enableMcpApps: true, favorite: true },
      { name: 'not-opted-in', disabled: false, enableMcpApps: false, favorite: true },
      { name: 'favorite-without-apps', disabled: false, enableMcpApps: true, favorite: true },
    ] as never);
    service.listServerResources.mockImplementation(async (serverName: string) => (
      serverName === 'weather'
        ? { resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }], resourceTemplates: [] }
        : { resources: [], resourceTemplates: [] }
    ));

    renderMenu();
    await openMcpBranch();

    expect(await screen.findByText('weather')).toBeInTheDocument();
    expect(screen.queryByText('not-favorite')).not.toBeInTheDocument();
    expect(screen.queryByText('disabled-favorite')).not.toBeInTheDocument();
    expect(screen.queryByText('not-opted-in')).not.toBeInTheDocument();
    // Configuration intent is not enough: nothing discovered, nothing listed.
    expect(screen.queryByText('favorite-without-apps')).not.toBeInTheDocument();
    expect(service.listServerResources).not.toHaveBeenCalledWith('not-favorite');
  });

  it('starts apps directly and keeps linked tools inside the app submenu', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true, favorite: true },
    ] as never);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }],
      resourceTemplates: [],
    });
    service.listServerTools.mockResolvedValue({
      tools: [{ name: 'get_forecast', _meta: { ui: { resourceUri: 'ui://forecast' } } }],
    });

    const requests: string[] = [];
    const unsubscribe = subscribeLaunchGlobalMcpApp((request) => {
      requests.push(`${request.serverName}|${request.uri}|${request.toolName ?? ''}`);
    });
    const { onNavigate } = renderMenu('/flows');
    await openMcpBranch();

    // Linked tools no longer flood the app list; the trailing > owns them.
    expect(screen.queryByRole('menuitem', { name: 'Start app for get_forecast' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Forecast' }));
    expect(requests).toEqual(['weather|ui://forecast|']);
    expect(onNavigate).not.toHaveBeenCalled();

    await openMcpBranch();
    fireEvent.click(await screen.findByTitle('Linked tools for Forecast'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start app for get_forecast' }));
    unsubscribe();

    expect(requests).toEqual([
      'weather|ui://forecast|',
      'weather|ui://forecast|get_forecast',
    ]);
    expect(onNavigate).not.toHaveBeenCalled();
    // Starting the app supplies context only; Quick Actions never invokes a tool.
    expect(service.callTool).not.toHaveBeenCalled();
  });

  it('uses the global app host even while the MCP page is already open', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true, favorite: true },
    ] as never);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }],
      resourceTemplates: [],
    });

    const requests: string[] = [];
    const unsubscribe = subscribeLaunchGlobalMcpApp((request) => requests.push(`${request.serverName}|${request.uri}`));
    const { onNavigate } = renderMenu('/mcp');
    await openMcpBranch();

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open Forecast' }));
    unsubscribe();

    expect(onNavigate).not.toHaveBeenCalled();
    expect(requests).toEqual(['weather|ui://forecast']);
  });

  it('opens and leaves the linked-tools submenu with arrow keys', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'weather', disabled: false, enableMcpApps: true, favorite: true },
    ] as never);
    service.listServerResources.mockResolvedValue({
      resources: [{ uri: 'ui://forecast', name: 'Forecast', mimeType: APP_MIME }],
      resourceTemplates: [],
    });
    service.listServerTools.mockResolvedValue({
      tools: [{ name: 'get_forecast', _meta: { ui: { resourceUri: 'ui://forecast' } } }],
    });

    renderMenu('/flows');
    await openMcpBranch();
    const backItem = screen.getByRole('menuitem', { name: 'Back to quick actions' });
    const appItem = await screen.findByRole('menuitem', { name: 'Open Forecast' });
    await waitFor(() => expect(backItem).toHaveFocus());
    fireEvent.keyDown(backItem, { key: 'ArrowDown' });
    await waitFor(() => expect(appItem).toHaveFocus());
    fireEvent.keyDown(appItem, { key: 'ArrowRight' });

    const toolItem = await screen.findByRole('menuitem', { name: 'Start app for get_forecast' });
    await waitFor(() => expect(toolItem).toHaveFocus());
    expect(appItem).toHaveAttribute('aria-controls', 'quick-actions-tools-menu-floating');
    fireEvent.keyDown(toolItem, { key: 'ArrowLeft' });
    await waitFor(() => expect(appItem).toHaveFocus());
    expect(screen.queryByRole('menuitem', { name: 'Start app for get_forecast' })).not.toBeInTheDocument();
  });

  it('shows an empty state and keeps a per-server failure scoped', async () => {
    service.loadServerConfigs.mockResolvedValue([
      { name: 'offline', disabled: false, enableMcpApps: true, favorite: true },
    ] as never);
    service.listServerResources.mockResolvedValue({
      resources: [],
      resourceTemplates: [],
      error: 'Connection unavailable',
    });

    renderMenu();
    await openMcpBranch();

    expect(await screen.findByText('offline is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Connection unavailable')).toBeInTheDocument();
    // New Chat stays reachable while MCP discovery is degraded.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Back to quick actions' }));
    expect(screen.getByTestId('quick-action-new-chat')).toBeInTheDocument();
  });

  it('reports when no favorited server publishes an app', async () => {
    renderMenu();
    await openMcpBranch();

    await waitFor(() => expect(screen.getByText('No favorite MCP Apps yet')).toBeInTheDocument());
  });
});
