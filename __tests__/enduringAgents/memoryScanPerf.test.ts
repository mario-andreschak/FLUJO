import { performance } from 'perf_hooks';

import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  getMailboxIndex,
  getMemoryIndex,
} from '@/backend/services/enduringAgents/indexing';
import {
  listMemoryItems,
  listPersonaMailboxItems,
} from '@/backend/services/enduringAgents/store';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  PersonaMailboxItemSchema,
} from '@/shared/types/enduringAgent';
import { saveCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

const describePerf = process.env.FLUJO_PERF_TESTS === '1' ? describe : describe.skip;
const SAMPLE_COUNT = 30;

function p95(samples: readonly number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1];
}

async function seedInBatches(
  count: number,
  create: (index: number) => Promise<void>,
): Promise<void> {
  const batchSize = 250;
  for (let start = 0; start < count; start += batchSize) {
    await Promise.all(
      Array.from(
        { length: Math.min(batchSize, count - start) },
        (_, offset) => create(start + offset),
      ),
    );
  }
}

describePerf('Persona record index performance (opt-in)', () => {
  jest.setTimeout(600_000);

  it('keeps 50k-memory warm Persona reads below the reference p95', async () => {
    await runWithWorkspace(`memory-index-perf-${process.pid}`, async () => {
      await seedInBatches(50_000, async (index) => {
        const personaId = `persona_${index % 10}`;
        const id = `memory_${String(index).padStart(5, '0')}`;
        await saveCollectionItem(
          ENDURING_AGENT_COLLECTIONS.memoryItems,
          id,
          MemoryItemSchema.parse({
            schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
            id,
            personaId,
            kind: 'semantic',
            scope: 'persona',
            status: 'active',
            content: `Memory ${id}`,
            confidence: 1,
            importance: index / 50_000,
            sourceRefs: [{ kind: 'user_statement', id: `source-${id}` }],
            trust: 'explicit_user',
            createdAt: 1,
            updatedAt: index + 1,
          }),
        );
      });
      await getMemoryIndex();
      await listMemoryItems('persona_0', {
        statuses: ['active'],
        limit: 50,
        order: 'memory_relevance',
      });

      const samples: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        const result = await listMemoryItems('persona_0', {
          statuses: ['active'],
          limit: 50,
          order: 'memory_relevance',
        });
        samples.push(performance.now() - startedAt);
        expect(result).toHaveLength(50);
      }
      expect(p95(samples)).toBeLessThan(150);
    });
  });

  it('keeps 20k-mailbox warm reads scale-invariant with foreign records', async () => {
    await runWithWorkspace(`mailbox-index-perf-${process.pid}`, async () => {
      await seedInBatches(20_000, async (index) => {
        const target = index < 100;
        const personaId = target ? 'persona_target' : `persona_foreign_${index % 9}`;
        const id = `mailbox_${String(index).padStart(5, '0')}`;
        await saveCollectionItem(
          ENDURING_AGENT_COLLECTIONS.mailboxItems,
          id,
          PersonaMailboxItemSchema.parse({
            schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
            id,
            personaId,
            idempotencyKey: index.toString(16).padStart(64, '0'),
            sequence: target ? index + 1 : Math.floor(index / 9) + 1,
            kind: 'assignment',
            priority: 'normal',
            status: 'queued',
            source: { kind: 'assignment', sourceId: `source-${id}` },
            createdAt: 1,
            updatedAt: index + 1,
          }),
        );
      });
      await getMailboxIndex();
      await listPersonaMailboxItems('persona_target', { limit: 50 });

      const samples: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        const result = await listPersonaMailboxItems('persona_target', { limit: 50 });
        samples.push(performance.now() - startedAt);
        expect(result).toHaveLength(50);
        expect(result.every(item => item.personaId === 'persona_target')).toBe(true);
      }

      // Foreign cardinality is 199x the returned target set, but warm reads still
      // open only the requested target records. Timing is secondary evidence.
      expect(p95(samples)).toBeLessThan(150);
    });
  });
});
