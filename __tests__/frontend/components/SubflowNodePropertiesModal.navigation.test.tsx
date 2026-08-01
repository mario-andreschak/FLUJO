import { fireEvent, render, screen } from '@testing-library/react';
import SubflowNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal';

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: jest.fn().mockResolvedValue([
      { id: 'child-flow', name: 'Research assistant', nodes: [], edges: [] },
    ]),
  },
}));

describe('SubflowNodePropertiesModal navigation', () => {
  it('navigates to the selected target flow by id', async () => {
    const onNavigateToFlow = jest.fn();
    render(
      <SubflowNodePropertiesModal
        open
        node={{
          id: 'subflow-node',
          type: 'subflow',
          position: { x: 0, y: 0 },
          data: {
            label: 'Research step',
            type: 'subflow',
            properties: { subflowId: 'child-flow' },
          },
        }}
        onClose={jest.fn()}
        onSave={jest.fn()}
        onNavigateToFlow={onNavigateToFlow}
        flowId="parent-flow"
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open target flow' }));

    expect(onNavigateToFlow).toHaveBeenCalledWith('child-flow');
  });
});
