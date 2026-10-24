import { admitCatalogModel, assertCatalogAdmissionCurrent } from '@/backend/services/model/catalogAdmission';
import { resolveTeamModel } from '@/backend/services/model/teamCatalogue';
import { loadItem } from '@/utils/storage/backend';
import { teamModelBaseUrl, teamModelId } from '../../packages/shared-controller/src/shared-model';
import type { Model } from '@/shared/types/model';

jest.mock('@/backend/services/model/teamCatalogue', () => ({ resolveTeamModel: jest.fn() }));
jest.mock('@/utils/storage/backend', () => ({ loadItem: jest.fn() }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => '/fixture-unused' }));
jest.mock('@/backend/execution/extensions', () => ({ ExecutionExtensionError: class extends Error {} }));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withModelCatalogFilesystemLease: jest.fn(), withModelCatalogFilesystemWriteLease: jest.fn(), assertModelCatalogFilesystemLeaseOwned: jest.fn(),
}));
const reference = { teamId: 't'.repeat(43), resourceId: 'r'.repeat(43), version: 1, generation: 'a'.repeat(64), teamName: 'Offline team' };
const model: Model = { id: teamModelId(reference), name: 'local', ApiKey: '', provider: 'ollama', adapter: 'openai',
  baseUrl: teamModelBaseUrl(reference), teamModel: reference, promptTemplate: 'Shared prompt' };
beforeEach(() => { jest.clearAllMocks(); (resolveTeamModel as jest.Mock).mockResolvedValue(model); });

it('admits a detached shared configuration and checks current authority without reading private storage', async () => {
  const admission = await admitCatalogModel(model.id);
  expect(admission.generation).toBe(`team:${reference.generation}`); expect(Object.isFrozen(admission.model)).toBe(true);
  await assertCatalogAdmissionCurrent(admission); expect(loadItem).not.toHaveBeenCalled();
  const changed = { ...reference, generation: 'b'.repeat(64) };
  (resolveTeamModel as jest.Mock).mockResolvedValue({ ...model, baseUrl: teamModelBaseUrl(changed), teamModel: changed });
  await expect(assertCatalogAdmissionCurrent(admission)).rejects.toThrow('execution_model_catalog_changed');
});

it('refuses an unavailable shared model instead of resolving a same-ID private record', async () => {
  (resolveTeamModel as jest.Mock).mockRejectedValue(new Error('Shared permission ended'));
  (loadItem as jest.Mock).mockResolvedValue([{ ...model, teamModel: undefined, ApiKey: 'private-key' }]);
  await expect(admitCatalogModel(model.id)).rejects.toThrow('Shared permission ended');
  expect(loadItem).not.toHaveBeenCalled();
});
