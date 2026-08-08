import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FlowBuilder } from '@/frontend/components/Flow/FlowManager/FlowBuilder';
import { workspaceLocalStorageKey } from '@/frontend/utils/workspaceSelection';

jest.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  applyNodeChanges: jest.fn((changes: unknown, nodes: unknown) => nodes),
  applyEdgeChanges: jest.fn((changes: unknown, edges: unknown) => edges),
}));

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: () => ({
    open: false,
    openDock: jest.fn(),
    closeDock: jest.fn(),
    toggleDock: jest.fn(),
    getPageContext: jest.fn(),
    applyPageAction: jest.fn(),
    registerPage: jest.fn(() => jest.fn()),
  }),
  useAskFlujoPage: jest.fn(() => null),
}));

jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas', () => ({
  Canvas: () => <div data-testid="canvas" />,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/NodePalette', () => ({
  NodePalette: () => <div />,
}));
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/FlowValidationButton', () => ({
  FlowValidationButton: () => <div />,
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
jest.mock('@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/FlowVersionHistoryDialog', () => () => null);
jest.mock('@/frontend/components/Flow/FlowManager/ImproveFlowDialog', () => () => null);
jest.mock('@/frontend/services/flow', () => ({
  flowService: { createStartNode: jest.fn(() => ({ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start' } })) },
}));
jest.mock('@/frontend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/frontend/services/model', () => ({
  modelService: { loadModels: jest.fn().mockResolvedValue([]) },
}));

const initialFlow: any = {
  id: 'flow-1',
  name: 'permission_flow',
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start', type: 'start' } }],
  edges: [],
  permissionRules: [
    { action: 'read_file', resource: '/tmp/*', effect: 'allow' },
    { action: 'write_file', resource: '/tmp/*', effect: 'deny' },
  ],
};

describe('FlowBuilder permission rules', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      workspaceLocalStorageKey('flujo-ui:flow-builder:mode'),
      JSON.stringify('advanced'),
    );
  });

  it('omits the unattended control and strips historical values from saves', async () => {
    const onSave = jest.fn();
    const legacyFlow = {
      ...initialFlow,
      permissionRules: undefined,
      unattended: true,
    };
    render(<FlowBuilder initialFlow={legacyFlow} onSave={onSave} onDelete={() => {}} allFlows={[legacyFlow]} />);

    expect(screen.queryByText(/This flow contains advanced settings/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Unattended/i })).not.toBeInTheDocument();

    expect(screen.queryByRole('checkbox', { name: /Unattended/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('unattended');
    await waitFor(() => expect(screen.getByLabelText('Save status: Saved')).toBeInTheDocument());
  });

  it('edits, reorders, and saves rules in their displayed order without editor IDs', async () => {
    const onSave = jest.fn();
    render(<FlowBuilder initialFlow={initialFlow} onSave={onSave} onDelete={() => {}} allFlows={[initialFlow]} />);

    fireEvent.click(screen.getByRole('button', { name: /Permission Rules/i }));
    expect(screen.getByText('Flow permission rules')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Rule 1: Action'), { target: { value: 'read_config' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Flow permission rules')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      permissionRules: [
        { action: 'write_file', resource: '/tmp/*', effect: 'deny' },
        { action: 'read_config', resource: '/tmp/*', effect: 'allow' },
      ],
    }));
    await waitFor(() => expect(screen.getByLabelText('Save status: Saved')).toBeInTheDocument());
  });

  it('prevents saving an incomplete newly added rule', async () => {
    const onSave = jest.fn();
    render(<FlowBuilder initialFlow={initialFlow} onSave={onSave} onDelete={() => {}} allFlows={[initialFlow]} />);

    fireEvent.click(screen.getByRole('button', { name: /Permission Rules/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Flow permission rules')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save flow' }));

    expect(screen.getByText(/Each permission rule needs both an action and a resource/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
