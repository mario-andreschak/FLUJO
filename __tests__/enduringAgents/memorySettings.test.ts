import {
  DEFAULT_MEMORY_SETTINGS,
  mergeMemorySettings,
} from '@/shared/types/memorySettings';

describe('semantic memory settings (issue #471)', () => {
  it('keeps semantic recall disabled for existing workspaces', () => {
    expect(mergeMemorySettings(null)).toEqual(DEFAULT_MEMORY_SETTINGS);
    expect(mergeMemorySettings({}).semanticRecallEnabled).toBe(false);
  });

  it('trims model IDs, bounds semantic values, and normalizes active weights', () => {
    const settings = mergeMemorySettings({
      semanticRecallEnabled: true,
      semanticEmbeddingModelId: '  embedding-model  ',
      semanticEmbeddingDimensions: 2.9,
      semanticFloor: 2,
      lexicalWeight: 0.3,
      semanticWeight: 0.2,
    });

    expect(settings.semanticEmbeddingModelId).toBe('embedding-model');
    expect(settings.semanticEmbeddingDimensions).toBe(2);
    expect(settings.semanticFloor).toBe(1);
    expect(settings.lexicalWeight).toBeCloseTo(0.6);
    expect(settings.semanticWeight).toBeCloseTo(0.4);
  });

  it('restores defaults when both configured weights are zero', () => {
    const settings = mergeMemorySettings({
      lexicalWeight: 0,
      semanticWeight: 0,
    });

    expect(settings.lexicalWeight).toBe(DEFAULT_MEMORY_SETTINGS.lexicalWeight);
    expect(settings.semanticWeight).toBe(DEFAULT_MEMORY_SETTINGS.semanticWeight);
  });
});
