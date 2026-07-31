import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FlowBuilder } from '@/frontend/components/Flow/FlowManager/FlowBuilder';

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  applyNodeChanges: jest.fn((changes: unknown, nodes: unknown) => nodes),
  applyEdgeChanges: jest.fn((changes: unknown, edges: unknown) => edges),
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas', () => ({
  Canvas: () => <div data-testid="canvas" />,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/NodePalette', () => ({
  NodePalette: () => <div />,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/FlowValidationButton', () => ({
  FlowValidationButton: () => <button type="button">Check Flow</button>,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/MCPNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/StartNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/FinishNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/EdgePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ResourceNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SignalNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/TriggerNodePropertiesModal', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/FlowVersionHistoryDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) => open ? <div data-testid="history-dialog" /> : null,
}));
jest.mock('@/frontend/components/Flow/FlowManager/ImproveFlowDialog', () => ({
  __esModule: true,
  default: ({ open, initialDescription }: { open: boolean; initialDescription: string }) => (
    open ? <div data-testid="improve-dialog">{initialDescription}</div> : null
  ),
}));
jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    createStartNode: jest.fn(() => ({
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      data: { label: 'Start', type: 'start' },
    })),
  },
}));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/utils/shared/flowAutoRepair', () => ({
  autoRepairFlow: jest.fn((flow) => ({ flow, changes: [] })),
}));

const initialFlow: any = {
  id: 'flow-1',
  name: 'toolbar_flow',
  description: 'Toolbar regression fixture',
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      data: { label: 'Start', type: 'start' },
    },
  ],
  edges: [],
};

describe('FlowBuilder toolbar', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps primary authoring controls visible and moves flow tools into a menu', () => {
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    expect(screen.getByLabelText('Flow Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Guided' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Flow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Flow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Flow tools' }));
    expect(screen.getByRole('menuitem', { name: 'Auto-Align' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Repair automatically (no model)' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Repair with AI/i })).toBeEnabled();
  });

  it('retains both automatic and AI repair paths', () => {
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Flow tools' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repair automatically (no model)' }));
    expect(screen.getByText(/Nothing to repair/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Flow tools' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Repair with AI/i }));
    expect(screen.getByTestId('improve-dialog')).toHaveTextContent(/Repair this flow's wiring/i);
  });

  it('gates saved-flow actions behind the More actions menu', () => {
    const onDelete = jest.fn();
    const { rerender } = render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={() => {}}
        onDelete={onDelete}
        allFlows={[initialFlow]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'AI-Improve' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Copy Flow' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete Flow' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: 'History' }));
    expect(screen.getByTestId('history-dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Flow' }));
    expect(onDelete).toHaveBeenCalledWith('flow-1');

    rerender(
      <FlowBuilder
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('preserves disabled states for invalid and empty flows', () => {
    render(<FlowBuilder onSave={() => {}} onDelete={() => {}} allFlows={[]} />);

    fireEvent.change(screen.getByLabelText('Flow Name'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save Flow' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Flow tools' }));
    expect(screen.getByRole('menuitem', { name: 'Auto-Align' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Repair automatically (no model)' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: /Repair with AI/i })).toBeDisabled();
  });
});
