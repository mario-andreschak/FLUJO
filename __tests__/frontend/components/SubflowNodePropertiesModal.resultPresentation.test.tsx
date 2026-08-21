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
  it('does not render the removed result-presentation selector', async () => {
    renderModal({});
    await screen.findByText('Execution');

    expect(screen.queryByRole('radio', { name: /one combined message/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /separate messages per lane/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Parallel results')).not.toBeInTheDocument();
  });

  it.each(['separate', 'joined'] as const)('normalizes saved %s result presentation to separate', async (resultPresentation) => {
    const saved = renderModal({ resultPresentation });
    await screen.findByText('Execution');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved.data.properties.resultPresentation).toBe('separate');
  });

  it('does not render the control in guided mode', () => {
    renderModal({}, 'guided');

    expect(screen.queryByText('Parallel results')).not.toBeInTheDocument();
  });
});

describe('SubflowNodePropertiesModal child conversation memory', () => {
  it('defaults legacy nodes to a fresh child on every visit', async () => {
    renderModal({});

    expect(await screen.findByRole('radio', { name: /fresh every visit/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('round-trips summarized session history and a positive turn cap', async () => {
    const saved = renderModal({ sessionScope: 'per-run' });
    fireEvent.click(await screen.findByRole('radio', { name: /summarized history/i }));
    fireEvent.change(screen.getByRole('spinbutton', { name: /retained logical turns/i }), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved.data.properties).toMatchObject({
      sessionScope: 'per-run',
      sessionInputMode: 'summary',
      sessionTurnCap: 4,
    });
  });

  it('rejects invalid caps and removes session-only values when returning to per-visit', async () => {
    const saved = renderModal({
      sessionScope: 'per-run',
      sessionInputMode: 'summary',
      sessionTurnCap: 3,
    });
    const cap = await screen.findByRole('spinbutton', { name: /retained logical turns/i });
    fireEvent.change(cap, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /fresh every visit/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(saved.data.properties.sessionScope).toBeUndefined();
    expect(saved.data.properties.sessionInputMode).toBeUndefined();
    expect(saved.data.properties.sessionTurnCap).toBeUndefined();
  });

  it('saves a caller-addressable keyed session and optional fixed key', async () => {
    const saved = renderModal({});
    fireEvent.click(await screen.findByRole('radio', { name: /one per session key/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /fixed session key/i }), {
      target: { value: 'writer-main' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(saved.data.properties).toMatchObject({
      sessionScope: 'per-key',
      sessionKey: 'writer-main',
    });
  });
});
