/**
 * Subflow modal execution controls after the queue simplification.
 *
 * A node selects one child flow. Every model handoff call becomes a queued job,
 * and concurrencyLimit controls only how many jobs are active simultaneously.
 * Legacy fan-out/map properties remain readable by the runtime but are not
 * authored by this modal.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import SubflowNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/SubflowNodePropertiesModal';

jest.mock('@/frontend/services/flow', () => ({
  flowService: { loadFlows: jest.fn().mockResolvedValue([]) },
}));

const makeNode = (properties: Record<string, any>): any => ({
  id: 'n1',
  type: 'subflow',
  position: { x: 0, y: 0 },
  data: { label: 'Subflow Node', type: 'subflow', properties },
});

const renderModal = (properties: Record<string, any>) => {
  const saved: { data: any } = { data: null };
  render(
    <SubflowNodePropertiesModal
      open
      node={makeNode(properties)}
      onClose={() => {}}
      onSave={(_id, data) => { saved.data = data; }}
      flowId="self"
    />,
  );
  return saved;
};

const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save' }));
const concurrencyField = () => screen.getByRole('spinbutton', { name: 'Maximum simultaneous children' });

describe('SubflowNodePropertiesModal — queued execution', () => {
  it('shows one concurrency control and removes the old execution-shape editors', async () => {
    renderModal({ subflowId: 'child-1' });

    expect(await screen.findByText('Execution')).toBeInTheDocument();
    expect(concurrencyField()).toBeInTheDocument();
    expect(screen.getByText(/Every call is queued/i)).toBeInTheDocument();
    expect(screen.queryByText('Dynamic fan-out')).not.toBeInTheDocument();
    expect(screen.queryByText(/map over list/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Always spawn these briefs/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Error handling')).not.toBeInTheDocument();
    expect(screen.queryByText('Separator between merged results')).not.toBeInTheDocument();
  });

  it('stores 1 as sequential execution through the simultaneous-child limit', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Execution');

    fireEvent.change(concurrencyField(), { target: { value: '1' } });
    save();

    expect(saved.data.properties.concurrencyLimit).toBe(1);
  });

  it('stores a higher simultaneous-child limit without limiting total queued jobs', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Execution');

    fireEvent.change(concurrencyField(), { target: { value: '7' } });
    save();

    expect(saved.data.properties.concurrencyLimit).toBe(7);
  });

  it('removes concurrencyLimit when the field is cleared so runtime default 4 applies', async () => {
    const saved = renderModal({ subflowId: 'child-1', concurrencyLimit: 2 });
    await screen.findByText('Execution');

    fireEvent.change(concurrencyField(), { target: { value: '' } });
    save();

    expect(saved.data.properties).toEqual({ subflowId: 'child-1' });
  });

  it('does not seed execution defaults on an unrelated save', async () => {
    const saved = renderModal({ subflowId: 'child-1' });
    await screen.findByText('Execution');
    save();

    expect(saved.data.properties).toEqual({ subflowId: 'child-1' });
  });

  it('shows but preserves legacy saved-flow settings for compatibility', async () => {
    const saved = renderModal({
      subflowId: 'child-1',
      mapOverList: true,
      itemSplit: 'lines',
    });

    expect(await screen.findByText(/legacy fan-out or map settings/i)).toBeInTheDocument();
    save();

    expect(saved.data.properties).toMatchObject({
      subflowId: 'child-1',
      mapOverList: true,
      itemSplit: 'lines',
    });
  });
});
