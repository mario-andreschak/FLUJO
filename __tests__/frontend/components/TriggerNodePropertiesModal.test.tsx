import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mockUseAskFlujo, mockUseAskFlujoPage } from '@/frontend/__tests__/mocks/askFlujoContext';

jest.mock('@/frontend/contexts/AskFlujoContext', () => ({
  useAskFlujo: mockUseAskFlujo,
  useAskFlujoPage: mockUseAskFlujoPage,
}));

import TriggerNodePropertiesModal from '@/frontend/components/Flow/FlowManager/FlowBuilder/Modals/TriggerNodePropertiesModal';
import { plannedExecutionsService } from '@/frontend/services/plannedExecutions';

jest.mock('@/frontend/services/plannedExecutions', () => ({
  plannedExecutionsService: {
    create: jest.fn(),
    update: jest.fn(),
    // SchedulePanel live-previews the next fire times from a 300ms debounced
    // timer. Whether that timer elapses before the test finishes depends on
    // machine load, so the stub must exist or the suite fails intermittently.
    // Mirrors the real Promise<{ valid, error?, nextRuns }> contract.
    previewSchedule: jest.fn().mockResolvedValue({ valid: true, nextRuns: [] }),
  },
}));

jest.mock('@/frontend/services/flow', () => ({
  flowService: {
    loadFlows: jest.fn().mockResolvedValue([]),
  },
}));

const create = plannedExecutionsService.create as jest.Mock;
const update = plannedExecutionsService.update as jest.Mock;

Object.defineProperty(global.crypto, 'randomUUID', {
  configurable: true,
  value: () => 'generated-execution-id',
});

const makeNode = (properties: Record<string, unknown> = {}): any => ({
  id: 'trigger-node',
  type: 'trigger',
  position: { x: 0, y: 0 },
  data: { label: 'Trigger', type: 'trigger', properties },
});

const renderModal = (node: any, onSave = jest.fn()) => {
  render(
    <TriggerNodePropertiesModal
      open
      node={node}
      flowId="flow-123"
      onClose={() => {}}
      onSave={onSave}
    />
  );
  return onSave;
};

describe('TriggerNodePropertiesModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a planned execution and persists its generated id into the node', async () => {
    create.mockResolvedValue({ success: true, execution: { id: 'unused-response-id' } });
    const onSave = renderModal(makeNode());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

    const createInput = create.mock.calls[0][0];
    const [, savedData] = onSave.mock.calls[0];
    expect(createInput.flowId).toBe('flow-123');
    expect(savedData.properties.executionId).toBe(createInput.id);
    expect(savedData.properties.trigger).toEqual({ type: 'schedule', cron: '0 9 * * *' });
  });

  it('updates the existing planned execution instead of creating a replacement', async () => {
    update.mockResolvedValue({ success: true, execution: { id: 'execution-123' } });
    const onSave = renderModal(makeNode({ executionId: 'execution-123', name: 'Existing' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(
      'execution-123',
      expect.objectContaining({ flowId: 'flow-123', name: 'Existing' })
    ));
    expect(create).not.toHaveBeenCalled();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1].properties.executionId).toBe('execution-123');
  });

  it('keeps the canvas node unchanged when planned-execution synchronization fails', async () => {
    create.mockResolvedValue({ success: false, error: 'Server rejected trigger' });
    const node = makeNode();
    const originalData = JSON.parse(JSON.stringify(node.data));
    const onSave = renderModal(node);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Server rejected trigger')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    expect(node.data).toEqual(originalData);
  });
});
