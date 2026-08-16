import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import DevCanvasDock, { type CanvasDockLayout } from '@/frontend/components/Chat/DevCanvasDock';
import {
  clampFloatingPosition,
  constrainFloatingRect,
  fixedOriginOffset,
  resizeFloatingRect,
} from '@/frontend/components/Chat/floatingPanel';
import { stubMatchMedia } from '../../helpers/scrollStub';

const originalPointerEvent = window.PointerEvent;
beforeAll(() => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: MouseEvent });
});
afterAll(() => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: originalPointerEvent });
});

jest.mock('@/frontend/components/Chat/McpAppFrame', () => {
  const MockMcpAppFrame = ({ onAvailableDisplayModes, ownerScopeId }: {
    onAvailableDisplayModes?: (modes: Array<'inline' | 'fullscreen' | 'pip'>) => void;
    ownerScopeId?: string;
  }) => {
    useEffect(() => {
      onAvailableDisplayModes?.(['pip', 'fullscreen']);
    }, [onAvailableDisplayModes]);
    return <div data-testid="mcp-app-frame" data-owner-scope-id={ownerScopeId} />;
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

  // #371: a dragged panel must never park its resize handles off screen.
  it('keeps a dragged panel fully inside the viewport', () => {
    expect(clampFloatingPosition(
      { x: 1100, y: 850 },
      { width: 800, height: 600 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 400, y: 300 });

    expect(clampFloatingPosition(
      { x: -240, y: -180 },
      { width: 800, height: 600 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 0, y: 0 });

    // Larger than the viewport still anchors at the origin.
    expect(clampFloatingPosition(
      { x: 90, y: 70 },
      { width: 1600, height: 1200 },
      { width: 1200, height: 900 },
    )).toEqual({ x: 0, y: 0 });
  });
});

// #371: `backdrop-filter` on MUI's glass Dialog paper makes it the containing
// block for `position: fixed`, so viewport pointer coordinates must be rebased
// before they are written back as left/top.
describe('floating panel containing-block compensation', () => {
  const fakeFixedElement = (
    applied: { left: number; top: number },
    rendered: { left: number; top: number },
    position = 'fixed',
  ) => ({
    getBoundingClientRect: () => ({ left: rendered.left, top: rendered.top }),
    __style: { position, left: `${applied.left}px`, top: `${applied.top}px` },
  }) as unknown as HTMLElement;

  const originalGetComputedStyle = window.getComputedStyle;
  beforeEach(() => {
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      writable: true,
      value: (element: HTMLElement & { __style?: CSSStyleDeclaration }) =>
        element.__style ?? originalGetComputedStyle(element),
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      writable: true,
      value: originalGetComputedStyle,
    });
  });

  it('reports the offset of a shifted containing block', () => {
    // Panel asked for left/top 100/80 but paints at 340/260 => origin 240/180.
    expect(fixedOriginOffset(
      fakeFixedElement({ left: 100, top: 80 }, { left: 340, top: 260 }),
    )).toEqual({ x: 240, y: 180 });
  });

  it('stays neutral for a true viewport anchor, sub-pixel noise and non-fixed boxes', () => {
    expect(fixedOriginOffset(
      fakeFixedElement({ left: 100, top: 80 }, { left: 100, top: 80 }),
    )).toEqual({ x: 0, y: 0 });

    expect(fixedOriginOffset(
      fakeFixedElement({ left: 100, top: 80 }, { left: 100.4, top: 80.3 }),
    )).toEqual({ x: 0, y: 0 });

    expect(fixedOriginOffset(
      fakeFixedElement({ left: 100, top: 80 }, { left: 340, top: 260 }, 'absolute'),
    )).toEqual({ x: 0, y: 0 });

    expect(fixedOriginOffset(null)).toEqual({ x: 0, y: 0 });
  });
});

describe('MCP App canvas docking', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('flujo-mcp-canvas-placement', 'left');
    window.localStorage.setItem('flujo-mcp-canvas-width', '520');
  });

  it('exposes dock entries as keyboard-selectable tabs', () => {
    const onSelectTab = jest.fn();
    const secondEntry = {
      ...entry,
      key: 'files::ui://browser',
      serverName: 'files',
      uri: 'ui://browser',
    };
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-tabs"
          entries={[entry, secondEntry]}
          activeKey={entry.key}
          onSelectTab={onSelectTab}
          onCloseTab={() => undefined}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('tablist', { name: 'Canvas' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveFocus();
    expect(onSelectTab).toHaveBeenCalledWith(secondEntry.key);
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

    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'left',
      reservedWidth: 520,
      reservedHeight: 0,
    }));
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
    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'left',
      reservedWidth: 320,
      reservedHeight: 0,
    }));
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(screen.queryByTestId('pointer-drag-shield')).not.toBeInTheDocument();

    // #375: collapse and expand are no longer one toggle. The arrow for the
    // ALREADY-active edge ('left' here) collapses the dock; while collapsed the
    // dock renders as a rail whose only control is 'Expand canvas'.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse canvas to this edge' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'left',
      reservedWidth: 0,
      reservedHeight: 0,
    }));
    // A collapsed side dock stays absolutely positioned (so it overlays rather
    // than reserving space — reservedWidth is 0 above) but shrinks to the 40px
    // edge rail.
    expect(screen.getByTestId('dev-canvas-dock')).toHaveStyle({ position: 'absolute', width: '40px' });
    expect(screen.queryByRole('button', { name: 'Dock canvas right' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Expand canvas' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'left',
      reservedWidth: 320,
      reservedHeight: 0,
    }));
  });

  it('docks at the top, reserves height, and resizes from its bottom edge', async () => {
    const layouts: CanvasDockLayout[] = [];
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-top"
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onLayoutChange={(layout) => layouts.push(layout)}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dock canvas at top' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'top',
      reservedWidth: 0,
      reservedHeight: 440,
    }));

    const dock = screen.getByTestId('dev-canvas-dock');
    expect(dock).toHaveStyle({ position: 'absolute', top: '0px', height: '440px' });
    const separator = screen.getByRole('separator', { name: 'Resize app canvas' });
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(separator).toHaveStyle({ bottom: '0px', cursor: 'row-resize' });

    jest.spyOn(dock, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 440,
      width: 800,
      height: 440,
      toJSON: () => ({}),
    });
    jest.spyOn(dock.parentElement!, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(separator, { pointerId: 2, clientX: 400, clientY: 440 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 400, clientY: 500 });
    await waitFor(() => expect(layouts.at(-1)?.reservedHeight).toBe(500));
    fireEvent.pointerUp(window, { pointerId: 2 });
  });

  it('supports a standalone viewport dock below navigation with scoped persistence', async () => {
    window.localStorage.setItem('flujo-mcp-canvas-placement:shell-surface', 'top');
    window.localStorage.setItem('flujo-mcp-canvas-height:shell-surface', '360');
    const layouts: CanvasDockLayout[] = [];
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          persistenceId="shell-surface"
          appOwnerScopePrefix="app-shell"
          viewportDocked
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onLayoutChange={(layout) => layouts.push(layout)}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'top',
      reservedWidth: 0,
      reservedHeight: 360,
    }));
    const stableDock = screen.getByTestId('dev-canvas-dock');
    const stableFrame = screen.getByTestId('mcp-app-frame');
    expect(stableDock).toHaveStyle({
      position: 'fixed',
      top: 'calc(var(--app-bar-height) + var(--active-subnav-height))',
      height: 'min(360px, calc(100dvh - var(--app-bar-height) - var(--active-subnav-height)))',
    });
    expect(window.localStorage.getItem('flujo-mcp-canvas-placement')).toBe('left');
    expect(window.localStorage.getItem('flujo-mcp-canvas-placement:shell-surface')).toBe('top');
    expect(stableFrame).toHaveAttribute(
      'data-owner-scope-id',
      `app-shell:${entry.key}`,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dock canvas at bottom' }));
    await waitFor(() => expect(layouts.at(-1)).toEqual({
      placement: 'bottom',
      reservedWidth: 0,
      reservedHeight: 360,
    }));
    expect(screen.getByTestId('dev-canvas-dock')).toBe(stableDock);
    expect(screen.getByTestId('mcp-app-frame')).toBe(stableFrame);
    expect(stableDock).toHaveStyle({ position: 'fixed', bottom: '0px' });
  });

  it('reserves bottom-sheet height for a compact viewport dock', async () => {
    const restoreMatchMedia = stubMatchMedia(() => true);
    window.localStorage.setItem('flujo-mcp-canvas-placement:compact-shell', 'left');
    window.localStorage.setItem('flujo-mcp-canvas-height:compact-shell', '300');
    const layouts: CanvasDockLayout[] = [];
    try {
      const view = render(
        <ThemeProvider theme={createTheme()}>
          <DevCanvasDock
            persistenceId="compact-shell"
            viewportDocked
            entries={[entry]}
            activeKey={entry.key}
            onSelectTab={() => undefined}
            onCloseTab={() => undefined}
            onLayoutChange={(layout) => layouts.push(layout)}
          />
        </ThemeProvider>,
      );

      await waitFor(() => expect(layouts.at(-1)).toEqual({
        placement: 'bottom',
        reservedWidth: 0,
        reservedHeight: 300,
      }));
      expect(screen.getByTestId('dev-canvas-dock')).toHaveStyle({
        position: 'fixed',
        bottom: '0px',
      });
      view.unmount();
    } finally {
      restoreMatchMedia();
    }
  });

  it('restores a conversation canvas in its persisted collapsed state', async () => {
    const firstLayouts: CanvasDockLayout[] = [];
    const first = render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-persisted"
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onLayoutChange={(layout) => firstLayouts.push(layout)}
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Collapse canvas to this edge' }));
    await waitFor(() => expect(firstLayouts.at(-1)?.reservedWidth).toBe(0));
    first.unmount();

    const restoredLayouts: CanvasDockLayout[] = [];
    render(
      <ThemeProvider theme={createTheme()}>
        <DevCanvasDock
          conversationId="conversation-persisted"
          entries={[entry]}
          activeKey={entry.key}
          onSelectTab={() => undefined}
          onCloseTab={() => undefined}
          onLayoutChange={(layout) => restoredLayouts.push(layout)}
        />
      </ThemeProvider>,
    );

    await waitFor(() => expect(restoredLayouts.at(-1)?.reservedWidth).toBe(0));
    expect(screen.queryByRole('separator', { name: 'Resize app canvas' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Collapse canvas to this edge' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('separator', { name: /Resize app canvas \(/ })).toHaveLength(8);
  });
});
