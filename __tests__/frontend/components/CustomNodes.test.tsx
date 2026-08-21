import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import {
  MCPNode,
  ProcessNode,
  SignalNode,
  FLOW_QUICK_CONNECT_EVENT,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';

jest.mock('@xyflow/react', () => ({
  Handle: ({ id, type, position }: { id: string; type: string; position: string }) => (
    <div data-testid={`handle-${id}`} data-type={type} data-position={position} />
  ),
  NodeToolbar: ({ children, isVisible }: { children: React.ReactNode; isVisible?: boolean }) => (
    isVisible ? <div>{children}</div> : null
  ),
  Position: {
    Top: 'top',
    Right: 'right',
    Bottom: 'bottom',
    Left: 'left',
  },
}));

const renderNode = (
  Component: typeof ProcessNode,
  data: Record<string, unknown>,
  parentHandlers: { onClick?: jest.Mock; onPointerDown?: jest.Mock } = {},
  selected = false,
) => render(
  <ThemeProvider theme={createTheme()}>
    <div onClick={parentHandlers.onClick} onPointerDown={parentHandlers.onPointerDown}>
      <Component
        id="node-1"
        data={data}
        type="process"
        selected={selected}
        dragging={false}
        draggable
        selectable
        deletable
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
      />
    </div>
  </ThemeProvider>,
);

describe('FlowBuilder CustomNodes', () => {
  it('renders useful process information instead of a generic property count', () => {
    renderNode(ProcessNode, {
      label: 'Summarizer',
      type: 'process',
      description: 'Summarizes the incoming request',
      properties: {
        inputMode: 'last-message',
        outputMode: 'text',
        promptTemplate: 'Summarize clearly.\nReturn only the answer.',
      },
    });

    expect(screen.getByText('Summarizer')).toBeInTheDocument();
    const summary = within(screen.getByLabelText('Node summary'));
    expect(summary.getByText(/Summarizes the incoming request/)).toBeInTheDocument();
    expect(summary.getByText(/last-message → text/)).toBeInTheDocument();
    expect(summary.getByText(/Summarize clearly/)).toBeInTheDocument();
    expect(screen.queryByText(/properties configured/i)).not.toBeInTheDocument();
  });

  it('shows MCP binding and a capped enabled-tool summary', () => {
    renderNode(MCPNode as typeof ProcessNode, {
      label: 'Docs',
      type: 'mcp',
      properties: {
        boundServer: 'documentation',
        enabledTools: ['search', 'fetch', 'store', 'remove'],
      },
    });

    expect(screen.getByText('documentation')).toBeInTheDocument();
    expect(screen.getByText('search, fetch, and store +1 more (4)')).toBeInTheDocument();
  });

  it('retains the signal topic as the node label', () => {
    renderNode(SignalNode as typeof ProcessNode, {
      label: 'Signal',
      type: 'signal',
      properties: { topic: 'review-complete' },
    });

    expect(screen.getByText('review-complete')).toBeInTheDocument();
  });

  // Issue #412: technical details moved out of the canvas node into the
  // Inspector's last action, which opens a read-only modal.
  it('no longer renders inline technical details while keeping the node summary', () => {
    renderNode(ProcessNode, {
      label: 'Safe node',
      type: 'process',
      properties: {
        promptTemplate: 'Hello',
        unsupportedSecret: 'do not render',
      },
    });

    expect(screen.queryByRole('button', { name: /Technical details/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Node metadata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/promptTemplate: Hello/)).not.toBeInTheDocument();
    expect(screen.queryByText(/do not render/)).not.toBeInTheDocument();

    const summary = within(screen.getByLabelText('Node summary'));
    expect(summary.getByText(/Hello/)).toBeInTheDocument();
  });

  it('reveals quick-connect controls on hover and emits the requested handle', () => {
    jest.useFakeTimers();
    const listener = jest.fn();
    document.addEventListener(FLOW_QUICK_CONNECT_EVENT, listener);
    renderNode(ProcessNode, {
      label: 'Summarizer',
      type: 'process',
      properties: {},
    });

    fireEvent.mouseEnter(screen.getByText('Summarizer').closest('.MuiPaper-root')!);
    act(() => { jest.advanceTimersByTime(450); });

    fireEvent.click(screen.getByRole('button', { name: /bottom of Summarizer/i }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(expect.objectContaining({
      nodeId: 'node-1',
      handleId: 'process-bottom',
      side: 'bottom',
    }));
    document.removeEventListener(FLOW_QUICK_CONNECT_EVENT, listener);
    jest.useRealTimers();
  });

  it('pins quick-connect controls open when a node is selected', () => {
    renderNode(ProcessNode, {
      label: 'Summarizer',
      type: 'process',
      properties: {},
    }, {}, true);

    expect(screen.getByRole('button', { name: /bottom of Summarizer/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /left of Summarizer/i })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /right of Summarizer/i })).toHaveLength(2);
  });

  it('does not offer add-and-connect controls from MCP nodes', () => {
    jest.useFakeTimers();
    renderNode(MCPNode as typeof ProcessNode, {
      label: 'Docs',
      type: 'mcp',
      properties: { boundServer: 'documentation' },
    });

    fireEvent.mouseEnter(screen.getByText('Docs').closest('.MuiPaper-root')!);
    act(() => { jest.advanceTimersByTime(450); });

    expect(screen.queryByRole('button', { name: /of Docs/i })).not.toBeInTheDocument();
    jest.useRealTimers();
  });
});
