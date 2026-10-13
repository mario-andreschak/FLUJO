import { createHash } from 'node:crypto';

/** Only the persisted ownership fields needed by package flow installation. */
export type PackageFlowLedger = Readonly<Record<string, {
  entities?: { flows?: Readonly<Record<string, string>> };
}>>;

/** Full SHA-256 fits the 64-character ID limit without truncation or case aliases. */
export function deterministicFlowId(packageName: string, localId: string): string {
  return createHash('sha256').update(JSON.stringify([packageName, localId])).digest('hex');
}

export function hasConflictingFlowClaim(
  ledger: PackageFlowLedger, packageName: string, localId: string, flowId: string,
): boolean {
  return Object.entries(ledger).some(([owner, record]) =>
    Object.entries(record?.entities?.flows ?? {}).some(([ownedLocalId, ownedFlowId]) =>
      typeof ownedFlowId !== 'string'
      || (ownedFlowId.toLowerCase() === flowId.toLowerCase() && (owner !== packageName || ownedLocalId !== localId))),
  );
}

/**
 * Reuse recorded legacy IDs without rewriting schedules, conversations or
 * subflow references. Never infer ownership from a slug, folder or occupied ID.
 * Ambiguous legacy claims require reconciliation before any package mutation.
 */
export function resolvePackageFlowIds(
  packageName: string, localIds: readonly string[], ledger: PackageFlowLedger,
  occupiedIds: ReadonlySet<string>,
): Record<string, string> {
  const previous = Object.hasOwn(ledger, packageName) ? ledger[packageName].entities?.flows ?? {} : {};
  const idMap: Record<string, string> = Object.create(null);
  const assigned = new Set<string>();
  const occupied = new Set([...occupiedIds].map((id) => id.toLowerCase()));
  for (const localId of localIds) {
    const recorded = Object.hasOwn(previous, localId);
    const id = recorded ? previous[localId] : deterministicFlowId(packageName, localId);
    if (Object.hasOwn(idMap, localId) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)
      || assigned.has(id.toLowerCase()) || hasConflictingFlowClaim(ledger, packageName, localId, id)
      || (occupied.has(id.toLowerCase()) && !recorded)) {
      throw new Error('Package flow identity ownership is ambiguous or conflicts with an existing flow.');
    }
    idMap[localId] = id;
    assigned.add(id.toLowerCase());
  }
  return idMap;
}
