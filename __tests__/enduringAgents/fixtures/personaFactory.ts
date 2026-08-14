import {
  createPersonaFromRole as createPersonaFromRoleProduction,
} from '@/backend/services/enduringAgents';
import { StorageKey } from '@/shared/types/storage';
import { saveItem } from '@/utils/storage/backend';

export async function createPersonaFromRole(
  ...args: Parameters<typeof createPersonaFromRoleProduction>
): Promise<Awaited<ReturnType<typeof createPersonaFromRoleProduction>>> {
  await saveItem(StorageKey.MODELS, [{
    id: 'model-test',
    name: 'test-model',
    displayName: 'Test model',
    provider: 'openai',
  }]);
  return createPersonaFromRoleProduction(...args);
}
