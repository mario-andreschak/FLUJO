import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { FlowBuilder } from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import { modelService } from '@/frontend/services/model';

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  applyNodeChanges: jest.fn((changes: unknown, nodes: unknown) => nodes),
  applyEdgeChanges: jest.fn((changes: unknown, edges: unknown) => edges),
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas', () => ({
  Canvas: ({ nodes, edges }: { nodes: any[]; edges: any[] }) => (
    <div data-testid="canvas">{nodes.length}:{edges.length}</div>
  ),
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/NodePalette', () => ({
  NodePalette: ({ onAddNode }: { onAddNode: (type: string) => void }) => (
    <>
      <button type="button" onClick={() => onAddNode('process')}>Palette Process</button>
      <button type="button" onClick={() => onAddNode('trigger')}>Palette Trigger</button>
    </>
  ),
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/FlowValidationButton', () => ({
  FlowValidationButton: () => <button type="button">Check Flow</button>,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal', () => {
  function MockProcessNodePropertiesModal({ open }: { open: boolean }) {
    return open ? <div data-testid="process-properties-modal" /> : null;
  }
  return MockProcessNodePropertiesModal;
});
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
    createNode: jest.fn((type: string, position: { x: number; y: number }) => ({
      id: `${type}-new`,
      type,
      position,
      data: { label: 'Process Node', type, properties: { inputMode: 'full-history' } },
    })),
  },
}));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/frontend/services/model', () => ({
  modelService: {
    loadModels: jest.fn(() => {
      const models = [
        { id: 'model-favorite', name: 'Friendly AI', favorite: true },
        { id: 'model-backup', name: 'Backup AI', favorite: false },
      ];
      return {
        then: (resolve: (value: typeof models) => unknown) => {
          resolve(models);
          return Promise.resolve(models);
        },
      };
    }),
  },
}));
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
    jest.clearAllMocks();
    window.localStorage.clear();
    window.localStorage.setItem('flujo-ui:flow-builder:mode', JSON.stringify('advanced'));
  });

  it('keeps the high-frequency authoring goals visible and flow details in the inspector', () => {
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
    expect(screen.getByRole('checkbox', { name: 'Advanced' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Flow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Flow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add node' })).toBeInTheDocument();
    expect(screen.getByLabelText('Save status: saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-Align' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Auto-Align' })).toHaveAttribute('aria-disabled', 'true');
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

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Repair automatically (no model)' }));
    expect(screen.getByText(/Nothing to repair/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
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
    expect(screen.getByRole('menuitem', { name: 'Duplicate Flow' })).toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument();
  });

  it('preserves disabled states for invalid and empty flows', () => {
    render(<FlowBuilder onSave={() => {}} onDelete={() => {}} allFlows={[]} />);

    fireEvent.change(screen.getByLabelText('Flow Name'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Save Flow' })).toBeDisabled();

    expect(screen.getByRole('button', { name: 'Auto-Align' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Auto-Align' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Repair automatically (no model)' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Repair with AI/i })).toBeEnabled();
  });

  it('renames directly and supports the Ctrl/Command-S save shortcut', async () => {
    const onSave = jest.fn().mockResolvedValue(true);
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={onSave}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Flow Name'), { target: { value: 'renamed_flow' } });
    expect(screen.getByLabelText('Save status: unsaved')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed_flow' })));
    await waitFor(() => expect(screen.getByLabelText('Save status: saved')).toBeInTheDocument());
    expect(screen.queryByText('Rename Flow')).not.toBeInTheDocument();
  });

  it('keeps changes dirty when async persistence fails', async () => {
    const onSave = jest.fn().mockResolvedValue(false);
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={onSave}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Still working' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Flow' }));

    await waitFor(() => expect(screen.getByLabelText('Save status: failed')).toBeInTheDocument());
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid save shortcuts into one persistence request', async () => {
    let finishSave!: (result: boolean) => void;
    const onSave = jest.fn(() => new Promise<boolean>((resolve) => {
      finishSave = resolve;
    }));
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={onSave}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    fireEvent.keyDown(document, { key: 's', ctrlKey: true });
    fireEvent.keyDown(document, { key: 's', ctrlKey: true });

    expect(onSave).toHaveBeenCalledTimes(1);
    finishSave(true);
    await waitFor(() => expect(screen.getByLabelText('Save status: saved')).toBeInTheDocument());
  });

  it('appends and wires a legal next step in one palette click', async () => {
    const selectedStartFlow = {
      ...initialFlow,
      nodes: [{ ...initialFlow.nodes[0], selected: true }],
    };
    render(
      <FlowBuilder
        initialFlow={selectedStartFlow}
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[selectedStartFlow]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Palette Process' }));

    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveTextContent('2:1'));
    expect(screen.getByLabelText('Node name')).toHaveValue('Process Node');
    expect(screen.queryByTestId('process-properties-modal')).not.toBeInTheDocument();
  });

  it('does not create an orphan when the selected node is terminal', async () => {
    const terminalFlow = {
      ...initialFlow,
      nodes: [{
        id: 'finish',
        type: 'finish',
        position: { x: 0, y: 0 },
        selected: true,
        data: { label: 'Finish', type: 'finish' },
      }],
    };
    render(
      <FlowBuilder
        initialFlow={terminalFlow as any}
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[terminalFlow as any]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Palette Process' }));

    await waitFor(() => expect(screen.getByText(/cannot lead to another step/i)).toBeInTheDocument());
    expect(screen.getByTestId('canvas')).toHaveTextContent('1:0');
  });

  it('reserves the one Trigger slot across rapid creation clicks', async () => {
    render(
      <FlowBuilder
        initialFlow={initialFlow}
        onSave={() => {}}
        onDelete={() => {}}
        allFlows={[initialFlow]}
      />,
    );

    const triggerButton = screen.getByRole('button', { name: 'Palette Trigger' });
    fireEvent.click(triggerButton);
    fireEvent.click(triggerButton);

    await waitFor(() => expect(screen.getByText(/Trigger node already exists/i)).toBeInTheDocument());
    expect(screen.getByTestId('canvas')).toHaveTextContent('2:0');
  });

  it('builds a beginner recipe, auto-binds the favorite model, and saves before Try', async () => {
    window.localStorage.setItem('flujo-ui:flow-builder:mode', JSON.stringify('guided'));
    const onSave = jest.fn().mockResolvedValue(true);
    const onTry = jest.fn();
    const guidedDraft = {
      ...initialFlow,
      id: 'draft-flow',
      name: 'NewFlow1',
    };

    render(
      <FlowBuilder
        initialFlow={guidedDraft}
        isDraft
        onSave={onSave}
        onTry={onTry}
        onDelete={() => {}}
        allFlows={[]}
      />,
    );

    const recipe = screen.getByLabelText('Guided agent builder');
    expect(within(recipe).getByText('Build it like a simple recipe.')).toBeInTheDocument();
    expect(within(recipe).getByText('WHEN')).toBeInTheDocument();
    expect(within(recipe).getByText('THEN')).toBeInTheDocument();
    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add node' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check Flow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Auto-Align' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Agent settings')).not.toBeInTheDocument();

    await waitFor(() => expect(modelService.loadModels).toHaveBeenCalledTimes(1));

    fireEvent.change(within(recipe).getByLabelText('Agent name'), {
      target: { value: 'Notes helper' },
    });
    fireEvent.change(within(recipe).getByLabelText('What should the AI do?'), {
      target: { value: 'Summarize my notes in friendly language.' },
    });
    fireEvent.click(within(recipe).getByRole('button', { name: 'Add this step' }));

    await waitFor(() => {
      expect(within(recipe).getByText('Summarize my notes in friendly language.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Step settings')).toBeInTheDocument();
    fireEvent.click(within(recipe).getByRole('button', { name: 'Try my agent' }));

    await waitFor(() => expect(onTry).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.invocationCallOrder[0]).toBeLessThan(onTry.mock.invocationCallOrder[0]);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Notes helper',
      nodes: expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'process',
            properties: expect.objectContaining({
              promptTemplate: 'Summarize my notes in friendly language.',
              boundModel: 'model-favorite',
            }),
          }),
        }),
      ]),
      edges: expect.arrayContaining([
        expect.objectContaining({ source: 'start', target: 'process-new' }),
        expect.objectContaining({ source: 'process-new', target: 'finish-new' }),
      ]),
    }));
  });
});
