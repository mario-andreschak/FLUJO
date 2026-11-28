import {
  initialPersonaRuntimeRetentionState,
  type PersonaRuntimeRetentionState,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionControl';
import { StorageKey } from '@/shared/types/storage/storage';
import { saveItem } from '@/utils/storage/backend';

/**
 * Store a Persona history cleanup state in the current workspace, for example
 * `{ mode: 'active' }` for a workspace whose measuring week already passed.
 */
export async function storeRetentionState(
  overrides: Partial<PersonaRuntimeRetentionState> = {},
): Promise<void> {
  await saveItem(StorageKey.PERSONA_RUNTIME_RETENTION_STATE, {
    ...initialPersonaRuntimeRetentionState(),
    ...overrides,
  });
}
