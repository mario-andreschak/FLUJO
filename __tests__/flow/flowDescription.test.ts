/**
 * Regression test for Issue #70 — a Flow carries an optional `description`.
 *
 * The feature is UI-facing (a Description field in the FlowBuilder toolbar and
 * rendering on the Flow Card), but the load-bearing guarantee is that the new
 * optional field round-trips through the flow persistence layer untouched (the
 * whole Flow object is stored/re-read, no field allow-listing). This drives the
 * real REST route handlers + backend service against in-memory storage.
 */
import type { Flow } from '@/shared/types/flow';

// In-memory storage so the backend service never touches disk.
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
}));

// saveFlow/deleteFlow lazily import the execution engine to invalidate its
// cache; stub it so the test does not pull in the real execution layer.
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { clearFlowCache: jest.fn() },
}));

import { POST as createFlow } from '@/app/api/flow/route';
import { GET as getFlow, PUT as putFlow } from '@/app/api/flow/[id]/route';
import { flowService } from '@/backend/services/flow';

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
  (flowService as unknown as { flowsCache: Flow[] | null }).flowsCache = null;
});

describe('Flow description (#70)', () => {
  it('persists the description on create and returns it on read', async () => {
    const description = 'Summarizes incoming tickets and routes them. Free-form: spaces, punctuation!';
    const res = await createFlow(req(flowFixture({ description })));
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ id: 'f1', description });

    const read = await getFlow(req(), ctx('f1'));
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ id: 'f1', description });
  });

  it('treats description as optional (flows without one still work)', async () => {
    const res = await createFlow(req(flowFixture()));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.description).toBeUndefined();
  });

  it('updates the description via PUT and re-reads the new value', async () => {
    await createFlow(req(flowFixture({ description: 'first' })));

    const res = await putFlow(req(flowFixture({ description: 'second' })), ctx('f1'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: 'f1', description: 'second' });

    const read = await getFlow(req(), ctx('f1'));
    await expect(read.json()).resolves.toMatchObject({ description: 'second' });
  });
});
