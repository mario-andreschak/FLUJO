import {
  assertSafeCollectionId,
  listCollectionItemEntriesStrict,
  loadCollectionItem,
  runInWriteChain,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { getCurrentWorkspace } from '@/utils/workspace';

import { ENDURING_AGENT_COLLECTIONS } from './collections';
import { PersonaFlowDispatchRecordSchema } from './personaFlowDispatchSchema';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';

function parseStoredDispatch(
  id: string,
  value: unknown,
  workspaceId: string,
): PersonaFlowDispatchRecord {
  const record = PersonaFlowDispatchRecordSchema.parse(value) as PersonaFlowDispatchRecord;
  if (record.id !== id || record.workspaceId !== workspaceId) {
    throw new Error(
      `PersonaFlowDispatchRecord ${JSON.stringify(id)} has mismatched storage identity or workspace.`,
    );
  }
  return record;
}

/**
 * Strict lower-level scan used by retention. Flow dispatches are workspace-wide,
 * so filter only after every stored envelope has passed schema and identity
 * validation.
 */
export async function listPersonaFlowDispatchRecordsForRetention(
  personaId: string,
): Promise<PersonaFlowDispatchRecord[]> {
  assertSafeCollectionId(personaId);
  const workspaceId = getCurrentWorkspace();
  const entries = await listCollectionItemEntriesStrict<unknown>(
    ENDURING_AGENT_COLLECTIONS.flowDispatches,
  );
  return entries
    .map(({ id, item }) => parseStoredDispatch(id, item, workspaceId))
    .filter((record) => record.personaId === personaId)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

/**
 * Persist a compacted terminal envelope without notifying dispatcher waiters.
 * Retention is maintenance, not a second lifecycle transition.
 */
export function savePersonaFlowDispatchForRetention(
  value: PersonaFlowDispatchRecord,
): Promise<PersonaFlowDispatchRecord> {
  const record = PersonaFlowDispatchRecordSchema.parse(value) as PersonaFlowDispatchRecord;
  const workspaceId = getCurrentWorkspace();
  if (record.workspaceId !== workspaceId) {
    throw new Error(
      `PersonaFlowDispatchRecord ${JSON.stringify(record.id)} belongs to another workspace.`,
    );
  }
  assertSafeCollectionId(record.id);
  return runInWriteChain(
    `enduring-agent:${ENDURING_AGENT_COLLECTIONS.flowDispatches}/${record.id}`,
    async () => {
      const existingValue = await loadCollectionItem<unknown | null>(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
        record.id,
        null,
      );
      if (existingValue === null) {
        throw new Error(
          `Cannot compact missing PersonaFlowDispatchRecord ${JSON.stringify(record.id)}.`,
        );
      }
      const existing = parseStoredDispatch(record.id, existingValue, workspaceId);
      if (
        existing.personaId !== record.personaId
        || existing.createdAt !== record.createdAt
        || existing.updatedAt !== record.updatedAt
        || existing.state !== record.state
      ) {
        throw new Error('PersonaFlowDispatchRecord changed during retention compaction.');
      }
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.flowDispatches,
        record.id,
        record,
      );
      return record;
    },
  );
}
