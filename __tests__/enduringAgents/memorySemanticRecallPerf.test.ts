import { cpus, release } from 'os';
import { performance } from 'perf_hooks';

import goldenFixtureJson from '../fixtures/memory-ranking/golden-semantic-v1.json';

import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  computeContentDigest,
  listPersonaEmbeddings,
} from '@/backend/services/enduringAgents/memoryEmbeddingStore';
import { runMemoryExperiment } from '@/backend/services/enduringAgents/memoryExperimentHarness';
import type { MemoryExperimentDataset } from '@/backend/services/enduringAgents/memoryExperimentTypes';
import { searchPersonaMemory } from '@/backend/services/enduringAgents/memoryKernel';
import {
  getMemoryQueryVectorCache,
  resetMemoryQueryVectorCache,
} from '@/backend/services/enduringAgents/memoryQueryVectorCache';
import { CURRENT_MEMORY_VARIANT } from '@/backend/services/enduringAgents/memoryRanking';
import { setMemorySettings } from '@/backend/services/enduringAgents/memorySettings';
import { getMemoryIndex } from '@/backend/services/enduringAgents/indexing';
import { listMemoryItems } from '@/backend/services/enduringAgents/store';
import { modelService } from '@/backend/services/model';
import { getEmbeddingProvider } from '@/backend/services/model/embeddings';
import {
  ENDURING_AGENT_SCHEMA_VERSION,
  MemoryItemSchema,
  type MemoryEmbedding,
} from '@/shared/types/enduringAgent';
import { StorageKey } from '@/shared/types/storage';
import { saveCollectionItem, saveItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

import { summarizeLatency } from './benchmarks/recallMetrics';
import { createPersonaFromRole } from './fixtures/personaFactory';

const describePerf = process.env.FLUJO_PERF_TESTS === '1' ? describe : describe.skip;
const ITEM_COUNT = 50_000;
const SAMPLE_COUNT = 20;
const FIXTURE_VERSION = 'persona-memory-recall-v1';
const FIXTURE_HASH = '50k-release-branch-deterministic-v1';
const embeddingModelRecordId = '00000000-0000-4000-8000-000000000002';
const modelId = 'text-embedding-3-small';
const query = 'How do we ship software?';
const queryVector = [1, 0, 0, 0, 0, 0, 0, 0];
const goldenFixture = goldenFixtureJson as unknown as MemoryExperimentDataset;

function memoryId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

describePerf('semantic memory recall 50k performance (opt-in)', () => {
  jest.setTimeout(600_000);

  afterEach(() => {
    jest.restoreAllMocks();
    resetMemoryQueryVectorCache();
  });

  it('keeps production hybrid recall below 150ms p95 with a proven warm query cache', async () => {
    await runWithWorkspace(`semantic-memory-perf-${process.pid}`, async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Recall Benchmark',
        idempotencyKey: FIXTURE_VERSION,
      });
      const embeddings: MemoryEmbedding[] = [];
      const setupStartedAt = performance.now();

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
                personaId: persona.id,
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
              personaId: persona.id,
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
        `${StorageKey.MEMORY_EMBEDDINGS}:${persona.id}` as any,
        embeddings,
      );
      const memoryIndex = await getMemoryIndex();
      expect(memoryIndex.collection).toBe(ENDURING_AGENT_COLLECTIONS.memoryItems);
      expect(memoryIndex.sourceCount).toBe(ITEM_COUNT);
      expect(memoryIndex.entries).toHaveLength(ITEM_COUNT);
      expect(memoryIndex.entries.every((entry) => entry.personaId === persona.id)).toBe(true);
      expect(new Set(memoryIndex.entries.map((entry) => entry.id)).size).toBe(ITEM_COUNT);

      await setMemorySettings({
        semanticRecallEnabled: true,
        semanticEmbeddingModelId: embeddingModelRecordId,
        semanticEmbeddingDimensions: queryVector.length,
        semanticFloor: 0.75,
        lexicalWeight: 0.6,
        semanticWeight: 0.4,
      });

      jest.spyOn(modelService, 'getModel').mockResolvedValue({
        id: embeddingModelRecordId,
        name: modelId,
        adapter: 'openai',
        ApiKey: 'benchmark-never-resolved',
      } as Awaited<ReturnType<typeof modelService.getModel>>);
      const embed = jest.spyOn(getEmbeddingProvider(), 'embed').mockResolvedValue({
        vector: queryVector,
        dimensions: queryVector.length,
        modelId,
        contentDigest: computeContentDigest(query),
      });

      const [storedItems, storedEmbeddings] = await Promise.all([
        listMemoryItems(persona.id, { statuses: ['active'] }),
        listPersonaEmbeddings(persona.id),
      ]);
      expect(storedItems).toHaveLength(ITEM_COUNT);
      expect(storedEmbeddings).toHaveLength(ITEM_COUNT);
      expect(storedEmbeddings.every((embedding) => (
        embedding.modelId === modelId
        && embedding.dimensions === queryVector.length
      ))).toBe(true);
      const setupMilliseconds = performance.now() - setupStartedAt;

      const queryCache = getMemoryQueryVectorCache();
      queryCache.clear();
      const warmResult = await searchPersonaMemory(persona.id, {
        query,
        mode: 'hybrid',
        asOf: ITEM_COUNT + 1,
        limit: 10,
      });
      expect(warmResult[0]?.item.id).toBe(memoryId(ITEM_COUNT - 1));
      expect(embed).toHaveBeenCalledTimes(1);
      expect(queryCache.stats()).toMatchObject({ misses: 1, hits: 0, size: 1 });

      const samples: number[] = [];
      for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
        const startedAt = performance.now();
        const ranked = await searchPersonaMemory(persona.id, {
          query,
          mode: 'hybrid',
          asOf: ITEM_COUNT + 1,
          limit: 10,
        });
        samples.push(performance.now() - startedAt);
        expect(ranked[0]?.item.id).toBe(memoryId(ITEM_COUNT - 1));
      }

      const cacheStats = queryCache.stats();
      const lexical = await searchPersonaMemory(persona.id, {
        query,
        mode: 'lexical',
        asOf: ITEM_COUNT + 1,
        limit: 10,
      });
      expect(lexical).toEqual([]);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(cacheStats).toMatchObject({
        hits: SAMPLE_COUNT,
        misses: 1,
        coalesced: 0,
        size: 1,
      });

      const lexicalGoldenFixture: MemoryExperimentDataset = {
        ...goldenFixture,
        version: `${goldenFixture.version}-lexical-baseline`,
        queries: goldenFixture.queries.map(({ semanticScores: _semanticScores, ...goldenQuery }) => (
          goldenQuery
        )),
      };
      const [lexicalQuality] = runMemoryExperiment(
        lexicalGoldenFixture,
        [CURRENT_MEMORY_VARIANT],
      );
      const [hybridQuality] = runMemoryExperiment(goldenFixture, [CURRENT_MEMORY_VARIANT]);
      const lexicalRecallAtK = lexicalQuality.metrics.recallAtK.value ?? 0;
      const hybridRecallAtK = hybridQuality.metrics.recallAtK.value ?? 0;
      const lexicalMrr = lexicalQuality.metrics.meanReciprocalRank.value ?? 0;
      const hybridMrr = hybridQuality.metrics.meanReciprocalRank.value ?? 0;
      expect(hybridRecallAtK).toBeGreaterThan(lexicalRecallAtK);
      expect(hybridMrr).toBeGreaterThan(lexicalMrr);

      const report = {
        fixture: {
          version: FIXTURE_VERSION,
          hash: FIXTURE_HASH,
          itemCount: ITEM_COUNT,
          embeddingCount: storedEmbeddings.length,
          vectorDimensions: queryVector.length,
          modelId,
        },
        runtime: {
          commit: process.env.GITHUB_SHA ?? process.env.FLUJO_BENCHMARK_COMMIT ?? 'unreported',
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          osRelease: release(),
          cpuModel: cpus()[0]?.model ?? 'unknown',
          logicalCpuCount: cpus().length,
          setupMilliseconds,
          measuredOperation: 'searchPersonaMemory(mode=hybrid), including indexed item load, cache lookup, sidecar load, cosine scoring, filtering, and ranking',
          excluded: 'fixture creation, sidecar creation, model/provider setup, query-cache warm-up, assertions, and JSON output',
          percentileMethod: 'nearest-rank',
        },
        queryCache: {
          ...cacheStats,
          measuredHitRate: cacheStats.hits / SAMPLE_COUNT,
        },
        ranking: {
          lexicalWeight: 0.6,
          semanticWeight: 0.4,
          semanticFloor: 0.75,
        },
        quality: {
          productionPath: {
            lexicalReturned: lexical.length,
            hybridTopMemoryId: warmResult[0]?.item.id,
          },
          goldenSet: {
            version: goldenFixture.version,
            lexical: {
              recallAtK: lexicalRecallAtK,
              meanReciprocalRank: lexicalMrr,
            },
            hybrid: {
              recallAtK: hybridRecallAtK,
              meanReciprocalRank: hybridMrr,
            },
            delta: {
              recallAtK: hybridRecallAtK - lexicalRecallAtK,
              meanReciprocalRank: hybridMrr - lexicalMrr,
            },
          },
        },
        latencyMilliseconds: summarizeLatency(samples),
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);
      expect(report.latencyMilliseconds.p95).toBeLessThan(150);
    });
  });
});
