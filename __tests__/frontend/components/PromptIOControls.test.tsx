import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import PromptIOControls, {
  type PromptIOControlsProps,
} from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal/PromptIOControls';

function renderControls(overrides: Partial<PromptIOControlsProps> = {}) {
  const setExcludeSystemPromptSections = jest.fn();
  const props: PromptIOControlsProps = {
    excludeModelPrompt: false,
    setExcludeModelPrompt: jest.fn(),
    excludeStartNodePrompt: false,
    setExcludeStartNodePrompt: jest.fn(),
    excludeSystemPrompt: false,
    setExcludeSystemPrompt: jest.fn(),
    excludeSystemPromptSections: [],
    setExcludeSystemPromptSections,
    inputMode: 'full-history',
    setInputMode: jest.fn(),
    isolatedPrompt: '',
    setIsolatedPrompt: jest.fn(),
    allowCallerPrompt: true,
    setAllowCallerPrompt: jest.fn(),
    outputMode: 'full-conversation',
    setOutputMode: jest.fn(),
    isModelBound: false,
    models: [],
    nodeData: { label: 'Step', type: 'process', properties: {} },
    ...overrides,
  };
  render(<PromptIOControls {...props} />);
  return { setExcludeSystemPromptSections };
}

describe('PromptIOControls system prompt parts (issue #1231)', () => {
  it('offers one checkbox per part, all ticked by default, and lists FLUJO\'s part in the order', () => {
    renderControls();
    const parts = screen.getByRole('group', { name: 'Parts of FLUJO’s system prompt' });
    const boxes = within(parts).getAllByRole('checkbox');
    expect(boxes.map((box) => box.closest('label')?.textContent)).toEqual([
      'Basic rules', 'Workflow and hand-offs', 'Other agents', 'Asking people', 'FLUJO tools', 'Stored results',
    ]);
    expect(boxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText('FLUJO system prompt')).toBeInTheDocument();
  });

  it('records an unticked part as left out, keeping the fixed order', () => {
    const { setExcludeSystemPromptSections } = renderControls({ excludeSystemPromptSections: ['people'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Workflow and hand-offs' }));
    expect(setExcludeSystemPromptSections).toHaveBeenCalledWith(['workflow', 'people']);
  });

  it('ticks a left-out part back in', () => {
    const { setExcludeSystemPromptSections } = renderControls({ excludeSystemPromptSections: ['workflow', 'people'] });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Asking people' }));
    expect(setExcludeSystemPromptSections).toHaveBeenCalledWith(['workflow']);
  });

  it('hides the parts and FLUJO\'s line in the order when the whole system prompt is excluded', () => {
    renderControls({ excludeSystemPrompt: true });
    expect(screen.queryByRole('group', { name: 'Parts of FLUJO’s system prompt' })).not.toBeInTheDocument();
    expect(screen.queryByText('FLUJO system prompt')).not.toBeInTheDocument();
  });
});
