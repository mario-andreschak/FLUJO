jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return {
    ...actual,
    migrateArrayFileToCollection: jest.fn(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }),
    listCollectionItemsWithStats: jest.fn(async () => {
      const { getCurrentWorkspace } = jest.requireActual('@/utils/workspace') as
        typeof import('@/utils/workspace');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const workspace = getCurrentWorkspace();
      return [{
        item: {
          id: 'same-flow-id',
          name: `flow-from-${workspace}`,
          nodes: [],
          edges: [],
        },
        mtimeMs: 1,
      }];
    }),
  };
});

import { FlowService } from '@/backend/services/flow';
import { runWithWorkspace } from '@/utils/workspace';
import { listCollectionItemsWithStats } from '@/utils/storage/backend';

describe('FlowService workspace cache', () => {
  it('loads and reuses independent snapshots for concurrent workspaces with identical flow ids', async () => {
    const service = new FlowService();
    const workspaceA = `flow-cache-a-${Date.now()}`;
    const workspaceB = `flow-cache-b-${Date.now()}`;

    const [flowsA, flowsB] = await Promise.all([
      runWithWorkspace(workspaceA, () => service.loadFlows()),
      runWithWorkspace(workspaceB, () => service.loadFlows()),
    ]);

    expect(flowsA).toEqual([
      expect.objectContaining({ id: 'same-flow-id', name: `flow-from-${workspaceA}` }),
    ]);
    expect(flowsB).toEqual([
      expect.objectContaining({ id: 'same-flow-id', name: `flow-from-${workspaceB}` }),
    ]);
    expect(listCollectionItemsWithStats).toHaveBeenCalledTimes(2);

    const [cachedA, cachedB] = await Promise.all([
      runWithWorkspace(workspaceA, () => service.loadFlows()),
      runWithWorkspace(workspaceB, () => service.loadFlows()),
    ]);
    expect(cachedA[0].name).toBe(`flow-from-${workspaceA}`);
    expect(cachedB[0].name).toBe(`flow-from-${workspaceB}`);
    expect(listCollectionItemsWithStats).toHaveBeenCalledTimes(2);
  });
});
