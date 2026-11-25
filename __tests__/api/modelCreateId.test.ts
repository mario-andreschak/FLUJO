/**
 * #1350: POST /api/model without an `id` answered 201 and stored a model with
 * no id, which `/api/model/{id}` could then never edit or delete. Driven
 * through the real routes, model service and storage (Jest's throwaway data
 * folder): a new model always gets an id, and a model already stored without
 * one gets an id on the next load that is then written back.
 */
import { StorageKey } from '@/shared/types/storage';
import type { Model } from '@/shared/types/model';

jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/flow/defaultAgent', () => ({ adoptFirstModelForDefaultAgent: jest.fn(async () => false) }));
jest.mock('@/utils/storage/backend', () => {
  const actual = jest.requireActual('@/utils/storage/backend');
  return { ...actual, saveItem: jest.fn(actual.saveItem) };
});

import { GET as listModels, POST as createModel } from '@/app/api/model/route';
import { GET as getModel, PUT as putModel, DELETE as deleteModel } from '@/app/api/model/[id]/route';
import { modelService } from '@/backend/services/model';
import { withModelCatalogWriteLease } from '@/backend/services/model/catalogAdmission';
import { loadItem, saveItem } from '@/utils/storage/backend';
import { ensureWorkspaceDirs } from '@/utils/workspace';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The issue's own request body: no id.
const reported = {
  name: 'google/gemini-4-argon',
  displayName: 'Video Reviewer',
  provider: 'openrouter',
  adapter: 'openai',
  ApiKey: '${global:or_key}',
  baseUrl: 'https://openrouter.ai/api/v1',
};

const request = (body?: unknown) => ({ json: async () => body }) as never;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const stored = () => loadItem<Model[]>(StorageKey.MODELS, []);
const listed = async (): Promise<Model[]> => (await listModels(request())).json();

beforeEach(async () => {
  await ensureWorkspaceDirs();
  await saveItem(StorageKey.MODELS, []);
});
// A load may have started a write-back; let it finish before the next test.
afterEach(() => modelService.saveHealedModelIds());

describe('POST /api/model gives every new model an id', () => {
  it('makes a UUID when the body has none, returns it, and the model can be read, edited and deleted', async () => {
    const response = await createModel(request(reported));
    expect(response.status).toBe(201);
    const created: Model = await response.json();
    expect(created.id).toMatch(UUID);

    expect((await stored()).map(model => model.id)).toEqual([created.id]);
    expect((await listed()).map(model => model.id)).toEqual([created.id]);
    expect((await getModel(request(), ctx(created.id))).status).toBe(200);
    const edited = await putModel(request({ ...reported, displayName: 'Video Reviewer 2' }), ctx(created.id));
    expect(edited.status).toBe(200);
    expect((await deleteModel(request(), ctx(created.id))).status).toBe(204);
    expect(await stored()).toEqual([]);
  });

  it('keeps an id the caller chose', async () => {
    const response = await createModel(request({ ...reported, id: 'video-reviewer' }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: 'video-reviewer' });
  });

  it.each([
    ['empty', ''],
    ['a path', '../models'],
    ['with a space', 'video reviewer'],
    ['a number', 42],
    ['too long', 'a'.repeat(129)],
  ])('refuses an id that is %s with a plain 400 and saves nothing', async (_label, id) => {
    const response = await createModel(request({ ...reported, id }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringMatching(/^The id must be .+ Leave it out and FLUJO makes one\.$/),
    });
    expect(await stored()).toEqual([]);
  });

  it('refuses an id that is already taken with 409', async () => {
    await createModel(request({ ...reported, id: 'taken' }));
    const response = await createModel(request({ ...reported, id: 'taken', displayName: 'Other' }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'A model with the id "taken" already exists' });
    expect(await stored()).toHaveLength(1);
  });
});

describe('models stored without an id heal on load', () => {
  it('lists the model with a stable id, writes it back, and the model can be deleted again', async () => {
    await saveItem(StorageKey.MODELS, [reported]);

    const [first] = await listed();
    expect(first.id).toMatch(UUID);
    expect((await listed())[0].id).toBe(first.id);

    await modelService.saveHealedModelIds();
    expect(await stored()).toEqual([{ ...reported, id: first.id }]);

    expect((await getModel(request(), ctx(first.id))).status).toBe(200);
    expect((await deleteModel(request(), ctx(first.id))).status).toBe(204);
    expect(await stored()).toEqual([]);
  });

  it('gives two identical records different ids and keeps the ids already there', async () => {
    await saveItem(StorageKey.MODELS, [reported, { ...reported, id: 'kept' }, reported]);
    const ids = (await listed()).map(model => model.id);
    expect(ids[1]).toBe('kept');
    expect(new Set(ids).size).toBe(3);
  });

  it('a catalog edit saves the ids it was shown, even before the write-back ran', async () => {
    await saveItem(StorageKey.MODELS, [reported]);
    const [shown] = await listed();
    const response = await createModel(request({ ...reported, displayName: 'Second' }));
    expect(response.status).toBe(201);
    expect((await stored())[0].id).toBe(shown.id);
  });

  it('tries a failed write-back again a few seconds later, and reads keep working meanwhile', async () => {
    await saveItem(StorageKey.MODELS, [reported]);
    const write = jest.mocked(saveItem);
    write.mockClear();
    write.mockRejectedValueOnce(new Error('disk is busy'));
    const [shown] = await modelService.loadModels();
    await modelService.saveHealedModelIds();
    expect(write).toHaveBeenCalledTimes(1);
    expect((await stored())[0].id).toBeUndefined();

    expect((await modelService.loadModels())[0].id).toBe(shown.id);
    await modelService.saveHealedModelIds();
    expect(write).toHaveBeenCalledTimes(1);

    jest.spyOn(Date, 'now').mockReturnValueOnce(Date.now() + 6_000);
    await modelService.saveHealedModelIds();
    expect((await stored())[0].id).toBe(shown.id);
  });

  it('waits while the catalog is busy and writes the ids back on a later load', async () => {
    await saveItem(StorageKey.MODELS, [reported]);
    await withModelCatalogWriteLease(() => modelService.saveHealedModelIds());
    expect((await stored())[0].id).toBeUndefined();

    const [shown] = await modelService.loadModels();
    await modelService.saveHealedModelIds();
    expect((await stored())[0].id).toBe(shown.id);
  });
});
