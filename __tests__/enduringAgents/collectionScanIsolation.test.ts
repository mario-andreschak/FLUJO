import { promises as fs } from 'fs';
import path from 'path';

import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import { saveIndexedCollectionItem } from '@/backend/services/enduringAgents/indexing';
import {
  listMemoryItems,
  listPersonaMailboxItems,
} from '@/backend/services/enduringAgents/store';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  PersonaMailboxItemSchema,
  type MemoryItem,
  type PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import { getWorkspaceDataDir, runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T | Promise<T>): Promise<T> {
  workspaceSequence += 1;
  return runWithWorkspace(
    `collection-scan-isolation-${process.pid}-${workspaceSequence}`,
    task,
  );
}

function memory(id: string, personaId: string): MemoryItem {
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
    updatedAt: 1,
  });
}

function mailbox(id: string, personaId: string, sequence: number): PersonaMailboxItem {
  return PersonaMailboxItemSchema.parse({
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id,
    personaId,
    idempotencyKey: String(sequence).padStart(64, '0'),
    sequence,
    kind: 'assignment',
    priority: 'normal',
    status: 'queued',
    source: { kind: 'assignment', sourceId: `source-${id}` },
    createdAt: 1,
    updatedAt: 1,
  });
}

function recordPath(collection: string, id: string): string {
  return path.resolve(getWorkspaceDataDir(), 'db', collection, `${id}.json`);
}

describe('indexed collection scan isolation', () => {
  it('does not open foreign memory or mailbox records on warm reads', async () => {
    await inFreshWorkspace(async () => {
      const records = [
        memory('memory_a', 'persona_a'),
        memory('memory_b', 'persona_b'),
        memory('memory_c', 'persona_c'),
      ];
      const mailboxItems = [
        mailbox('mailbox_a', 'persona_a', 1),
        mailbox('mailbox_b', 'persona_b', 1),
        mailbox('mailbox_c', 'persona_c', 1),
      ];
      for (const record of records) {
        await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.memoryItems, record);
      }
      for (const record of mailboxItems) {
        await saveIndexedCollectionItem(ENDURING_AGENT_COLLECTIONS.mailboxItems, record);
      }

      await listMemoryItems('persona_a');
      await listPersonaMailboxItems('persona_a');

      const readSpy = jest.spyOn(fs, 'readFile');
      try {
        expect((await listMemoryItems('persona_a')).map(item => item.id)).toEqual(['memory_a']);
        expect((await listPersonaMailboxItems('persona_a')).map(item => item.id))
          .toEqual(['mailbox_a']);

        const opened = new Set(readSpy.mock.calls.map(([value]) => path.resolve(String(value))));
        expect(opened).not.toContain(recordPath(
          ENDURING_AGENT_COLLECTIONS.memoryItems,
          'memory_b',
        ));
        expect(opened).not.toContain(recordPath(
          ENDURING_AGENT_COLLECTIONS.memoryItems,
          'memory_c',
        ));
        expect(opened).not.toContain(recordPath(
          ENDURING_AGENT_COLLECTIONS.mailboxItems,
          'mailbox_b',
        ));
        expect(opened).not.toContain(recordPath(
          ENDURING_AGENT_COLLECTIONS.mailboxItems,
          'mailbox_c',
        ));
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  it('keeps a malformed foreign mailbox record outside Persona A read scope', async () => {
    await inFreshWorkspace(async () => {
      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        mailbox('mailbox_a', 'persona_a', 1),
      );
      await saveIndexedCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        mailbox('mailbox_b', 'persona_b', 1),
      );
      await listPersonaMailboxItems('persona_a');

      const foreignPath = recordPath(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        'mailbox_b',
      );
      await fs.writeFile(foreignPath, '{ deliberately malformed');

      const readSpy = jest.spyOn(fs, 'readFile');
      try {
        await expect(listPersonaMailboxItems('persona_a')).resolves.toEqual([
          expect.objectContaining({ id: 'mailbox_a', personaId: 'persona_a' }),
        ]);
        const opened = new Set(readSpy.mock.calls.map(([value]) => path.resolve(String(value))));
        expect(opened).not.toContain(foreignPath);
      } finally {
        readSpy.mockRestore();
      }
    });
  });
});
