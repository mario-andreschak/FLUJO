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

// In-memory storage so saveFlow/deleteFlow do not touch disk. Flows are stored
// one-file-per-flow now, so provide the collection API too.
const store: Record<string, unknown> = {};
const collections: Record<string, Record<string, unknown>> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
  saveCollectionItem: jest.fn(async (c: string, id: string, val: unknown) => { (collections[c] ??= {})[id] = val; }),
  loadCollectionItem: jest.fn(async (c: string, id: string, fallback: unknown) =>
    (collections[c] && id in collections[c]) ? collections[c][id] : fallback),
  deleteCollectionItem: jest.fn(async (c: string, id: string) => { if (collections[c]) delete collections[c][id]; }),
  listCollectionItems: jest.fn(async (c: string) => Object.values(collections[c] ?? {})),
  assertSafeCollectionId: jest.fn((id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  }),
  migrateArrayFileToCollection: jest.fn(async () => 0),
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
  for (const k of Object.keys(collections)) delete collections[k];
  // flowService's cache + migration guard are global-backed; reset for isolation.
  (global as unknown as { __flujo_flowsCache: unknown }).__flujo_flowsCache = null;
  (global as unknown as { __flujo_flowsMigration: unknown }).__flujo_flowsMigration = undefined;
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
