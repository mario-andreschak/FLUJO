import { ModelHandler } from '@/backend/execution/flow/handlers/ModelHandler';
import { admitCatalogModel, withModelCatalogLease, withModelCatalogWriteLease } from '@/backend/services/model/catalogAdmission';
import { modelService } from '@/backend/services/model';
import { saveItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';

const mockAdapterCalled = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: (...args: unknown[]) => mockAdapterCalled(...args),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));

it('refuses a late owner-binding edit before credential resolution or adapter creation', async () => {
  const ordinary = { id: 'catalog-fence', name: 'ordinary', provider: 'openai' as const, adapter: 'openai' as const, ApiKey: 'encrypted:fixture' };
  await withModelCatalogWriteLease(() => saveItem(StorageKey.MODELS, [ordinary]));
  const admission = await withModelCatalogLease(() => admitCatalogModel(ordinary.id));
  await withModelCatalogWriteLease(() => saveItem(StorageKey.MODELS, [{
    ...ordinary,
    ownerCredentialBinding: { ownerId: 'owner-fixture', credentialId: 'credential-fixture' },
    ApiKey: '',
  }]));

  const key = jest.spyOn(modelService, 'resolveAndDecryptApiKey');
  const result = await ModelHandler.callModel({
    modelId: ordinary.id,
    modelCatalogAdmission: admission,
    prompt: 'No external send',
    messages: [{ id: 'user', role: 'user', content: 'Do not send', timestamp: 1 }],
    iteration: 1,
    maxIterations: 1,
    nodeId: 'process',
    nodeName: 'Process',
  });
  expect(result.success).toBe(false);
  expect(result.success ? '' : result.error.message).toContain('execution_model_catalog_changed');
  expect(key).not.toHaveBeenCalled();
  expect(mockAdapterCalled).not.toHaveBeenCalled();
});
