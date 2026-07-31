import type { Flow } from '@/shared/types/flow';
import { FlowService } from '@/backend/services/flow';

const processNode = {
  id: 'p', type: 'process', position: { x: 0, y: 0 },
  data: { label: 'Process', type: 'process', properties: {} },
};
const existing: Flow = { id: 'parent', name: 'Parent', updatedAt: 10, nodes: [processNode], edges: [] };
const child: Flow = {
  id: 'child', name: 'Child', nodes: [processNode], edges: [],
};
const parentDraft: Flow = {
  id: 'parent', name: 'Parent', updatedAt: 10,
  nodes: [{
    id: 'p', type: 'subflow', position: { x: 0, y: 0 },
    data: { label: 'Child', type: 'subflow', properties: { subflowId: 'child' } },
  }],
  edges: [],
};

function serviceWithExistingParent() {
  const service = new FlowService();
  jest.spyOn(service, 'getFlow').mockImplementation(async id => id === 'parent' ? existing : null);
  return service;
}

describe('FlowService.convertProcessToSubflow', () => {
  afterEach(() => jest.restoreAllMocks());

  it('writes the child before the rewritten parent', async () => {
    const service = serviceWithExistingParent();
    const save = jest.spyOn(service, 'saveFlow').mockResolvedValue({ success: true });

    const result = await service.convertProcessToSubflow(parentDraft, child, 'p', 10);

    expect(result.success).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0].id).toBe('child');
    expect(save.mock.calls[1][0].id).toBe('parent');
  });

  it('does not touch the parent when child creation fails', async () => {
    const service = serviceWithExistingParent();
    const save = jest.spyOn(service, 'saveFlow').mockResolvedValue({ success: false, error: 'child failed' });
    const remove = jest.spyOn(service, 'deleteFlow').mockResolvedValue({ success: true });

    const result = await service.convertProcessToSubflow(parentDraft, child, 'p', 10);

    expect(result).toEqual({ success: false, error: 'child failed' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes the child and restores the captured parent when the parent save fails', async () => {
    const service = serviceWithExistingParent();
    const save = jest.spyOn(service, 'saveFlow')
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: 'parent failed' })
      .mockResolvedValueOnce({ success: true });
    const remove = jest.spyOn(service, 'deleteFlow').mockResolvedValue({ success: true });

    const result = await service.convertProcessToSubflow(parentDraft, child, 'p', 10);

    expect(result).toEqual({ success: false, error: 'parent failed' });
    expect(remove).toHaveBeenCalledWith('child');
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2][0]).toEqual(existing);
  });

  it('rejects an optimistic-concurrency mismatch before any write', async () => {
    const service = serviceWithExistingParent();
    const save = jest.spyOn(service, 'saveFlow');

    const result = await service.convertProcessToSubflow(parentDraft, child, 'p', 9);

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
