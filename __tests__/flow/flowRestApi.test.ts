/**
 * Regression test for the Flow REST API.
 *
 * The flow HTTP surface was reworked from an action-based dispatcher
 * (`GET ?action=listFlows|getFlow` + `POST { action: 'addFlow' | 'updateFlow' |
 * 'deleteFlow' | ... }`) into standard REST resource routing:
 *
 *   GET    /api/flow        -> list
 *   POST   /api/flow        -> create (body = Flow; 409 on duplicate id)
 *   GET    /api/flow/{id}   -> read
 *   PUT    /api/flow/{id}   -> update (path id authoritative; 404 if missing)
 *   DELETE /api/flow/{id}   -> delete (204)
 *
 * These tests drive the real route handlers + backend service against in-memory
 * storage, asserting status codes, the create/read/update/delete cycle, that the
 * path id wins on PUT, and the 404/409 edge cases.
 */
import type { Flow } from '@/shared/types/flow';

// In-memory storage so the backend service never touches disk.
const store: Record<string, unknown> = {};
// Flows are stored one-file-per-flow (db/flows/<id>.json); model the collection
// API in memory so the real flowService round-trips without touching disk.
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

// saveFlow/deleteFlow lazily import the execution engine to invalidate its cache;
// stub it so the test does not pull in the real execution layer.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { clearFlowCache: jest.fn() },
}));

import { GET as listFlows, POST as createFlow } from '@/app/api/flow/route';
import { GET as getFlow, PUT as putFlow, DELETE as deleteFlow } from '@/app/api/flow/[id]/route';
import { flowService } from '@/backend/services/flow';

// The handlers only call request.json(); a minimal stub stands in for NextRequest.
const req = (body?: unknown) => ({ json: async () => body }) as any;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const flowFixture = (over: Partial<Flow> = {}): Flow => ({
  id: 'f1',
  name: 'My Flow',
  nodes: [{ id: 'n1', type: 'start', position: { x: 0, y: 0 }, data: { label: 'Start Node', type: 'start', properties: {} } }],
  edges: [],
  ...over,
} as unknown as Flow);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(collections)) delete collections[k];
  // flowService is a singleton with a global-backed cache + migration guard;
  // reset them so tests are isolated.
  (flowService as unknown as { flowsCache: Flow[] | null }).flowsCache = null;
  (global as unknown as { __flujo_flowsMigration: unknown }).__flujo_flowsMigration = undefined;
});

describe('Flow REST API', () => {
  it('GET /api/flow returns an empty list initially', async () => {
    const res = await listFlows();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it('POST /api/flow creates a flow (201) and returns it', async () => {
    const res = await createFlow(req(flowFixture()));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.id).toBe('f1');
    expect(created.name).toBe('My Flow');

    const afterList = await listFlows();
    await expect(afterList.json()).resolves.toHaveLength(1);
  });

  it('POST /api/flow rejects a missing id with 400', async () => {
    const res = await createFlow(req(flowFixture({ id: undefined })));
    expect(res.status).toBe(400);
  });

  it('POST /api/flow rejects a duplicate id with 409', async () => {
    await createFlow(req(flowFixture()));
    const res = await createFlow(req(flowFixture({ name: 'Other' })));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toHaveProperty('error');
  });

  it('GET /api/flow/{id} reads a flow, 404 when missing', async () => {
    await createFlow(req(flowFixture()));

    const ok = await getFlow(req(), ctx('f1'));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ id: 'f1', name: 'My Flow' });

    const missing = await getFlow(req(), ctx('nope'));
    expect(missing.status).toBe(404);
  });

  it('PUT /api/flow/{id} returns 404 for an unknown flow', async () => {
    const res = await putFlow(req(flowFixture({ id: 'ghost', name: 'Created via PUT' })), ctx('ghost'));
    expect(res.status).toBe(404);
  });

  it('PUT /api/flow/{id} updates an existing flow with 200 and path id wins', async () => {
    await createFlow(req(flowFixture()));

    // Body carries a conflicting id; the path segment must win.
    const res = await putFlow(req(flowFixture({ id: 'WRONG', name: 'Renamed' })), ctx('f1'));
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.id).toBe('f1');
    expect(updated.name).toBe('Renamed');

    // 'WRONG' was never persisted.
    const wrong = await getFlow(req(), ctx('WRONG'));
    expect(wrong.status).toBe(404);
  });

  it('DELETE /api/flow/{id} removes the flow (204), 404 when missing', async () => {
    await createFlow(req(flowFixture()));

    const del = await deleteFlow(req(), ctx('f1'));
    expect(del.status).toBe(204);

    const afterList = await listFlows();
    await expect(afterList.json()).resolves.toEqual([]);

    const delAgain = await deleteFlow(req(), ctx('f1'));
    expect(delAgain.status).toBe(404);
  });
});
