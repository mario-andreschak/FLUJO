import { promises as fs } from 'fs';
import path from 'path';

import { migrateEnduringAgentDirectoryShards } from '@/backend/services/enduringAgents/directoryShardingMigration';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  PersonaShardCollisionError,
  deleteShardedCollectionItem,
  getLegacyCollectionItemPath,
  getShardedCollectionItemPath,
  loadShardedCollectionItem,
  saveCollectionItem,
  saveShardedCollectionItem,
  type PersonaShardedCollection,
} from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T | Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `directory-sharding-${process.pid}-${workspaceSequence}`,
    async () => await task(),
  );
}

type TestRecord = {
  id: string;
  personaId: string;
  updatedAt: number;
  status?: string;
  payload: string;
};

function record(
  collection: PersonaShardedCollection,
  personaId: string,
  id: string,
  payload = id,
): TestRecord {
  return {
    id,
    personaId,
    updatedAt: 1,
    ...(collection === ENDURING_AGENT_COLLECTIONS.memoryItems ? { status: 'active' } : {}),
    ...(collection === ENDURING_AGENT_COLLECTIONS.mailboxItems ? { status: 'queued' } : {}),
    payload,
  };
}

const COLLECTIONS: PersonaShardedCollection[] = [
  ENDURING_AGENT_COLLECTIONS.memoryItems,
  ENDURING_AGENT_COLLECTIONS.mailboxItems,
  ENDURING_AGENT_COLLECTIONS.workItems,
  ENDURING_AGENT_COLLECTIONS.activities,
];

describe('Enduring Agent Persona directory sharding', () => {
  it('writes, reads, and deletes a Persona-owned record in its shard', async () => {
    await inFreshWorkspace(async () => {
      const value = record(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        'persona_a',
        'memory_a',
      );

      await saveShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        value.personaId,
        value.id,
        value,
      );

      await expect(loadShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        value.personaId,
        value.id,
        null,
      )).resolves.toEqual(value);
      await expect(fs.access(getShardedCollectionItemPath(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        value.personaId,
        value.id,
      ))).resolves.toBeUndefined();

      await deleteShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        value.personaId,
        value.id,
      );
      await expect(loadShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        value.personaId,
        value.id,
        null,
      )).resolves.toBeNull();
    });
  });

  it('falls back to a flat record but fails closed for the wrong Persona', async () => {
    await inFreshWorkspace(async () => {
      const value = record(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        'persona_a',
        'mailbox_a',
      );
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        value.id,
        value,
      );

      await expect(loadShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        value.personaId,
        value.id,
        null,
      )).resolves.toEqual(value);
      await expect(loadShardedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        'persona_b',
        value.id,
        null,
      )).rejects.toThrow('does not match requested Persona');
    });
  });

  it('migrates all four collections and is idempotent', async () => {
    await inFreshWorkspace(async () => {
      const values = COLLECTIONS.map((collection, index) => ({
        collection,
        value: record(collection, `persona_${index % 2}`, `record_${index}`),
      }));
      for (const { collection, value } of values) {
        await saveCollectionItem(collection, value.id, value);
      }

      await migrateEnduringAgentDirectoryShards();
      await migrateEnduringAgentDirectoryShards();

      for (const { collection, value } of values) {
        await expect(loadShardedCollectionItem(
          collection,
          value.personaId,
          value.id,
          null,
        )).resolves.toEqual(value);
        await expect(fs.access(getLegacyCollectionItemPath(
          collection,
          value.id,
        ))).rejects.toMatchObject({ code: 'ENOENT' });
      }

      const state = JSON.parse(await fs.readFile(path.join(
        getWorkspaceDataDir(),
        'db',
        'enduring-agent-directory-sharding-v1.json',
      ), 'utf8')) as { status: string };
      expect(state.status).toBe('completed');
    });
  });

  it('rejects conflicting flat and sharded copies without removing either', async () => {
    await inFreshWorkspace(async () => {
      const collection = ENDURING_AGENT_COLLECTIONS.activities;
      const flat = record(collection, 'persona_a', 'activity_a', 'flat');
      const sharded = record(collection, 'persona_a', 'activity_a', 'sharded');
      await saveCollectionItem(collection, flat.id, flat);
      const shardedPath = getShardedCollectionItemPath(
        collection,
        sharded.personaId,
        sharded.id,
      );
      await fs.mkdir(path.dirname(shardedPath), { recursive: true });
      await fs.writeFile(shardedPath, JSON.stringify(sharded, null, 2));

      await expect(migrateEnduringAgentDirectoryShards())
        .rejects.toBeInstanceOf(PersonaShardCollisionError);
      await expect(fs.access(getLegacyCollectionItemPath(collection, flat.id)))
        .resolves.toBeUndefined();
      await expect(fs.access(shardedPath)).resolves.toBeUndefined();
    });
  });
});
