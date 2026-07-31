import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import {
  MCPNode,
  ProcessNode,
  SignalNode,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes';

jest.mock('@xyflow/react', () => ({
  Handle: ({ id, type, position }: { id: string; type: string; position: string }) => (
    <div data-testid={`handle-${id}`} data-type={type} data-position={position} />
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
) => render(
  <ThemeProvider theme={createTheme()}>
    <div onClick={parentHandlers.onClick} onPointerDown={parentHandlers.onPointerDown}>
      <Component
        id="node-1"
        data={data}
        type="process"
        selected={false}
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
    expect(screen.getByText(/Summarizes the incoming request/)).toBeInTheDocument();
    expect(screen.getByText(/last-message → text/)).toBeInTheDocument();
    expect(screen.getByText(/Summarize clearly/)).toBeInTheDocument();
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
    expect(screen.getByText('search, fetch, store +1 more (4)')).toBeInTheDocument();
  });

  it('retains the signal topic as the node label', () => {
    renderNode(SignalNode as typeof ProcessNode, {
      label: 'Signal',
      type: 'signal',
      properties: { topic: 'review-complete' },
    });

    expect(screen.getByText('review-complete')).toBeInTheDocument();
  });

  it('expands bounded technical details without propagating pointer or click events to the node canvas', () => {
    const onClick = jest.fn();
    const onPointerDown = jest.fn();
    renderNode(ProcessNode, {
      label: 'Safe node',
      type: 'process',
      properties: {
        promptTemplate: 'Hello',
        unsupportedSecret: 'do not render',
      },
    }, { onClick, onPointerDown });

    const disclosure = screen.getByRole('button', { name: /Technical details/i });
    fireEvent.pointerDown(disclosure);
    fireEvent.click(disclosure);

    expect(onPointerDown).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByText(/Node metadata/)).toBeVisible();
    expect(screen.getByText(/Prompt template: Hello/)).toBeVisible();
    expect(screen.queryByText(/do not render/)).not.toBeInTheDocument();
    expect(disclosure.closest('.nodrag')).not.toBeNull();
  });
});
