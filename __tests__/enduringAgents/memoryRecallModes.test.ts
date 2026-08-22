import {
  rememberMemory,
  searchPersonaMemory,
} from '@/backend/services/enduringAgents';
import {
  computeContentDigest,
  storeMemoryEmbedding,
} from '@/backend/services/enduringAgents/memoryEmbeddingStore';
import {
  getMemoryQueryVectorCache,
  resetMemoryQueryVectorCache,
} from '@/backend/services/enduringAgents/memoryQueryVectorCache';
import { setMemorySettings } from '@/backend/services/enduringAgents/memorySettings';
import { modelService } from '@/backend/services/model';
import { getEmbeddingProvider } from '@/backend/services/model/embeddings';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

const embeddingModelRecordId = '00000000-0000-4000-8000-000000000002';
const embeddingModelId = 'text-embedding-test';
const queryVector = [1, 0, 0];

describe('Persona memory recall modes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    resetMemoryQueryVectorCache();
  });

  it('retrieves a paraphrase only in hybrid mode and reuses the warm query vector', async () => {
    await runWithWorkspace(`memory-recall-modes-${process.pid}`, async () => {
      const { persona } = await createPersonaFromRole({
        name: 'Recall Modes',
        idempotencyKey: 'recall-modes',
      });
      const target = await rememberMemory({
        personaId: persona.id,
        kind: 'semantic',
        scope: 'persona',
        status: 'active',
        content: 'Deployments run from the release branch.',
        confidence: 1,
        importance: 1,
        trust: 'explicit_user',
        sourceRefs: [{ kind: 'user_statement', id: 'target-source' }],
      });
      const distractor = await rememberMemory({
        personaId: persona.id,
        kind: 'semantic',
        scope: 'persona',
        status: 'active',
        content: 'The team meets every Tuesday.',
        confidence: 1,
        importance: 1,
        trust: 'explicit_user',
        sourceRefs: [{ kind: 'user_statement', id: 'distractor-source' }],
      });

      await storeMemoryEmbedding({
        memoryId: target.id,
        personaId: persona.id,
        modelId: embeddingModelId,
        dimensions: queryVector.length,
        contentDigest: computeContentDigest(target.content),
        vector: queryVector,
      });
      await storeMemoryEmbedding({
        memoryId: distractor.id,
        personaId: persona.id,
        modelId: embeddingModelId,
        dimensions: queryVector.length,
        contentDigest: computeContentDigest(distractor.content),
        vector: [0, 1, 0],
      });
      await setMemorySettings({
        semanticRecallEnabled: true,
        semanticEmbeddingModelId: embeddingModelRecordId,
        semanticEmbeddingDimensions: queryVector.length,
        semanticFloor: 0.75,
      });
      jest.spyOn(modelService, 'getModel').mockResolvedValue({
        id: embeddingModelRecordId,
        name: embeddingModelId,
        adapter: 'openai',
        ApiKey: 'test-key-never-resolved',
      } as Awaited<ReturnType<typeof modelService.getModel>>);
      const embed = jest.spyOn(getEmbeddingProvider(), 'embed').mockResolvedValue({
        vector: queryVector,
        dimensions: queryVector.length,
        modelId: embeddingModelId,
        contentDigest: computeContentDigest('How do we ship software?'),
      });

      await expect(searchPersonaMemory(persona.id, {
        query: 'How do we ship software?',
        mode: 'lexical',
      })).resolves.toEqual([]);

      const firstHybrid = await searchPersonaMemory(persona.id, {
        query: 'How do we ship software?',
        mode: 'hybrid',
      });
      const secondHybrid = await searchPersonaMemory(persona.id, {
        query: '  HOW DO WE SHIP\nSOFTWARE? ',
        mode: 'hybrid',
      });

      expect(firstHybrid[0]?.item.id).toBe(target.id);
      expect(secondHybrid[0]?.item.id).toBe(target.id);
      expect(embed).toHaveBeenCalledTimes(1);
      expect(getMemoryQueryVectorCache().stats()).toMatchObject({
        hits: 1,
        misses: 1,
        size: 1,
      });
    });
  });
});
