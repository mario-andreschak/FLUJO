import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  });

  it('omits the unattended control and strips historical values from saves', () => {
    const onSave = jest.fn();
    const legacyFlow = {
      ...initialFlow,
      permissionRules: undefined,
      unattended: true,
    };
    render(<FlowBuilder initialFlow={legacyFlow} onSave={onSave} onDelete={() => {}} allFlows={[legacyFlow]} />);

    expect(screen.queryByText(/This flow contains advanced settings/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Unattended/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Guided' }));
    expect(screen.queryByRole('checkbox', { name: /Unattended/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save Flow' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).not.toHaveProperty('unattended');
  });

  it('edits, reorders, and saves rules in their displayed order without editor IDs', async () => {
    const onSave = jest.fn();
    render(<FlowBuilder initialFlow={initialFlow} onSave={onSave} onDelete={() => {}} allFlows={[initialFlow]} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Guided' }));
    fireEvent.click(screen.getByRole('button', { name: /Permission Rules/i }));
    expect(screen.getByText('Flow permission rules')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Rule 1 action'), { target: { value: 'read_config' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move rule 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Flow permission rules')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save Flow' }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      permissionRules: [
        { action: 'write_file', resource: '/tmp/*', effect: 'deny' },
        { action: 'read_config', resource: '/tmp/*', effect: 'allow' },
      ],
    }));
  });

  it('prevents saving an incomplete newly added rule', async () => {
    const onSave = jest.fn();
    render(<FlowBuilder initialFlow={initialFlow} onSave={onSave} onDelete={() => {}} allFlows={[initialFlow]} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Guided' }));
    fireEvent.click(screen.getByRole('button', { name: /Permission Rules/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByText('Flow permission rules')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Save Flow' }));

    expect(screen.getByText(/Each permission rule needs both an action and a resource/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});
