import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';
import type { FlowNode } from '@/frontend/types/flow/flow';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import HumanNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/HumanNodePropertiesModal';
import { GuidedFlowComposer } from '@/frontend/components/Flow/FlowManager/FlowBuilder/GuidedFlowComposer';
import { flowService } from '@/frontend/services/flow';

const humanNode = (properties: Record<string, unknown> = { mode: 'approval', prompt: '' }): FlowNode => ({
  id: 'human-1',
  type: 'human',
  position: { x: 0, y: 0 },
  data: { label: 'Human step', type: 'human', properties },
});

const renderModal = (node: FlowNode, extra: { authoringMode?: 'guided' | 'advanced' } = {}) => {
  const onSave = jest.fn();
  render(<HumanNodePropertiesModal open node={node} onClose={() => {}} onSave={onSave} {...extra} />);
  return { onSave };
};

const saveButton = () => screen.getByRole('button', { name: 'Save' });

const pick = (container: HTMLElement, label: string, option: string) => {
  fireEvent.mouseDown(within(container).getByRole('combobox', { name: label }));
  fireEvent.click(screen.getByRole('option', { name: option }));
};

describe('HumanNodePropertiesModal', () => {
  it('keeps Save off until the question is written, then saves an approval step', () => {
    const { onSave } = renderModal(humanNode());

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText('Write the question for the person.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Question for the person/), { target: { value: 'Send this reply?' } });
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledTimes(1);
    const [id, data] = onSave.mock.calls[0];
    expect(id).toBe('human-1');
    expect(data.label).toBe('Human step');
    expect(data.properties).toEqual({
      mode: 'approval',
      prompt: 'Send this reply?',
      title: 'Human step',
      timeoutMinutes: 7 * 24 * 60,
    });
  });

  it('shows the questions editor for Fill in and saves the questions in order', () => {
    const { onSave } = renderModal(humanNode({ mode: 'approval', prompt: 'Plan the trip' }));

    fireEvent.click(screen.getByRole('button', { name: 'Fill in' }));
    expect(screen.getByText('Questions to fill in')).toBeInTheDocument();
    expect(screen.getByText('Add at least one question to fill in.')).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    const first = screen.getByLabelText('Question 1');
    fireEvent.change(within(first).getByLabelText('Question text'), { target: { value: 'Where to?' } });
    fireEvent.click(within(first).getByLabelText('Must be answered'));

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    const second = screen.getByLabelText('Question 2');
    fireEvent.change(within(second).getByLabelText('Answer name'), { target: { value: 'nights' } });
    pick(second, 'Answer type', 'Whole number');
    fireEvent.change(within(second).getByLabelText('Lowest'), { target: { value: '1' } });
    fireEvent.change(within(second).getByLabelText('Highest'), { target: { value: '14' } });

    fireEvent.click(within(screen.getByLabelText('Question 2')).getByRole('button', { name: 'Move up' }));
    expect(within(screen.getByLabelText('Question 1')).getByLabelText('Answer name')).toHaveValue('nights');

    pick(document.body, 'Unit', 'Hours');
    fireEvent.change(screen.getByLabelText('Wait up to'), { target: { value: '2' } });

    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    const [, data] = onSave.mock.calls[0];
    expect(data.properties.mode).toBe('input');
    expect(data.properties.timeoutMinutes).toBe(120);
    expect(data.properties.fields).toEqual([
      { name: 'nights', type: 'integer', min: 1, max: 14 },
      { name: 'answer1', label: 'Where to?', type: 'text', required: true },
    ]);
  });

  it('keeps Save off for a choice question without choices', () => {
    renderModal(humanNode({
      mode: 'input',
      prompt: 'Pick a size',
      fields: [{ name: 'size', type: 'choice', options: ['S'] }],
    }));
    expect(saveButton()).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Choices'), { target: { value: '' } });
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/A question needs a fix/)).toBeInTheDocument();
  });

  it('hides the go-on choices in the simple builder and offers them in Expert view', () => {
    renderModal(humanNode({ mode: 'edit', prompt: 'Check the draft' }), { authoringMode: 'guided' });
    expect(screen.queryByRole('combobox', { name: 'If the person says no' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message after a no')).toBeInTheDocument();
  });

  it('saves a go-on choice without a stop message', () => {
    const { onSave } = renderModal(humanNode({ mode: 'edit', prompt: 'Check the draft', rejectedText: 'No.' }), { authoringMode: 'advanced' });
    pick(document.body, 'If the person says no', 'Go on (route on the outcome)');
    expect(screen.queryByLabelText('Message after a no')).not.toBeInTheDocument();
    fireEvent.click(saveButton());
    const [, data] = onSave.mock.calls[0];
    expect(data.properties.onReject).toBe('continue');
    expect(data.properties.rejectedText).toBeUndefined();
  });
});

describe('Human step creation and the simple builder', () => {
  it('creates a new Human step that is clearly incomplete', () => {
    const node = flowService.createNode('human', { x: 0, y: 0 });
    expect(node.data.label).toBe('Human step');
    expect(node.data.properties).toEqual({ mode: 'approval', prompt: '' });
  });

  it('lists a Human step with its kind and offers Add human step', () => {
    const onAddHumanStep = jest.fn();
    render(
      <GuidedFlowComposer
        nodes={[humanNode({ mode: 'edit', prompt: 'Check the reply before it goes out.' })]}
        orderedStepIds={['human-1']}
        flowName="Reply helper"
        flowNameError={null}
        onFlowNameChange={jest.fn()}
        onSelectNode={jest.fn()}
        onAddTask={jest.fn()}
        onAddHumanStep={onAddHumanStep}
        onSwitchAdvanced={jest.fn()}
      />,
    );

    expect(screen.getByText('Person · Review and edit')).toBeInTheDocument();
    expect(screen.getByText('Check the reply before it goes out.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add human step' }));
    expect(onAddHumanStep).toHaveBeenCalledTimes(1);
  });
});
