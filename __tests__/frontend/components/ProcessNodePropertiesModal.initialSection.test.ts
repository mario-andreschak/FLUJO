import { getInitialProcessSection } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/ProcessNodePropertiesModal';

describe('ProcessNodePropertiesModal initial section', () => {
  it('opens Task first in guided mode when the task prompt is not empty', () => {
    expect(getInitialProcessSection('guided', 'Summarize the document')).toBe('task');
  });

  it('opens Basic first in guided mode for an empty task prompt', () => {
    expect(getInitialProcessSection('guided', '   ')).toBe('basic');
  });

  it('keeps Advanced mode opening on Basic', () => {
    expect(getInitialProcessSection('advanced', 'Summarize the document')).toBe('basic');
  });
});
