import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { InspectorPanel } from '@/frontend/components/Flow/FlowManager/FlowBuilder/InspectorPanel';

const processNode: any = {
  id: 'process-1',
  type: 'process',
  position: { x: 100, y: 200 },
  selected: true,
  data: {
    type: 'process',
    label: 'Research',
    description: 'Gather facts',
    properties: {
      promptTemplate: 'Find reliable sources',
      modelId: 'model-1',
    },
  },
};

const baseProps = {
  onClearSelection: jest.fn(),
  onCommitNode: jest.fn(),
  onOpenAdvanced: jest.fn(),
  flowName: 'research_flow',
  flowNameError: null,
  onFlowNameChange: jest.fn(),
  flowDescription: 'Research workflow',
  onFlowDescriptionChange: jest.fn(),
  authoringMode: 'guided' as const,
  onAuthoringModeChange: jest.fn(),
  permissionRuleCount: 0,
  onOpenPermissionRules: jest.fn(),
};

describe('FlowBuilder InspectorPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows selected node essentials inline and commits a buffered edit on blur', () => {
    render(<InspectorPanel {...baseProps} selectedNode={processNode} />);

    expect(screen.getByRole('tab', { name: 'Node' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByDisplayValue('Find reliable sources')).toBeInTheDocument();
    expect(screen.getByText('model-1')).toBeInTheDocument();

    const name = screen.getByLabelText('Node name');
    fireEvent.change(name, { target: { value: 'Research deeply' } });
    fireEvent.blur(name);

    expect(baseProps.onCommitNode).toHaveBeenCalledWith(
      'process-1',
      expect.objectContaining({ label: 'Research deeply' }),
    );
  });

  it('keeps complex configuration available without making it the default path', () => {
    render(<InspectorPanel {...baseProps} selectedNode={processNode} />);

    fireEvent.change(screen.getByLabelText('Node name'), { target: { value: 'Fresh inline name' } });
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Use the fresh prompt' } });
    fireEvent.click(screen.getByRole('button', { name: /Full settings/i }));

    expect(baseProps.onOpenAdvanced).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        label: 'Fresh inline name',
        properties: expect.objectContaining({ promptTemplate: 'Use the fresh prompt' }),
      }),
    }));
  });

  it('uses the same rail for flow-level settings when no node is selected', () => {
    render(<InspectorPanel {...baseProps} selectedNode={null} />);

    fireEvent.change(screen.getByLabelText('Flow Name'), { target: { value: 'renamed_flow' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Guided' }));

    expect(baseProps.onFlowNameChange).toHaveBeenCalledWith('renamed_flow');
    expect(baseProps.onAuthoringModeChange).toHaveBeenCalledWith('advanced');
  });

  it('uses beginner language and hides implementation details in simple setup', () => {
    render(<InspectorPanel {...baseProps} beginnerMode selectedNode={processNode} />);

    expect(screen.getByLabelText('Step settings')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Step name')).toHaveValue('Research');
    expect(screen.getByLabelText('What should the AI do?')).toHaveValue('Find reliable sources');
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
    expect(screen.queryByText('process-1')).not.toBeInTheDocument();
    expect(screen.queryByText('model-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
});
