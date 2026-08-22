import {
  buildReinforcedMemoryItem,
  findMemoryDuplicateComponents,
  normalizeAndDeduplicateMemorySourceRefs,
  selectMemoryDuplicateSurvivor,
} from '@/backend/services/enduringAgents/memoryDeduplication';
import type { MemoryItem } from '@/shared/types/enduringAgent';

const NOW = 10_000;

function memory(id: string, content: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    schemaVersion: 1,
    id,
    personaId: 'persona-1',
    kind: 'semantic',
    scope: 'persona',
    status: 'active',
    content,
    confidence: 0.5,
    importance: 0.5,
    sourceRefs: [{ kind: 'user_statement', id: `source-${id}`, observedAt: NOW }],
    trust: 'explicit_user',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('memory duplicate helpers (issue #465)', () => {
  it('builds transitive connected components and counts direct qualifying pairs', () => {
    const original = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX';
    const middle = `${original.slice(0, 10)}0${original.slice(11)}`;
    const tail = `${middle.slice(0, 30)}1${middle.slice(31)}`;

    const result = findMemoryDuplicateComponents([
      memory('a', original),
      memory('b', middle),
      memory('c', tail),
    ]);

    expect(result.components.map((component) => component.map((item) => item.id)))
      .toEqual([['a', 'b', 'c']]);
    expect(result.duplicatePairsFound).toBe(2);
  });

  it('does not join inactive records or records from different kind/scope groups', () => {
    const content = 'the release branch is stable';
    const result = findMemoryDuplicateComponents([
      memory('active-a', content),
      memory('active-b', content),
      memory('forgotten', content, { status: 'forgotten' }),
      memory('episodic', content, { kind: 'episodic' }),
      memory('activity', content, { scope: 'activity' }),
    ]);

    expect(result.components).toHaveLength(1);
    expect(result.components[0].map((item) => item.id)).toEqual(['active-a', 'active-b']);
    expect(result.duplicatePairsFound).toBe(1);
  });

  it('selects a survivor by core pin, trust, confidence, importance, age, then ID', () => {
    const component = [
      memory('older', 'same', { createdAt: 5, confidence: 0.9 }),
      memory('pinned', 'same', {
        trust: 'external_untrusted',
        confidence: 0.1,
        importance: 0.1,
        createdAt: 20,
      }),
    ];

    expect(selectMemoryDuplicateSurvivor(component, new Set(['pinned'])).id).toBe('pinned');
    expect(selectMemoryDuplicateSurvivor(component, new Set()).id).toBe('older');
  });

  it('normalizes and deduplicates provenance while retaining the oldest observation', () => {
    const refs = normalizeAndDeduplicateMemorySourceRefs([
      { kind: 'user_statement', id: 'source', observedAt: 20 },
      { kind: 'user_statement', id: 'source', observedAt: 10 },
    ], NOW);

    expect(refs).toHaveLength(1);
    expect(refs[0].observedAt).toBe(10);
  });

  it('reinforces once, caps numeric fields, and keeps trust when policy rejects an upgrade', () => {
    const survivor = memory('survivor', 'same', {
      confidence: 0.98,
      importance: 0.99,
      trust: 'model_inference',
    });
    const reinforced = buildReinforcedMemoryItem(survivor, {
      now: NOW + 1,
      incomingTrust: 'explicit_user',
      incomingSourceRefs: survivor.sourceRefs,
      canUpgradeTrust: () => false,
    });

    expect(reinforced.confidence).toBe(1);
    expect(reinforced.importance).toBe(1);
    expect(reinforced.trust).toBe('model_inference');
    expect(reinforced.sourceRefs).toHaveLength(1);
    expect(reinforced.updatedAt).toBe(NOW + 1);
  });
});
