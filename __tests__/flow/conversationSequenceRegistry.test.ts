import { admitSequenceRegistryKey, insertSequenceRegistryKey, newSequenceRegistryAccounting,
  sequenceRegistryDiagnostics, CONVERSATION_SEQUENCE_REGISTRY_LIMITS as LIMITS } from '@/backend/execution/flow/conversationSequenceRegistry';

it('refuses only new keys at the key-count boundary and preserves every allocated high-water mark', () => {
  const sequences = new Map<string, number>();
  const accounting = newSequenceRegistryAccounting();
  for (let index = 0; index < LIMITS.maxKeys; index++) insertSequenceRegistryKey(sequences, accounting, `workspace\0id-${index}`, index + 100);
  const before = [...sequences.entries()];
  expect(() => insertSequenceRegistryKey(sequences, accounting, 'new-owner', 0))
    .toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL', status: 429 }));
  expect([...sequences.entries()]).toEqual(before);
  insertSequenceRegistryKey(sequences, accounting, 'workspace\0id-0', 101);
  expect(sequences.get('workspace\0id-0')).toBe(101);
  expect(sequenceRegistryDiagnostics(sequences, accounting)).toMatchObject({ keys: LIMITS.maxKeys, rejectedNewKeys: 1 });
});

it('independently bounds individual keys and aggregate UTF-16 key/entry bytes', () => {
  const sequences = new Map<string, number>();
  const accounting = newSequenceRegistryAccounting();
  expect(() => admitSequenceRegistryKey(sequences, accounting, 'x'.repeat(LIMITS.maxKeyBytes / 2)))
    .toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }));
  let inserted = 0;
  for (; inserted < LIMITS.maxKeys; inserted++) {
    const key = `${inserted}-` + 'x'.repeat(3900);
    try { insertSequenceRegistryKey(sequences, accounting, key, inserted); }
    catch (error) { expect(error).toMatchObject({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }); break; }
  }
  expect(inserted).toBeGreaterThan(100);
  expect(inserted).toBeLessThan(LIMITS.maxKeys);
  expect(sequenceRegistryDiagnostics(sequences, accounting).keyBytes).toBeLessThanOrEqual(LIMITS.maxTotalKeyBytes);
  expect(sequences.size).toBe(inserted);
});

it('retains oversized preexisting HMR maps, reports their actual pressure, and permits old owners', () => {
  const sequences = new Map(Array.from({ length: LIMITS.maxKeys + 2 }, (_, index) => [`legacy-${index}`, index]));
  const accounting = newSequenceRegistryAccounting();
  expect(() => admitSequenceRegistryKey(sequences, accounting, 'new-owner')).toThrow(expect.objectContaining({ code: 'CONVERSATION_SEQUENCE_REGISTRY_FULL' }));
  insertSequenceRegistryKey(sequences, accounting, 'legacy-1', 42);
  expect(sequences.size).toBe(LIMITS.maxKeys + 2);
  expect(sequences.get('legacy-1')).toBe(42);
  expect(sequenceRegistryDiagnostics(sequences, accounting).keys).toBe(LIMITS.maxKeys + 2);
});

it('reconciles test-store migration without retaining a second per-key metadata map', () => {
  const sequences = new Map<string, number>();
  const accounting = newSequenceRegistryAccounting();
  insertSequenceRegistryKey(sequences, accounting, 'old', 10);
  sequences.clear();
  expect(sequenceRegistryDiagnostics(sequences, accounting)).toMatchObject({ keys: 0, keyBytes: 0 });
  insertSequenceRegistryKey(sequences, accounting, 'replacement', 0);
  expect(sequenceRegistryDiagnostics(sequences, accounting)).toMatchObject({ keys: 1 });
  expect(Object.keys(accounting).sort()).toEqual(['accountedCount', 'keyBytes', 'rejectedNewKeys']);
});
