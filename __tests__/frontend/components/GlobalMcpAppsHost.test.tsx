import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';

import GlobalMcpAppsHost from '@/frontend/components/mcp/GlobalMcpAppsHost';
import { emitLaunchGlobalMcpApp } from '@/frontend/utils/quickActions';

jest.mock('@/frontend/components/Chat/McpAppFrame', () => {
  const MockMcpAppFrame = (props: any) => (
    <div
      data-testid="global-inline-app"
      data-owner-scope={props.ownerScopeId}
      data-tool-name={props.toolName ?? ''}
    >
      {props.serverName}|{props.uri}
      <button type="button" onClick={props.onRequestDock}>request pip</button>
    </div>
  );
  return { __esModule: true, default: MockMcpAppFrame };
});

jest.mock('@/frontend/components/Chat/DevCanvasDock', () => {
  const MockDevCanvasDock = (props: any) => (
    <div
      data-testid="global-canvas-dock"
      data-owner-prefix={props.appOwnerScopePrefix}
      data-viewport-docked={String(props.viewportDocked)}
    >
      <span data-testid="global-dock-entries">
        {props.entries.map((entry: any) => `${entry.serverName}|${entry.uri}|${entry.toolName ?? ''}`).join(',')}
      </span>
      <span data-testid="global-dock-updated-at">
        {props.entries.map((entry: any) => entry.updatedAt).join(',')}
      </span>
      <span data-testid="global-dock-entry-count">{props.entries.length}</span>
      <button
        type="button"
        onClick={() => props.onLayoutChange({ placement: 'left', reservedWidth: 420, reservedHeight: 0 })}
      >
        reserve left
      </button>
      <button
        type="button"
        onClick={() => props.onLayoutChange({ placement: 'top', reservedWidth: 0, reservedHeight: 300 })}
      >
        reserve top
      </button>
    </div>
  );
  return { __esModule: true, default: MockDevCanvasDock };
});

const renderHost = () => render(
  <ThemeProvider theme={createTheme()}>
    <GlobalMcpAppsHost />
  </ThemeProvider>,
);

describe('global MCP Apps host', () => {
  beforeEach(() => {
    for (const side of ['left', 'right', 'top', 'bottom']) {
      document.documentElement.style.removeProperty(`--global-mcp-dock-${side}`);
    }
  });

  it('replays a launch requested before the async shell host subscribes', async () => {
    act(() => emitLaunchGlobalMcpApp({ serverName: 'weather', uri: 'ui://forecast' }));
    renderHost();

    expect(await screen.findByTestId('global-inline-app')).toHaveTextContent(
      'weather|ui://forecast',
    );
  });

  it('starts an app inline, then hands it to the persistent viewport dock', async () => {
    renderHost();

    act(() => emitLaunchGlobalMcpApp({
      serverName: 'bash',
      uri: 'ui://bash/terminal',
      toolName: 'open_terminal',
    }));

    const inline = await screen.findByTestId('global-inline-app');
    expect(inline).toHaveTextContent('bash|ui://bash/terminal');
    expect(inline).toHaveAttribute('data-tool-name', 'open_terminal');
    expect(inline).toHaveAttribute('data-owner-scope', 'app-shell:bash::ui://bash/terminal');

    fireEvent.click(screen.getByRole('button', { name: 'request pip' }));
    await waitFor(() => expect(screen.queryByTestId('global-inline-app')).not.toBeInTheDocument());
    expect(screen.getByTestId('global-dock-entries')).toHaveTextContent(
      'bash|ui://bash/terminal|open_terminal',
    );
    expect(screen.getByTestId('global-canvas-dock')).toHaveAttribute('data-owner-prefix', 'app-shell');
    expect(screen.getByTestId('global-canvas-dock')).toHaveAttribute('data-viewport-docked', 'true');
  });

  it('updates the linked-tool context without replacing the inline host', async () => {
    renderHost();
    act(() => emitLaunchGlobalMcpApp({
      serverName: 'weather',
      uri: 'ui://forecast',
      toolName: 'daily_forecast',
    }));

    const inline = await screen.findByTestId('global-inline-app');
    expect(inline).toHaveAttribute('data-tool-name', 'daily_forecast');

    act(() => emitLaunchGlobalMcpApp({
      serverName: 'weather',
      uri: 'ui://forecast',
      toolName: 'hourly_forecast',
    }));

    expect(screen.getByTestId('global-inline-app')).toBe(inline);
    expect(inline).toHaveAttribute('data-tool-name', 'hourly_forecast');
  });

  it('focuses an unchanged docked app without resetting its live View', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      renderHost();
      act(() => emitLaunchGlobalMcpApp({
        serverName: 'weather',
        uri: 'ui://forecast',
        toolName: 'daily_forecast',
      }));
      fireEvent.click(await screen.findByRole('button', { name: 'request pip' }));
      await waitFor(() => expect(screen.getByTestId('global-dock-updated-at')).toHaveTextContent('1000'));

      now.mockReturnValue(2_000);
      act(() => emitLaunchGlobalMcpApp({
        serverName: 'weather',
        uri: 'ui://forecast',
        toolName: 'daily_forecast',
      }));
      expect(screen.getByTestId('global-dock-updated-at')).toHaveTextContent('1000');

      now.mockReturnValue(3_000);
      act(() => emitLaunchGlobalMcpApp({
        serverName: 'weather',
        uri: 'ui://forecast',
        toolName: 'hourly_forecast',
      }));
      expect(screen.getByTestId('global-dock-updated-at')).toHaveTextContent('3000');
      expect(screen.getByTestId('global-dock-entries')).toHaveTextContent('hourly_forecast');
    } finally {
      now.mockRestore();
    }
  });

  it('bounds globally docked live Views with the shared LRU cap', async () => {
    renderHost();
    for (let index = 0; index < 17; index += 1) {
      act(() => emitLaunchGlobalMcpApp({
        serverName: 'server',
        uri: `ui://app/${index}`,
      }));
      fireEvent.click(await screen.findByRole('button', { name: 'request pip' }));
    }

    await waitFor(() => expect(screen.getByTestId('global-dock-entry-count')).toHaveTextContent('16'));
    expect(screen.getByTestId('global-dock-entries')).not.toHaveTextContent('ui://app/0|');
    expect(screen.getByTestId('global-dock-entries')).toHaveTextContent('ui://app/16|');
  });

  it('publishes four-edge layout reservations to the app shell and cleans them up', async () => {
    const view = renderHost();

    fireEvent.click(screen.getByRole('button', { name: 'reserve left' }));
    await waitFor(() => expect(
      document.documentElement.style.getPropertyValue('--global-mcp-dock-left'),
    ).toBe('420px'));
    expect(document.documentElement.style.getPropertyValue('--global-mcp-dock-top')).toBe('0px');

    fireEvent.click(screen.getByRole('button', { name: 'reserve top' }));
    await waitFor(() => expect(
      document.documentElement.style.getPropertyValue('--global-mcp-dock-top'),
    ).toBe('300px'));
    expect(document.documentElement.style.getPropertyValue('--global-mcp-dock-left')).toBe('0px');

    view.unmount();
    expect(document.documentElement.style.getPropertyValue('--global-mcp-dock-top')).toBe('');
  });
});
