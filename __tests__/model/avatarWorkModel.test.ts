import type { Model } from '@/shared/types/model';
const values = new Map<string, unknown>();
let workspace = 'one';
jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key, fallback) => values.get(`${workspace}:${key}`) ?? fallback),
  saveItem: jest.fn(async (key, value) => { values.set(`${workspace}:${key}`, value); }),
}));
import { readAvatarWorkModel, selectVerifiedAvatarWorkModel } from '@/backend/services/avatar/workModel';
describe('verified avatar work preference', () => {
  const model: Model = { id: 'brain', name: 'sonnet', ApiKey: 'SECRET', supportsTools: true };
  beforeEach(() => { values.clear(); workspace = 'one'; });
  it('invalidates verification when credentials, adapter, or model configuration changes', async () => {
    await selectVerifiedAvatarWorkModel(model);
    expect(await readAvatarWorkModel([model])).toMatchObject({ modelId: 'brain', ready: true });
    for (const changed of [{ ...model, ApiKey: 'CHANGED' }, { ...model, name: 'opus' }, { ...model, adapter: 'claude-cli' as const }, { ...model, supportsTools: false }]) {
      expect(await readAvatarWorkModel([changed])).toMatchObject({ ready: false });
    }
    expect(JSON.stringify(await readAvatarWorkModel([model]))).not.toMatch(/SECRET|fingerprint/);
  });
  it('does not carry another workspace preference or resurrect a deleted model', async () => {
    await selectVerifiedAvatarWorkModel(model);
    expect(await readAvatarWorkModel([])).toBeNull();
    workspace = 'two';
    expect(await readAvatarWorkModel([model])).toBeNull();
  });
});
