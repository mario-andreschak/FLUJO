jest.mock('@/backend/services/model', () => ({
  modelService: { getModel: jest.fn() },
}));

jest.mock('@/backend/services/model/embeddings', () => {
  const actual = jest.requireActual('@/backend/services/model/embeddings');
  return { ...actual, getEmbeddingProvider: jest.fn() };
});

jest.mock('@/backend/services/enduringAgents/memorySettings', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/memorySettings');
  return { ...actual, getMemorySettings: jest.fn() };
});

jest.mock('@/backend/services/enduringAgents/memoryEmbeddingStore', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/memoryEmbeddingStore');
  return { ...actual, listPersonaEmbeddings: jest.fn() };
});

import { modelService } from '@/backend/services/model';
import { getEmbeddingProvider } from '@/backend/services/model/embeddings';
import {
  buildSemanticMemoryScores,
  computeContentDigest,
  listPersonaEmbeddings,
} from '@/backend/services/enduringAgents/memoryEmbeddingStore';
import { prepareSemanticRecall } from '@/backend/services/enduringAgents/memoryKernel';
import { getMemorySettings } from '@/backend/services/enduringAgents/memorySettings';
import type { MemoryEmbedding, MemoryItem } from '@/shared/types/enduringAgent';
import type { Model } from '@/shared/types/model';
import { mergeMemorySettings } from '@/shared/types/memorySettings';

const personaId = '00000000-0000-4000-8000-000000000001';
const memoryId = '00000000-0000-4000-8000-000000000002';
const now = 2_000_000_000_000;

const item = {
  schemaVersion: 1,
  id: memoryId,
  personaId,
  kind: 'semantic',
  scope: 'persona',
  status: 'active',
  content: 'Deploys run from the release branch.',
  confidence: 0.9,
  importance: 0.6,
  sourceRefs: [{ kind: 'user_statement', id: 'source-1' }],
  trust: 'verified_tool',
  createdAt: now,
  updatedAt: now,
} as MemoryItem;

const embedding = (overrides: Partial<MemoryEmbedding> = {}): MemoryEmbedding => ({
  memoryId,
  personaId,
  modelId: 'text-embedding-3-small',
  dimensions: 2,
  contentDigest: computeContentDigest(item.content),
  vector: [0.8, 0.6],
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const model = {
  id: 'stored-model',
  name: 'text-embedding-3-small',
  ApiKey: 'encrypted',
  adapter: 'openai',
} as Model;

describe('semantic memory recall integration (issue #471)', () => {
  const mockGetModel = jest.mocked(modelService.getModel);
  const mockGetProvider = jest.mocked(getEmbeddingProvider);
  const mockGetSettings = jest.mocked(getMemorySettings);
  const mockListEmbeddings = jest.mocked(listPersonaEmbeddings);
  const embed = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockResolvedValue(mergeMemorySettings({
      semanticRecallEnabled: true,
      semanticEmbeddingModelId: model.id,
      semanticEmbeddingDimensions: 2,
    }));
    mockGetModel.mockResolvedValue(model);
    mockGetProvider.mockReturnValue({ embed } as ReturnType<typeof getEmbeddingProvider>);
    mockListEmbeddings.mockResolvedValue([embedding()]);
    embed.mockResolvedValue({
      vector: [1, 0],
      dimensions: 2,
      modelId: model.name,
      contentDigest: computeContentDigest('how do we ship?'),
    });
  });

  it('embeds once, batch-loads once, and enables the no-shared-term candidate', async () => {
    const context = await prepareSemanticRecall(
      personaId,
      'how do we ship?',
      [item],
    );

    expect(embed).toHaveBeenCalledTimes(1);
    expect(mockListEmbeddings).toHaveBeenCalledTimes(1);
    expect(context.scores.get(memoryId)?.score).toBeCloseTo(0.8);
    expect(context.floor).toBe(0.75);
  });

  it('falls back without provider or sidecar calls when semantic recall is disabled', async () => {
    mockGetSettings.mockResolvedValue(mergeMemorySettings({
      semanticRecallEnabled: false,
    }));

    const context = await prepareSemanticRecall(personaId, 'release', [item]);

    expect(context.scores.size).toBe(0);
    expect(mockGetModel).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(mockListEmbeddings).not.toHaveBeenCalled();
  });

  it('contains query embedding failures and returns lexical fallback context', async () => {
    embed.mockRejectedValue(new Error('provider unavailable'));

    await expect(prepareSemanticRecall(personaId, 'release', [item]))
      .resolves.toMatchObject({ scores: new Map() });
  });

  it('rejects stale, wrong-model, and wrong-dimension sidecars in one batch', () => {
    const scores = buildSemanticMemoryScores(
      personaId,
      [item],
      [
        embedding({ contentDigest: computeContentDigest('old content') }),
        embedding({ modelId: 'other-model' }),
        embedding({ dimensions: 3, vector: [1, 0, 0] }),
      ],
      [1, 0],
      model.name,
    );

    expect(scores.size).toBe(0);
  });
});
