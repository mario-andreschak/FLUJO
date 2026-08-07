import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import FlowAssistanceDialog from '@/frontend/components/Flow/FlowManager/FlowBuilder/FlowAssistanceDialog';
import { flowService } from '@/frontend/services/flow';
import type { Flow } from '@/shared/types/flow';

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    suggestToolsForStep: jest.fn(),
    applyToolsToStep: jest.fn(),
    suggestAgentsForStep: jest.fn(),
    applyAgentsToStep: jest.fn(),
    improvePromptForStep: jest.fn(),
    checkPlausibility: jest.fn(),
    improveFlow: jest.fn(),
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
  beforeEach(() => {
    jest.clearAllMocks();
    (flowService.suggestAgentsForStep as jest.Mock).mockResolvedValue({
      nodeId: 'root-work',
      suggestions: [],
    });
    (flowService.improvePromptForStep as jest.Mock).mockImplementation(async ({ flow: candidate, nodeId }: {
      flow: Flow;
      nodeId: string;
    }) => ({
      nodeId,
      prompt: String(candidate.nodes.find((node) => node.id === nodeId)?.data.properties?.promptTemplate ?? ''),
    }));
  });

  it('suggests automatically, applies checked tools, then fixes only the selected finding', async () => {
    const root = flow('root');
    const child = flow('child');
    const unrelatedDraft = flow('unrelated');
    const toolUpdated = flow('root', 'Tool-updated prompt');
    const repairedRoot = flow('root', 'Tool-updated prompt');
    repairedRoot.nodes[0].data.properties!.inputMode = 'full-history';
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
      issues: [{
        severity: 'warning',
        code: 'assisted-io-policy',
        message: 'Repair modes.',
        flowId: root.id,
        nodeId: 'root-work',
      }],
      patches: [{ flowId: root.id, nodeId: 'root-work', set: { inputMode: 'full-history' }, remove: [], reason: 'Repair modes.' }],
      repairedFlow: repairedRoot,
      repairedFlows: [repairedRoot, child],
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect 1 tool and fix prompt' }));

    await waitFor(() => expect(flowService.applyToolsToStep).toHaveBeenCalledWith(expect.objectContaining({
      selections: [{ server: 'files', tool: 'read_file', reason: 'read notes' }],
    })));
    expect(await screen.findByText('No saved agent is needed for this step.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Improve prompt and check flow' }));
    await screen.findByText('Repair modes.');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select issue: Repair modes.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix 1 selected issue' }));

    expect(onApply).toHaveBeenNthCalledWith(1, toolUpdated);
    expect(onApply).toHaveBeenNthCalledWith(2, toolUpdated);
    expect(onApply).toHaveBeenNthCalledWith(3, repairedRoot);
    expect(onApplyRelatedFlows).toHaveBeenCalledWith([child, unrelatedDraft]);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect((flowService.suggestAgentsForStep as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((flowService.improvePromptForStep as jest.Mock).mock.invocationCallOrder[0]);
    expect(flowService.improvePromptForStep).toHaveBeenCalledWith(expect.objectContaining({
      relatedFlows: [child, unrelatedDraft],
    }));
    expect((flowService.improvePromptForStep as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((flowService.checkPlausibility as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('shows an inline spinner while the prompt improvement is pending', async () => {
    const root = flow('root');
    let finishImprovement!: (value: { nodeId: string; prompt: string }) => void;
    (flowService.improvePromptForStep as jest.Mock).mockImplementationOnce(() =>
      new Promise((resolve) => { finishImprovement = resolve; }),
    );
    (flowService.checkPlausibility as jest.Mock).mockResolvedValue({
      contexts: [{ kind: 'chat', label: 'Chat / direct run' }],
      issues: [],
      patches: [],
      repairedFlow: root,
      repairedFlows: [root],
    });

    render(
      <FlowAssistanceDialog
        open
        flow={root}
        nodeId="root-work"
        initialFocus="agents"
        modelId="model-1"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Improve prompt and check flow' }));
    const improving = await screen.findByRole('button', { name: 'Improving prompt…' });
    expect(improving).toBeDisabled();
    expect(improving.querySelector('[role="progressbar"]')).not.toBeNull();

    await act(async () => {
      finishImprovement({ nodeId: 'root-work', prompt: 'Improved prompt' });
    });
    expect(await screen.findByText('The flow is plausible in its current invocation context.')).toBeInTheDocument();
  });

  it('uses the chosen AI helper to fix only selected semantic findings', async () => {
    const root = flow('root');
    const improvedRoot = flow('root', 'Improved prompt');
    (flowService.checkPlausibility as jest.Mock).mockResolvedValue({
      contexts: [{ kind: 'chat', label: 'Chat / direct run' }],
      issues: [
        { severity: 'error', code: 'semantic-input', message: 'Pass the requested topic into the first step.', flowId: root.id },
        { severity: 'warning', code: 'semantic-duration', message: 'Add a duration constraint.', flowId: root.id },
      ],
      patches: [],
      repairedFlow: root,
      repairedFlows: [root],
    });
    (flowService.improveFlow as jest.Mock).mockResolvedValue({
      success: true,
      flow: improvedRoot,
      validation: { errorCount: 0, warningCount: 0 },
      flows: [{ flow: improvedRoot, validation: { errorCount: 0, warningCount: 0 } }],
      rootFlowId: root.id,
      attempts: 1,
      installedServers: [],
    });
    const onApply = jest.fn();
    const onClose = jest.fn();

    render(
      <FlowAssistanceDialog
        open
        flow={root}
        modelId="model-1"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={onApply}
        onClose={onClose}
      />,
    );

    await screen.findByText('Pass the requested topic into the first step.');
    fireEvent.click(screen.getByRole('checkbox', {
      name: 'Select issue: Pass the requested topic into the first step.',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Fix 1 selected issue' }));

    await waitFor(() => expect(flowService.improveFlow).toHaveBeenCalledTimes(1));
    const [, instruction, chosenModel, options] = (flowService.improveFlow as jest.Mock).mock.calls[0];
    expect(instruction).toContain('Pass the requested topic into the first step.');
    expect(instruction).not.toContain('Add a duration constraint.');
    expect(chosenModel).toBe('model-1');
    expect(options).toEqual(expect.objectContaining({ allowInstall: false }));
    expect(onApply).toHaveBeenCalledWith(improvedRoot);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets the user discuss a proposal and makes the AI reconsider the full tool catalog', async () => {
    const root = flow('root');
    const initialSuggestion = {
      nodeId: 'root-work',
      suggestions: [],
      proposedPrompt: 'Read the notes',
    };
    (flowService.suggestToolsForStep as jest.Mock)
      .mockResolvedValueOnce(initialSuggestion)
      .mockResolvedValueOnce({
        nodeId: 'root-work',
        suggestions: [{ server: 'files', tool: 'write_file', reason: 'handles the complete export' }],
        proposedPrompt: 'Export the notes with ${tool:files__write_file}.',
        assistantMessage: 'You were right—the connected write tool can handle this by itself.',
      });

    render(
      <FlowAssistanceDialog
        open
        flow={root}
        nodeId="root-work"
        modelId="model-1"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('No connected MCP tool is needed for this step.')).toBeInTheDocument();
    expect(flowService.checkPlausibility).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Talk about this' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'What should the AI reconsider?' }), {
      target: { value: 'There is already one tool that can handle the whole export.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconsider suggestions' }));

    await waitFor(() => expect(flowService.suggestToolsForStep).toHaveBeenCalledTimes(2));
    expect(flowService.suggestToolsForStep).toHaveBeenLastCalledWith(expect.objectContaining({
      feedback: ['There is already one tool that can handle the whole export.'],
      previousSuggestion: initialSuggestion,
    }));
    expect(await screen.findByText('write_file')).toBeInTheDocument();
    expect(screen.getByText(/You were right/)).toBeInTheDocument();
    expect(flowService.checkPlausibility).not.toHaveBeenCalled();
  });

  it('suggests and connects approved agents before prompt improvement and plausibility', async () => {
    const root = flow('root');
    const withAgent = flow('root', 'Read the notes and delegate the draft.');
    (flowService.suggestAgentsForStep as jest.Mock).mockResolvedValue({
      nodeId: 'root-work',
      suggestions: [{ flowId: 'writer', flowName: 'Writer', reason: 'draft the final response' }],
    });
    (flowService.applyAgentsToStep as jest.Mock).mockResolvedValue(withAgent);
    (flowService.checkPlausibility as jest.Mock).mockResolvedValue({
      contexts: [{ kind: 'chat', label: 'Chat / direct run' }],
      issues: [],
      patches: [],
      repairedFlow: withAgent,
      repairedFlows: [withAgent],
    });

    render(
      <FlowAssistanceDialog
        open
        flow={root}
        nodeId="root-work"
        initialFocus="agents"
        modelId="model-1"
        models={[{ id: 'model-1', name: 'Helper' }]}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText('Writer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect 1 agent' }));
    await screen.findByText('The flow is plausible in its current invocation context.');

    expect(flowService.applyAgentsToStep).toHaveBeenCalledWith(expect.objectContaining({
      selections: [{ flowId: 'writer', flowName: 'Writer', reason: 'draft the final response' }],
    }));
    expect((flowService.applyAgentsToStep as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((flowService.improvePromptForStep as jest.Mock).mock.invocationCallOrder[0]);
    expect((flowService.improvePromptForStep as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((flowService.checkPlausibility as jest.Mock).mock.invocationCallOrder[0]);
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

    expect(await screen.findByText(/will not choose one without telling you/i)).toBeInTheDocument();
    expect(flowService.suggestToolsForStep).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByLabelText('AI helper'));
    fireEvent.click(screen.getByRole('option', { name: 'Helper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Suggest connected apps' }));
    await waitFor(() => expect(flowService.suggestToolsForStep).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'model-1',
    })));
  });
});
