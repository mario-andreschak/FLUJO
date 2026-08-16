import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickChangeModelsDialog from '@/frontend/components/Flow/FlowDashboard/QuickChangeModelsDialog';
import type { Flow } from '@/frontend/types/flow/flow';
import type { Model } from '@/shared/types/model';

const model = (id: string, name: string, displayName: string): Model => ({
  id,
  name,
  displayName,
  ApiKey: '',
});

const flow = (id: string, modelId: string, modelName: string): Flow => ({
  id,
  name: `Agent ${id}`,
  nodes: [{
    id: `${id}-node`,
    type: 'process',
    position: { x: 0, y: 0 },
    data: {
      label: 'AI step',
      type: 'process',
      properties: { boundModel: modelId, modelName },
    },
  }],
  edges: [],
});

describe('QuickChangeModelsDialog', () => {
  it('maps a used model to an installed replacement and submits the package-compatible shape', async () => {
    const onApply = jest.fn().mockResolvedValue({
      updatedFlowCount: 2,
      replacedNodeCount: 2,
      failedFlowCount: 0,
    });
    const onClose = jest.fn();

    render(
      <QuickChangeModelsDialog
        open
        flows={[
          flow('one', 'old', 'old-technical'),
          flow('two', 'old', 'old-technical'),
        ]}
        models={[
          model('old', 'old-technical', 'Old model'),
          model('new', 'new-technical', 'New model'),
        ]}
        onClose={onClose}
        onApply={onApply}
      />,
    );

    expect(screen.getByText('2 AI steps in 2 agents')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Replacement model'));
    fireEvent.click(await screen.findByRole('option', { name: 'New model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update agents' }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledWith({
        old: { id: 'new', name: 'new-technical' },
      });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('surfaces deleted bindings so they can be repaired', () => {
    render(
      <QuickChangeModelsDialog
        open
        flows={[flow('one', 'deleted', 'Former model')]}
        models={[model('new', 'new-technical', 'New model')]}
        onClose={() => undefined}
        onApply={async () => ({ updatedFlowCount: 1, replacedNodeCount: 1, failedFlowCount: 0 })}
      />,
    );

    expect(screen.getByText('Former model')).toBeInTheDocument();
    expect(screen.getByText('Missing')).toBeInTheDocument();
  });
});
