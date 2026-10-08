import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Flow } from '@/frontend/types/flow/flow';

jest.mock('@/frontend/components/Flow/FlowDashboard/FlowCard', () => ({
  __esModule: true,
  default: ({
    flow,
    onSelect,
    selectionMode,
    selected,
  }: {
    flow: Flow;
    onSelect: (id: string) => void;
    selectionMode?: boolean;
    selected?: boolean;
  }) => (
    <button
      type="button"
      aria-label={`card-${flow.id}`}
      data-selection-mode={selectionMode ? 'yes' : 'no'}
      data-selected={selected ? 'yes' : 'no'}
      onClick={() => onSelect(flow.id)}
    >
      {flow.name}
    </button>
  ),
  FlowCardSkeleton: () => <div />,
}));

jest.mock('@/frontend/components/shared/ScrollNavCluster', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import FlowDashboard from '@/frontend/components/Flow/FlowDashboard/FlowDashboard';

const flow = (id: string): Flow => ({
  id,
  name: `Agent ${id}`,
  nodes: [{
    id: `${id}-node`,
    type: 'process',
    position: { x: 0, y: 0 },
    data: {
      label: 'AI step',
      type: 'process',
      properties: { boundModel: 'old', modelName: 'old-technical' },
    },
  }],
  edges: [],
});

describe('FlowDashboard quick model change', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: jest.fn(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () => String(input).includes('/api/model')
          ? [
              { id: 'old', name: 'old-technical', displayName: 'Old model', ApiKey: '' },
              { id: 'new', name: 'new-technical', displayName: 'New model', ApiKey: '' },
            ]
          : [],
      })),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('selects several cards and submits one model mapping for all of them', async () => {
    const onReplaceModels = jest.fn().mockResolvedValue({
      updatedFlowCount: 2,
      replacedNodeCount: 2,
      failedFlowCount: 0,
    });

    render(
      <FlowDashboard
        flows={[flow('one'), flow('two')]}
        selectedFlow={null}
        onSelectFlow={() => undefined}
        onDeleteFlow={() => undefined}
        onReplaceModels={onReplaceModels}
      />,
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Change models' }));
    fireEvent.click(screen.getByRole('button', { name: 'card-one' }));
    fireEvent.click(screen.getByRole('button', { name: 'card-two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change models (2)' }));

    fireEvent.mouseDown(await screen.findByLabelText('Replacement model'));
    fireEvent.click(await screen.findByRole('option', { name: 'New model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update agents' }));

    await waitFor(() => expect(onReplaceModels).toHaveBeenCalledWith(
      ['one', 'two'],
      { old: { id: 'new', name: 'new-technical' } },
    ));
  });
});
