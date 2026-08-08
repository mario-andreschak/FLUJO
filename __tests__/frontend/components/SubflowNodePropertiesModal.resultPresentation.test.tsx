import { render, screen, fireEvent } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import SubflowNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal';

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: jest.fn().mockResolvedValue([]) },
}));

const makeNode = (properties: Record<string, unknown>): any => ({
  id: 'n1',
  type: 'subflow',
  position: { x: 0, y: 0 },
  data: { label: 'Subflow Node', type: 'subflow', properties },
});

const renderModal = (properties: Record<string, unknown>, authoringMode: 'advanced' | 'guided' = 'advanced') => {
  const saved: { data: any } = { data: null };
  render(
    <SubflowNodePropertiesModal
      open
      node={makeNode(properties)}
      onClose={() => {}}
      onSave={(_id, data) => { saved.data = data; }}
      flowId="self"
      authoringMode={authoringMode}
    />,
  );
  return saved;
};

describe('SubflowNodePropertiesModal result presentation', () => {
  it('shows joined for legacy nodes and separate for explicitly configured nodes', async () => {
    renderModal({});
    expect(await screen.findByRole('radio', { name: /one combined message/i })).toHaveAttribute('aria-checked', 'true');

    renderModal({ resultPresentation: 'separate' });
    expect(await screen.findByRole('radio', { name: /separate messages per lane/i })).toHaveAttribute('aria-checked', 'true');
  });

  it.each(['separate', 'joined'] as const)('saves an explicit %s result presentation', async (resultPresentation) => {
    const saved = renderModal({});
    const cardName = resultPresentation === 'separate' ? /separate messages per lane/i : /one combined message/i;
    fireEvent.click(await screen.findByRole('radio', { name: cardName }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved.data.properties.resultPresentation).toBe(resultPresentation);
  });

  it('does not render the control in guided mode', () => {
    renderModal({}, 'guided');

    expect(screen.queryByText('Parallel results')).not.toBeInTheDocument();
  });
});
