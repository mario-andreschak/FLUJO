import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FlowAssistanceDialog from '@/frontend/components/Flow/FlowManager/FlowBuilder/FlowAssistanceDialog';
import { flowService } from '@/frontend/services/flow';
import type { Flow } from '@/shared/types/flow';

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    suggestToolsForStep: jest.fn(),
    applyToolsToStep: jest.fn(),
    checkPlausibility: jest.fn(),
  },
}));

const flow = (id: string, prompt = 'Read the notes'): Flow => ({
  id,
  name: id,
  nodes: [{
    id: `${id}-work`,
    type: 'process',
    position: { x: 0, y: 0 },
    data: { label: 'Work', type: 'process', properties: { promptTemplate: prompt } },
  }],
  edges: [],
});

describe('FlowAssistanceDialog', () => {
  beforeEach(() => jest.clearAllMocks());

  it('suggests automatically, applies only checked tools, then repairs the editable bundle after consent', async () => {
    const root = flow('root');
    const child = flow('child');
    const unrelatedDraft = flow('unrelated');
    const toolUpdated = flow('root', 'Tool-updated prompt');
    const repairedRoot = flow('root', 'Repaired root');
    const repairedChild = flow('child', 'Repaired child');
    (flowService.suggestToolsForStep as jest.Mock).mockResolvedValue({
      nodeId: 'root-work',
      suggestions: [
        { server: 'files', tool: 'read_file', reason: 'read notes' },
        { server: 'files', tool: 'write_file', reason: 'write notes' },
      ],
      proposedPrompt: 'Use both connected tools.',
    });
    (flowService.applyToolsToStep as jest.Mock).mockResolvedValue(toolUpdated);
    (flowService.checkPlausibility as jest.Mock).mockResolvedValue({
      contexts: [{ kind: 'chat', label: 'Chat / direct run' }],
      issues: [{ severity: 'warning', code: 'assisted-io-policy', message: 'Repair modes.', flowId: root.id }],
      patches: [{ flowId: root.id, nodeId: 'root-work', set: { inputMode: 'full-history' }, remove: [], reason: 'Repair modes.' }],
      repairedFlow: repairedRoot,
      repairedFlows: [repairedRoot, repairedChild],
    });
    const onApply = jest.fn();
    const onApplyRelatedFlows = jest.fn();
    const onClose = jest.fn();

    render(
      <FlowAssistanceDialog
        open
        flow={root}
        relatedFlows={[child, unrelatedDraft]}
        nodeId="root-work"
        modelId="model-1"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={onApply}
        onApplyRelatedFlows={onApplyRelatedFlows}
        onClose={onClose}
      />,
    );

    await waitFor(() => expect(flowService.suggestToolsForStep).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'root-work',
      modelId: 'model-1',
    })));
    fireEvent.click(await screen.findByRole('checkbox', { name: /write_file/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect 1 and fix prompt' }));

    await waitFor(() => expect(flowService.applyToolsToStep).toHaveBeenCalledWith(expect.objectContaining({
      selections: [{ server: 'files', tool: 'read_file', reason: 'read notes' }],
    })));
    await screen.findByText('Repair modes.');
    fireEvent.click(screen.getByRole('button', { name: 'Apply recommended settings' }));

    expect(onApply).toHaveBeenNthCalledWith(1, toolUpdated);
    expect(onApply).toHaveBeenNthCalledWith(2, repairedRoot);
    expect(onApplyRelatedFlows).toHaveBeenCalledWith([repairedChild, unrelatedDraft]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit model choice when the step has no bound model', async () => {
    const root = flow('root');
    (flowService.suggestToolsForStep as jest.Mock).mockResolvedValue({
      nodeId: 'root-work',
      suggestions: [{ server: 'files', tool: 'read_file', reason: 'read notes' }],
      proposedPrompt: 'Read the notes',
    });
    render(
      <FlowAssistanceDialog
        open
        flow={root}
        nodeId="root-work"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/will not pick one silently/i)).toBeInTheDocument();
    expect(flowService.suggestToolsForStep).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByLabelText('AI helper'));
    fireEvent.click(screen.getByRole('option', { name: 'Helper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest connected tools' }));
    await waitFor(() => expect(flowService.suggestToolsForStep).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'model-1',
    })));
  });
});
