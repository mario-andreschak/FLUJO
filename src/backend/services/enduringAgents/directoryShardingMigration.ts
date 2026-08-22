import { promises as fs } from 'fs';
import path from 'path';

import {
  migrateLegacyCollectionItem,
  type PersonaShardedCollection,
  writeFileAtomic,
} from '@/utils/storage/backend';
import { getWorkspaceDbDir } from '@/utils/workspace';

import { ENDURING_AGENT_COLLECTIONS } from './collections';
import {
  getActivityIndex,
  getLeaseHistoryIndex,
  getMailboxIndex,
  getMemoryIndex,
  getWorkItemIndex,
  type IndexEntry,
} from './indexing';
import { withWorkspaceRuntimeLock } from './runtimeLock';

const MIGRATION_ID = 'enduring-agent-directory-sharding-v2';
const MIGRATION_VERSION = 2 as const;

type MigrationPhase = 'planned' | 'source-removed' | 'conflict';

interface MigrationEntry {
  collection: PersonaShardedCollection;
  personaId: string;
  recordId: string;
  phase: MigrationPhase;
  error?: string;
}

interface DirectoryShardingMigrationState {
  recordKind: 'EnduringAgentDirectoryShardingMigration';
  migrationId: typeof MIGRATION_ID;
  version: typeof MIGRATION_VERSION;
  status: 'in-progress' | 'completed' | 'conflict';
  updatedAt: number;
  entries: Record<string, MigrationEntry>;
}

function statePath(): string {
  return path.join(getWorkspaceDbDir(), `${MIGRATION_ID}.json`);
}

function emptyState(): DirectoryShardingMigrationState {
  return {
    recordKind: 'EnduringAgentDirectoryShardingMigration',
    migrationId: MIGRATION_ID,
    version: MIGRATION_VERSION,
    status: 'in-progress',
    updatedAt: 0,
    entries: {},
  };
}

async function loadState(): Promise<DirectoryShardingMigrationState> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(statePath(), 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Directory-sharding migration state is malformed.');
  }
  const state = value as Partial<DirectoryShardingMigrationState>;
  if (
    state.recordKind !== 'EnduringAgentDirectoryShardingMigration'
    || state.migrationId !== MIGRATION_ID
    || state.version !== MIGRATION_VERSION
    || !['in-progress', 'completed', 'conflict'].includes(state.status ?? '')
    || !state.entries
    || typeof state.entries !== 'object'
    || Array.isArray(state.entries)
  ) {
    throw new Error('Directory-sharding migration state is malformed.');
  }
  return state as DirectoryShardingMigrationState;
}

async function saveState(state: DirectoryShardingMigrationState): Promise<void> {
  state.updatedAt = Date.now();
  await writeFileAtomic(statePath(), JSON.stringify(state, null, 2));
}

function entryKey(collection: PersonaShardedCollection, recordId: string): string {
  return `${collection}/${recordId}`;
}

async function indexedEntries(): Promise<Array<{
  collection: PersonaShardedCollection;
  entry: IndexEntry;
}>> {
  const [memories, mailbox, workItems, activities, leaseHistory] = await Promise.all([
    getMemoryIndex(),
    getMailboxIndex(),
    getWorkItemIndex(),
    getActivityIndex(),
    getLeaseHistoryIndex(),
  ]);
  return [
    ...memories.entries.map((entry) => ({
      collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
      entry,
    })),
    ...mailbox.entries.map((entry) => ({
      collection: ENDURING_AGENT_COLLECTIONS.mailboxItems,
      entry,
    })),
    ...workItems.entries.map((entry) => ({
      collection: ENDURING_AGENT_COLLECTIONS.workItems,
      entry,
    })),
    ...activities.entries.map((entry) => ({
      collection: ENDURING_AGENT_COLLECTIONS.activities,
      entry,
    })),
    ...leaseHistory.entries.map((entry) => ({
      collection: ENDURING_AGENT_COLLECTIONS.leaseHistory,
      entry,
    })),
  ].sort((left, right) => (
    left.collection.localeCompare(right.collection)
    || left.entry.id.localeCompare(right.entry.id)
  ));
}

/**
 * Relocate the five Persona-owned record collections before runtime writers
 * start. The durable journal is intentionally independent from record schema
 * migrations: it records filesystem progress and can recover a crash after the
 * destination write but before legacy cleanup.
 */
export function migrateEnduringAgentDirectoryShards(): Promise<void> {
  return withWorkspaceRuntimeLock(MIGRATION_ID, async (lock) => {
    const state = await loadState();
    if (state.status === 'completed') return;

    const records = await indexedEntries();
    state.status = 'in-progress';
    await lock.assertOwned();
    await saveState(state);

    for (const { collection, entry } of records) {
      const key = entryKey(collection, entry.id);
      const prior = state.entries[key];
      if (prior?.phase === 'source-removed') continue;
      state.entries[key] = {
        collection,
        personaId: entry.personaId,
        recordId: entry.id,
        phase: 'planned',
      };
      await lock.assertOwned();
      await saveState(state);

      try {
        const result = await migrateLegacyCollectionItem(
          collection,
          entry.personaId,
          entry.id,
        );
        if (result === 'missing') {
          throw new Error(
            `Indexed ${collection} record ${JSON.stringify(entry.id)} is missing from both layouts.`,
          );
        }
        state.entries[key] = {
          collection,
          personaId: entry.personaId,
          recordId: entry.id,
          phase: 'source-removed',
        };
        await lock.assertOwned();
        await saveState(state);
      } catch (error) {
        state.status = 'conflict';
        state.entries[key] = {
          collection,
          personaId: entry.personaId,
          recordId: entry.id,
          phase: 'conflict',
          error: error instanceof Error ? error.message : String(error),
        };
        await lock.assertOwned();
        await saveState(state);
        throw error;
      }
    }

    state.status = 'completed';
    await lock.assertOwned();
    await saveState(state);
  });
}
