import { performance } from 'perf_hooks';

import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  buildSemanticMemoryScores,
  computeContentDigest,
  listPersonaEmbeddings,
} from '@/backend/services/enduringAgents/memoryEmbeddingStore';
import { scoreMemoryCandidate } from '@/backend/services/enduringAgents/memoryRanking';
import { getMemoryIndex } from '@/backend/services/enduringAgents/indexing';
import { listMemoryItems } from '@/backend/services/enduringAgents/store';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  type MemoryEmbedding,
} from '@/shared/types/enduringAgent';
import { StorageKey } from '@/shared/types/storage';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

const describePerf = process.env.FLUJO_PERF_TESTS === '1' ? describe : describe.skip;
const ITEM_COUNT = 50_000;
const SAMPLE_COUNT = 20;
const personaId = '00000000-0000-4000-8000-000000000001';
const modelId = 'text-embedding-3-small';
const queryVector = [1, 0, 0, 0, 0, 0, 0, 0];

function percentile(samples: readonly number[], percentage: number): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * percentage) - 1];
}

function memoryId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

describePerf('semantic memory recall 50k performance (opt-in)', () => {
  jest.setTimeout(600_000);

  it('keeps the warm storage, sidecar, cosine, filter, and ranking path below 150ms p95', async () => {
    await runWithWorkspace(`semantic-memory-perf-${process.pid}`, async () => {
      const embeddings: MemoryEmbedding[] = [];
      for (let start = 0; start < ITEM_COUNT; start += 250) {
        await Promise.all(Array.from(
          { length: Math.min(250, ITEM_COUNT - start) },
          async (_, offset) => {
            const index = start + offset;
            const id = memoryId(index);
            const content = index === ITEM_COUNT - 1
              ? 'Deploys run from the release branch.'
              : `Synthetic memory item ${index}`;
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
                content,
                confidence: 0.8,
                importance: 0.5,
                sourceRefs: [{ kind: 'user_statement', id: `source-${index}` }],
                trust: 'verified_tool',
                createdAt: 1,
                updatedAt: index + 1,
              }),
            );
            embeddings[index] = {
              memoryId: id,
              personaId,
              modelId,
              dimensions: queryVector.length,
              contentDigest: computeContentDigest(content),
              vector: index === ITEM_COUNT - 1
                ? [...queryVector]
                : [0, 1, 0, 0, 0, 0, 0, 0],
              createdAt: 1,
              updatedAt: index + 1,
            };
          },
        ));
      }

      await saveItem(
        `${StorageKey.MEMORY_EMBEDDINGS}:${personaId}` as any,
        embeddings,
      );
      await getMemoryIndex();

      const samples: number[] = [];
      const stages = {
        itemLoad: [] as number[],
        sidecarLoad: [] as number[],
        scoreRank: [] as number[],
      };

      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        const itemLoadStartedAt = performance.now();
        const items = await listMemoryItems(personaId, { statuses: ['active'] });
        stages.itemLoad.push(performance.now() - itemLoadStartedAt);

        const sidecarStartedAt = performance.now();
        const sidecars = await listPersonaEmbeddings(personaId);
        stages.sidecarLoad.push(performance.now() - sidecarStartedAt);

        const scoreStartedAt = performance.now();
        const semanticScores = buildSemanticMemoryScores(
          personaId,
          items,
          sidecars,
          queryVector,
          modelId,
        );
        const ranked = items
          .filter((item) => (semanticScores.get(item.id)?.score ?? 0) >= 0.75)
          .map((item) => ({
            id: item.id,
            score: scoreMemoryCandidate({
              item,
              terms: ['how', 'do', 'we', 'ship'],
              core: false,
              asOf: ITEM_COUNT + 1,
              semantic: semanticScores.get(item.id),
            }),
          }))
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
        stages.scoreRank.push(performance.now() - scoreStartedAt);
        samples.push(performance.now() - startedAt);

        expect(ranked[0]?.id).toBe(memoryId(ITEM_COUNT - 1));
      }

      const report = {
        assumptions: {
          node: process.version,
          platform: process.platform,
          itemCount: ITEM_COUNT,
          vectorDimensions: queryVector.length,
          samples: SAMPLE_COUNT,
          queryEmbedding: 'fixed local vector; provider network excluded and measured separately in production metrics',
          storage: 'workspace storage plus Persona-wide embedding sidecar',
        },
        endToEnd: { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) },
        stages: Object.fromEntries(Object.entries(stages).map(([name, values]) => [
          name,
          { p50: percentile(values, 0.5), p95: percentile(values, 0.95) },
        ])),
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);
      expect(report.endToEnd.p95).toBeLessThan(150);
    });
  });
});
