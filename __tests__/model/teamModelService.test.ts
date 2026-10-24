import { modelService } from '@/backend/services/model';
import { listTeamModels, resolveTeamModel } from '@/backend/services/model/teamCatalogue';
import { loadItem, saveItem } from '@/utils/storage/backend';
import type { Model } from '@/shared/types/model';

jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn(), saveItem: jest.fn() }));
jest.mock('@/backend/services/model/teamCatalogue', () => ({ listTeamModels: jest.fn(), resolveTeamModel: jest.fn() }));
jest.mock('@/backend/services/model/catalogAdmission', () => ({ withModelCatalogWriteLease: (task: () => unknown) => task() }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), verbose: jest.fn() }) }));

const privateModel: Model = { id: 'private-model', name: 'Private', ApiKey: 'private-value' };
const sharedModel: Model = { id: `team-model:${'t'.repeat(43)}:${'r'.repeat(43)}`, name: 'Shared', ApiKey: '',
  teamModel: { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), version: 1, generation: 'a'.repeat(64), teamName: 'Team' } };
beforeEach(() => {
  jest.clearAllMocks(); (loadItem as jest.Mock).mockResolvedValue([privateModel]);
  (listTeamModels as jest.Mock).mockResolvedValue({ models: [sharedModel], unavailable: false });
  (resolveTeamModel as jest.Mock).mockResolvedValue(sharedModel);
});

it('lists available models for selection while keeping private editing and storage separate', async () => {
  expect(await modelService.listModels()).toMatchObject({ success: true, models: [privateModel, sharedModel] });
  (listTeamModels as jest.Mock).mockClear();
  expect(await modelService.listModels(false)).toMatchObject({ success: true, models: [privateModel] });
  expect(listTeamModels).not.toHaveBeenCalled();
  expect(await modelService.loadModels()).toEqual([privateModel]);
  expect((await modelService.addModel(sharedModel)).success).toBe(false);
  expect((await modelService.updateModel(sharedModel)).success).toBe(false);
  expect((await modelService.deleteModel(sharedModel.id)).success).toBe(false);
  expect(saveItem).not.toHaveBeenCalled();
});

it('reports a partial catalogue without losing private models and never privately resolves a revoked team ID', async () => {
  (listTeamModels as jest.Mock).mockResolvedValue({ models: [], unavailable: true });
  expect(await modelService.listModels()).toMatchObject({ models: [privateModel], sharedModelsUnavailable: true });
  (loadItem as jest.Mock).mockResolvedValue([{ ...privateModel, id: sharedModel.id }]);
  (resolveTeamModel as jest.Mock).mockRejectedValue(new Error('Permission ended'));
  expect(await modelService.getModel(sharedModel.id)).toBeNull();
  expect(saveItem).not.toHaveBeenCalled();
});

it('does not resolve an ambiguous public alias against a partial shared catalogue', async () => {
  (listTeamModels as jest.Mock).mockResolvedValue({ models: [], unavailable: true });
  expect(await modelService.generateChatCompletion({ modelIdentifier: 'Private', messages: [{ role: 'user', content: 'hello' }] }))
    .toMatchObject({ success: false, statusCode: 503, error: { code: 'model_catalogue_unavailable' } });
});
