import {
  ModelSortOption,
  bucketContextWindow,
  deriveModelSortGroup,
  sortModels,
  compareModels,
} from '@/utils/shared/modelGrouping';
import { Model } from '@/shared/types';

// Minimal Model factory — only the fields the sort/grouping logic reads.
const model = (partial: Partial<Model>): Model => ({
  id: partial.id ?? Math.random().toString(36).slice(2),
  name: partial.name ?? 'model',
  ApiKey: '',
  ...partial,
});

describe('bucketContextWindow', () => {
  it('buckets an undefined/NaN context window as "Unknown"', () => {
    expect(bucketContextWindow(undefined)).toEqual({ key: 'ctx:unknown', label: 'Unknown context' });
    expect(bucketContextWindow(Number.NaN)).toEqual({ key: 'ctx:unknown', label: 'Unknown context' });
  });

  it('places values on the correct side of each band boundary', () => {
    expect(bucketContextWindow(8_000).key).toBe('ctx:<=8k');
    expect(bucketContextWindow(8_001).key).toBe('ctx:8k-32k');
    expect(bucketContextWindow(32_000).key).toBe('ctx:8k-32k');
    expect(bucketContextWindow(32_001).key).toBe('ctx:32k-128k');
    expect(bucketContextWindow(128_000).key).toBe('ctx:32k-128k');
    expect(bucketContextWindow(128_001).key).toBe('ctx:128k-1m');
    expect(bucketContextWindow(1_000_000).key).toBe('ctx:128k-1m');
    expect(bucketContextWindow(1_000_001).key).toBe('ctx:>1m');
  });
});

describe('deriveModelSortGroup', () => {
  it('folds name sorts by first letter (of the display name)', () => {
    const m = model({ name: 'gpt', displayName: 'Alpha' });
    expect(deriveModelSortGroup(m, 'name-asc')).toEqual({ key: 'letter:A', label: 'A' });
    expect(deriveModelSortGroup(m, 'name-desc')).toEqual({ key: 'letter:A', label: 'A' });
  });

  it('folds provider sort by the provider label', () => {
    const m = model({ name: 'x', provider: 'openai' });
    const g = deriveModelSortGroup(m, 'provider');
    expect(g.key.startsWith('provider:')).toBe(true);
    expect(g.label.length).toBeGreaterThan(0);
  });

  it('folds context sorts by size band', () => {
    expect(deriveModelSortGroup(model({ contextWindow: 4_000 }), 'context-desc').key).toBe('ctx:<=8k');
    expect(deriveModelSortGroup(model({ contextWindow: 200_000 }), 'context-asc').key).toBe('ctx:128k-1m');
    expect(deriveModelSortGroup(model({}), 'context-desc').key).toBe('ctx:unknown');
  });
});

describe('sortModels', () => {
  it('sorts by display name A–Z and Z–A', () => {
    const models = [
      model({ name: 'c', displayName: 'Charlie' }),
      model({ name: 'a', displayName: 'Alpha' }),
      model({ name: 'b', displayName: 'Bravo' }),
    ];
    expect(sortModels(models, 'name-asc').map((m) => m.displayName)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(sortModels(models, 'name-desc').map((m) => m.displayName)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('does not mutate the input array', () => {
    const models = [model({ displayName: 'B' }), model({ displayName: 'A' })];
    const before = models.map((m) => m.displayName);
    sortModels(models, 'name-asc');
    expect(models.map((m) => m.displayName)).toEqual(before);
  });

  it('sorts by context window largest/smallest, with undefined always last', () => {
    const models = [
      model({ id: 'small', displayName: 'S', contextWindow: 8_000 }),
      model({ id: 'none', displayName: 'N' }),
      model({ id: 'big', displayName: 'B', contextWindow: 200_000 }),
    ];
    expect(sortModels(models, 'context-desc').map((m) => m.id)).toEqual(['big', 'small', 'none']);
    expect(sortModels(models, 'context-asc').map((m) => m.id)).toEqual(['small', 'big', 'none']);
  });

  it('breaks ties by display name for provider and context sorts', () => {
    const models = [
      model({ id: '2', displayName: 'Zeta', provider: 'openai' }),
      model({ id: '1', displayName: 'Alpha', provider: 'openai' }),
    ];
    expect(sortModels(models, 'provider').map((m) => m.id)).toEqual(['1', '2']);
  });
});

describe('compareModels', () => {
  it('returns 0 for equal names under a name sort', () => {
    const cmp = compareModels('name-asc' as ModelSortOption);
    expect(cmp(model({ displayName: 'X' }), model({ displayName: 'X' }))).toBe(0);
  });
});
