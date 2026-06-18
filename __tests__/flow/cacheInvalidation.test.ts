/**
 * Regression test for stale node/model names in the status bar.
 *
 * The execution engine caches the compiled flow per flowId forever. Saving an
 * edited flow updated flowService's own cache but never invalidated the engine's
 * compiled-flow cache, so renamed nodes/models kept showing old names until the
 * process restarted. flowService.saveFlow/deleteFlow must invalidate it.
 */
import type { Flow } from '@/shared/types/flow';

// Capture engine cache-clear calls without loading the real execution layer.
const clearFlowCache = jest.fn();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { clearFlowCache: (...a: unknown[]) => clearFlowCache(...a) },
}));

// In-memory storage so saveFlow/deleteFlow do not touch disk.
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
}));

import { FlowService } from '@/backend/services/flow';

const flowFixture = (id: string, name: string): Flow => ({
  id,
  name,
  nodes: [{ id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start Node', type: 'start', properties: {} } }],
  edges: [],
} as unknown as Flow);

beforeEach(() => {
  clearFlowCache.mockClear();
  for (const k of Object.keys(store)) delete store[k];
});

describe('flowService cache invalidation', () => {
  it('invalidates the engine flow cache when a flow is saved', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('flow-abc', 'Original'));
    expect(clearFlowCache).toHaveBeenCalledWith('flow-abc');
  });

  it('invalidates the engine flow cache when a flow is updated (rename)', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('flow-abc', 'Original'));
    clearFlowCache.mockClear();
    await svc.saveFlow(flowFixture('flow-abc', 'Renamed'));
    expect(clearFlowCache).toHaveBeenCalledWith('flow-abc');
  });

  it('invalidates the engine flow cache when a flow is deleted', async () => {
    const svc = new FlowService();
    await svc.saveFlow(flowFixture('flow-xyz', 'ToDelete'));
    clearFlowCache.mockClear();
    await svc.deleteFlow('flow-xyz');
    expect(clearFlowCache).toHaveBeenCalledWith('flow-xyz');
  });
});
