/** Fixed process-wide observations, not a registry. Component ledgers remain
 * responsible for their own policies and ownership. No IDs or payloads here.
 */
type Slot = 'run' | 'preparation' | 'output' | 'ingress';
type Slots = Record<Slot, number>;
const host = globalThis as typeof globalThis & { __flujoAllocationReservationsV1?: Slots;
  __flujoFlowRunAdmission?: unknown; __flujoSubflowPreparation?: unknown;
  __flujoSubflowOutput?: unknown; __flujoChatIngressV1?: unknown;
};
function existingBytes(ledger: unknown): number {
  if (ledger === undefined) return 0;
  if (!ledger || typeof ledger !== 'object') throw new Error('Invalid existing allocation ledger.');
  const bytes = Object.getOwnPropertyDescriptor(ledger, 'bytes');
  if (!bytes || !('value' in bytes) || !Number.isSafeInteger(bytes.value) || bytes.value < 0) {
    throw new Error('Invalid existing allocation ledger.');
  }
  return bytes.value;
}
// Bootstrap only these four known ledgers when introducing the helper into a
// live process. Never erase an already-observed reservation on bundle reload.
const slots = host.__flujoAllocationReservationsV1 ??= {
  run: existingBytes(host.__flujoFlowRunAdmission), preparation: existingBytes(host.__flujoSubflowPreparation),
  output: existingBytes(host.__flujoSubflowOutput), ingress: existingBytes(host.__flujoChatIngressV1),
};
function validate(slot: Slot, bytes: number): void {
  if (!['run', 'preparation', 'output', 'ingress'].includes(slot) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Invalid allocation reservation observation.');
  }
}
export function setAllocationReservation(slot: Slot, bytes: number): void {
  validate(slot, bytes);
  slots[slot] = bytes;
}
export function getAllocationReservationSnapshot() {
  return Object.freeze({ ...slots, total: slots.run + slots.preparation + slots.output + slots.ingress });
}
export function pendingAllocationBytes(slot: Slot, replacement: number): number {
  validate(slot, replacement);
  return slots.run + slots.preparation + slots.output + slots.ingress - slots[slot] + replacement;
}
