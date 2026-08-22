import { promises as fs } from 'fs';
import path from 'path';

import {
  deleteIndexedCollectionItem,
  getMemoryIndex,
  saveIndexedCollectionItem,
} from '@/backend/services/enduringAgents/indexing';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  type MemoryItem,
} from '@/shared/types/enduringAgent';
import { saveCollectionItem } from '@/utils/storage/backend';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T | Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `persona-record-index-${process.pid}-${workspaceSequence}`,
    async () => await task(),
  );
}

function memory(id: string, personaId: string, updatedAt: number): MemoryItem {
  return MemoryItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id,
    personaId,
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content: `Memory ${id}`,
    confidence: 1,
    importance: 1,
    sourceRefs: [{ kind: 'user_statement', id: `source-${id}` }],
    trust: 'explicit_user',
    createdAt: 1,
    updatedAt,
  });
}

function memoryIndexPath(): string {
  return path.join(getWorkspaceDataDir(), 'db', 'persona-memories.index.json');
}

describe('PersonaRecordIndex lifecycle', () => {
  it('distinguishes a valid empty index from a missing sidecar', async () => {
    await inFreshWorkspace(async () => {
      const first = await getMemoryIndex();
      const second = await getMemoryIndex();

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        recordKind: 'PersonaRecordIndex',
        collection: ENDURING_AGENT_COLLECTIONS.memoryItems,
        revision: 1,
        sourceRevision: 1,
        sourceCount: 0,
        generatedAt: 0,
        entries: [],
      });
    });
  });

  it('serializes create, update, and delete while advancing revision', async () => {
    await inFreshWorkspace(async () => {
      await Promise.all([
        saveIndexedCollectionItem(
          ENDURING_AGENT_COLLECTIONS.memoryItems,
          memory('memory_a', 'persona_a', 10),
        ),
        saveIndexedCollectionItem(
          ENDURING_AGENT_COLLECTIONS.memoryItems,
          memory('memory_b', 'persona_b', 20),
        ),
      ]);
      const created = await getMemoryIndex();
      expect(created.entries.map(entry => entry.id)).toEqual(['memory_a', 'memory_b']);

      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        memory('memory_a', 'persona_a', 30),
      );
      const updated = await getMemoryIndex();
      expect(updated.revision).toBeGreaterThan(created.revision);
      expect(updated.entries.find(entry => entry.id === 'memory_a')?.updatedAt).toBe(30);

      await deleteIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        'persona_a',
        'memory_a',
      );
      const deleted = await getMemoryIndex();
      expect(deleted.revision).toBeGreaterThan(updated.revision);
      expect(deleted.entries.map(entry => entry.id)).toEqual(['memory_b']);
    });
  });

  it('rebuilds missing and count-mismatched indexes deterministically', async () => {
    await inFreshWorkspace(async () => {
      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        memory('memory_b', 'persona_a', 20),
      );
      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        memory('memory_a', 'persona_a', 10),
      );
      const expected = await fs.readFile(memoryIndexPath(), 'utf8');

      await fs.unlink(memoryIndexPath());
      await getMemoryIndex();
      expect(await fs.readFile(memoryIndexPath(), 'utf8')).toBe(expected);

      const invalid = JSON.parse(expected) as Record<string, unknown>;
      invalid.sourceCount = 999;
      await fs.writeFile(memoryIndexPath(), JSON.stringify(invalid, null, 2));
      const repaired = await getMemoryIndex();
      expect(repaired.sourceCount).toBe(2);
      expect(repaired.entries.map(entry => entry.id)).toEqual(['memory_a', 'memory_b']);
      expect(await fs.readFile(memoryIndexPath(), 'utf8')).toBe(expected);
    });
  });

  it('rebuilds a legacy flat collection that has no sidecar', async () => {
    await inFreshWorkspace(async () => {
      const legacy = memory('memory_legacy', 'persona_legacy', 10);
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        legacy.id,
        legacy,
      );

      const rebuilt = await getMemoryIndex();
      expect(rebuilt.sourceCount).toBe(1);
      expect(rebuilt.entries).toEqual([
        expect.objectContaining({ id: legacy.id, personaId: legacy.personaId }),
      ]);
    });
  });

  it('keeps logical Persona A entries unchanged when Persona B is written', async () => {
    await inFreshWorkspace(async () => {
      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        memory('memory_a', 'persona_a', 10),
      );
      const before = (await getMemoryIndex()).entries
        .filter(entry => entry.personaId === 'persona_a');

      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.memoryItems,
        memory('memory_b', 'persona_b', 20),
      );
      const after = (await getMemoryIndex()).entries
        .filter(entry => entry.personaId === 'persona_a');

      expect(after).toEqual(before);
    });
  });
});
