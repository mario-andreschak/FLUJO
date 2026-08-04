import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import DevCanvasDock, { type CanvasDockLayout } from '@/frontend/components/Chat/DevCanvasDock';
import {
  constrainFloatingRect,
  resizeFloatingRect,
} from '@/frontend/components/Chat/floatingPanel';

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: MouseEvent });
});
afterAll(() => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: originalPointerEvent });
});

jest.mock('@/frontend/components/Chat/McpAppFrame', () => {
  const MockMcpAppFrame = ({ onAvailableDisplayModes }: {
    onAvailableDisplayModes?: (modes: Array<'inline' | 'fullscreen' | 'pip'>) => void;
  }) => {
    useEffect(() => {
      onAvailableDisplayModes?.(['pip', 'fullscreen']);
    }, [onAvailableDisplayModes]);
    return <div data-testid="mcp-app-frame" />;
  };
  return { __esModule: true, default: MockMcpAppFrame };
});

const entry = {
  key: 'weather::ui://forecast',
  serverName: 'weather',
  uri: 'ui://forecast',
  unread: false,
  lastActiveAt: 1,
  updatedAt: 1,
};

describe('floating MCP App resizing', () => {
  it('shrinks from every moving edge while preserving the opposite edge', () => {
    const start = { x: 100, y: 80, width: 800, height: 600 };

    expect(resizeFloatingRect(
      start,
      'bottom-right',
      -260,
      -180,
      { width: 1200, height: 900 },
      { width: 480, height: 320 },
    )).toEqual({ x: 100, y: 80, width: 540, height: 420 });

    expect(resizeFloatingRect(
      start,
      'top-left',
      260,
      180,
      { width: 1200, height: 900 },
      { width: 480, height: 320 },
    )).toEqual({ x: 360, y: 260, width: 540, height: 420 });
  });

  it('clamps aggressive shrinking and viewport changes', () => {
    expect(resizeFloatingRect(
      { x: 100, y: 80, width: 800, height: 600 },
      'bottom-right',
      -2_000,
      -2_000,
      { width: 1200, height: 900 },
      { width: 480, height: 320 },
    )).toEqual({ x: 100, y: 80, width: 480, height: 320 });

    expect(constrainFloatingRect(
      { x: 700, y: 500, width: 800, height: 600 },
      { width: 900, height: 700 },
      { width: 480, height: 320 },
    )).toEqual({ x: 100, y: 100, width: 800, height: 600 });
  });
});

describe('MCP App canvas docking', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('flujo-mcp-canvas-placement', 'left');
    window.localStorage.setItem('flujo-mcp-canvas-width', '520');
  });

  it('reserves side space, releases it while collapsed, and restores the side on expand', async () => {
    const layouts: CanvasDockLayout[] = [];
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-1"
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onLayoutChange={(layout) => layouts.push(layout)}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(layouts.at(-1)).toEqual({ placement: 'left', reservedWidth: 520 }));
    const dock = screen.getByTestId('dev-canvas-dock');
    expect(dock).toHaveStyle({ position: 'absolute', left: '0px' });

    jest.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 520,
      bottom: 600,
      width: 520,
      height: 600,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(screen.getByRole('separator', { name: 'Resize app canvas' }), {
      pointerId: 1,
      clientX: 520,
      clientY: 300,
    });
    expect(screen.getByTestId('pointer-drag-shield')).toBeInTheDocument();
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 300 });
    await waitFor(() => expect(layouts.at(-1)).toEqual({ placement: 'left', reservedWidth: 320 }));
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.queryByTestId('pointer-drag-shield')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle canvas panel' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({ placement: 'left', reservedWidth: 0 }));
    expect(screen.getByTestId('dev-canvas-dock')).toHaveStyle({ position: 'relative' });
    expect(screen.queryByRole('button', { name: 'Dock canvas right' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Toggle canvas panel' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({ placement: 'left', reservedWidth: 320 }));
  });

  it('does not offer collapse while the canvas is fullscreen', async () => {
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-1"
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
        />
      </ThemeProvider>,
    );

    const fullscreen = await screen.findByRole('button', { name: 'Toggle canvas full screen' });
    await waitFor(() => expect(fullscreen).toBeEnabled());
    fireEvent.click(fullscreen);
    expect(screen.queryByRole('button', { name: 'Toggle canvas panel' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('separator', { name: /Resize app canvas \(/ })).toHaveLength(8);
  });
});
