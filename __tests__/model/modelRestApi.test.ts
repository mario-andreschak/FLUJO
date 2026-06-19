/**
 * Regression test for the Model REST API.
 *
 * The model HTTP surface was reworked from an action-based POST dispatcher
 * (`{ action: 'addModel' | 'updateModel' | 'deleteModel' }` + `?id=` query params)
 * into standard REST resource routing:
 *
 *   GET    /api/model        -> list
 *   POST   /api/model        -> create (body = Model)
 *   GET    /api/model/{id}   -> read
 *   PUT    /api/model/{id}   -> update (path id authoritative)
 *   DELETE /api/model/{id}   -> delete (204)
 *
 * These tests drive the real route handlers + adapter + backend service against
 * in-memory storage, asserting status codes, the create/read/update/delete cycle,
 * that the path id wins on PUT, and that API keys are masked on the way out.
 */
import type { Model } from '@/shared/types/model';

// In-memory storage so the backend service never touches disk.
const store: Record<string, unknown> = {};
jest.mock('@/utils/storage/backend', () => ({
  saveItem: jest.fn(async (key: string, val: unknown) => { store[key] = val; }),
  loadItem: jest.fn(async (key: string, fallback: unknown) => (key in store ? store[key] : fallback)),
}));

// Deterministic, crypto-free encryption so we can assert key handling without key setup.
jest.mock('@/backend/services/model/encryption', () => ({
  encryptApiKey: jest.fn(async (k: string) => `encrypted:${k}`),
  decryptApiKey: jest.fn(async (k: string) => k),
  resolveAndDecryptApiKey: jest.fn(async (k: string) => k),
  isEncryptionConfigured: jest.fn(async () => true),
  isUserEncryptionEnabled: jest.fn(async () => false),
  setEncryptionKey: jest.fn(async () => ({ success: true })),
  initializeDefaultEncryption: jest.fn(async () => true),
}));

import { GET as listModels, POST as createModel } from '@/app/api/model/route';
import { GET as getModel, PUT as updateModel, DELETE as deleteModel } from '@/app/api/model/[id]/route';
import { MASKED_API_KEY } from '@/shared/types/constants';

// The handlers only call request.json(); a minimal stub stands in for NextRequest.
const req = (body?: unknown) => ({ json: async () => body }) as any;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const modelFixture = (over: Partial<Model> = {}): Model => ({
  id: 'm1',
  name: 'gpt-test',
  displayName: 'GPT Test',
  provider: 'openai',
  ApiKey: 'sk-secret-123',
  baseUrl: 'https://api.openai.com/v1',
  ...over,
} as unknown as Model);

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('Model REST API', () => {
  it('GET /api/model returns an empty list initially', async () => {
    const res = await listModels();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it('POST /api/model creates a model (201) and masks the API key', async () => {
    const res = await createModel(req(modelFixture()));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.id).toBe('m1');
    // The real key must never leave the server.
    expect(created.ApiKey).toBe(MASKED_API_KEY);
  });

  it('rejects a duplicate technical name with 409', async () => {
    await createModel(req(modelFixture()));
    const res = await createModel(req(modelFixture({ id: 'm2', displayName: 'Other' })));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toHaveProperty('error');
  });

  it('GET /api/model/{id} reads a model, 404 when missing', async () => {
    await createModel(req(modelFixture()));

    const ok = await getModel(req(), ctx('m1'));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ id: 'm1', displayName: 'GPT Test' });

    const missing = await getModel(req(), ctx('nope'));
    expect(missing.status).toBe(404);
  });

  it('PUT /api/model/{id} updates and treats the path id as authoritative', async () => {
    await createModel(req(modelFixture()));

    // Body carries a conflicting id; the path segment must win.
    const res = await updateModel(
      req(modelFixture({ id: 'WRONG', displayName: 'Renamed' })),
      ctx('m1'),
    );
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.id).toBe('m1');
    expect(updated.displayName).toBe('Renamed');

    // 'WRONG' was never persisted.
    const wrong = await getModel(req(), ctx('WRONG'));
    expect(wrong.status).toBe(404);
  });

  it('PUT /api/model/{id} returns 404 for an unknown model', async () => {
    const res = await updateModel(req(modelFixture({ id: 'ghost' })), ctx('ghost'));
    expect(res.status).toBe(404);
  });

  it('DELETE /api/model/{id} removes the model (204), 404 when missing', async () => {
    await createModel(req(modelFixture()));

    const del = await deleteModel(req(), ctx('m1'));
    expect(del.status).toBe(204);

    const afterList = await listModels();
    await expect(afterList.json()).resolves.toEqual([]);

    const delAgain = await deleteModel(req(), ctx('m1'));
    expect(delAgain.status).toBe(404);
  });
});
