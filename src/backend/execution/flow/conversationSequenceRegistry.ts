import { ConversationSequenceSafetyError } from './conversationLogSequence';

export const CONVERSATION_SEQUENCE_REGISTRY_LIMITS = Object.freeze({
  maxKeys: 4096, maxKeyBytes: 8 * 1024, maxTotalKeyBytes: 4 * 1024 * 1024,
});
const ENTRY_ALLOWANCE = 96;
export interface SequenceRegistryAccounting { keyBytes: number; accountedCount: number; rejectedNewKeys: number }
export function newSequenceRegistryAccounting(): SequenceRegistryAccounting {
  return { keyBytes: 0, accountedCount: 0, rejectedNewKeys: 0 };
}
function keyBytes(key: string): number { return key.length * 2 + ENTRY_ALLOWANCE; }

export function refuseNewSequenceRegistryKey(accounting: SequenceRegistryAccounting): never {
  accounting.rejectedNewKeys++;
  throw new ConversationSequenceSafetyError('CONVERSATION_SEQUENCE_REGISTRY_FULL',
    'the process cannot own another sequence key; existing conversations may continue. Drain active work and perform a controlled restart before admitting new conversations');
}

/** Upgrade an existing process/HMR map without dropping any sequence ownership.
 * The ordinary path is O(1); migration/test-store changes trigger one bounded-
 * allocation traversal. No second per-key registry is retained. */
function reconcile(sequences: Map<string, number>, accounting: SequenceRegistryAccounting): void {
  if (accounting.accountedCount === sequences.size) return;
  let bytes = 0;
  for (const key of sequences.keys()) bytes += keyBytes(key);
  accounting.keyBytes = bytes;
  accounting.accountedCount = sequences.size;
}

export function admitSequenceRegistryKey(sequences: Map<string, number>, accounting: SequenceRegistryAccounting,
  key: string, limits = CONVERSATION_SEQUENCE_REGISTRY_LIMITS): void {
  if (sequences.has(key)) return; // Existing HWM owners always retain their entry.
  reconcile(sequences, accounting);
  const bytes = keyBytes(key);
  if (bytes > limits.maxKeyBytes || sequences.size >= limits.maxKeys
    || !Number.isSafeInteger(accounting.keyBytes + bytes) || accounting.keyBytes + bytes > limits.maxTotalKeyBytes) {
    refuseNewSequenceRegistryKey(accounting);
  }
}

export function insertSequenceRegistryKey(sequences: Map<string, number>, accounting: SequenceRegistryAccounting,
  key: string, value: number): void {
  admitSequenceRegistryKey(sequences, accounting, key);
  if (!sequences.has(key)) {
    accounting.keyBytes += keyBytes(key);
    accounting.accountedCount++;
  }
  sequences.set(key, value);
}

export function sequenceRegistryDiagnostics(sequences: Map<string, number>, accounting: SequenceRegistryAccounting) {
  reconcile(sequences, accounting);
  return { keys: sequences.size, keyBytes: accounting.keyBytes, rejectedNewKeys: accounting.rejectedNewKeys,
    ...CONVERSATION_SEQUENCE_REGISTRY_LIMITS };
}
