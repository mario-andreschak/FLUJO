import { createHash } from 'crypto';

import type { PersonaMailboxItem } from '@/shared/types/enduringAgent';

import { canonicalJson } from './behaviorRevisions';

/** The request fields a mailbox idempotency key promises not to change. */
export function personaMailboxAdmission(record: PersonaMailboxItem): Record<string, unknown> {
  return {
    personaId: record.personaId,
    idempotencyKey: record.idempotencyKey,
    kind: record.kind,
    priority: record.priority,
    source: record.source,
    behaviorSlotKey: record.behaviorSlotKey ?? null,
    relationKey: record.relationKey ?? null,
    relatedAction: record.relatedAction ?? null,
    summary: record.summary ?? null,
    payloadRef: record.payloadRef ?? null,
    notBefore: record.notBefore ?? null,
  };
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Kept on a compacted mailbox item so a retry can still be compared with it. */
export function personaMailboxAdmissionDigest(admission: Record<string, unknown>): string {
  return sha256(admission);
}

/** The digest written by compaction before #481, which did not cover the request. */
function preRequestDigest(record: PersonaMailboxItem): string {
  return sha256({
    idempotencyKey: record.idempotencyKey,
    personaId: record.personaId,
    status: record.status,
    deliveredAt: record.deliveredAt,
    completedAt: record.completedAt,
  });
}

/**
 * Whether a retried admission asks for the same work as the stored item.
 * Compaction clears `summary` and `payloadRef`, so a compacted item is compared
 * through its admission digest. Items compacted with the older digest are
 * compared on every field compaction kept.
 */
export function isSamePersonaMailboxAdmission(
  existing: PersonaMailboxItem,
  requested: Record<string, unknown>,
): boolean {
  if (existing.compactedAt === undefined) {
    return canonicalJson(personaMailboxAdmission(existing)) === canonicalJson(requested);
  }
  if (existing.admissionDigest === personaMailboxAdmissionDigest(requested)) return true;
  if (existing.admissionDigest !== preRequestDigest(existing)) return false;
  return canonicalJson({
    ...personaMailboxAdmission(existing),
    summary: requested.summary ?? null,
    payloadRef: requested.payloadRef ?? null,
  }) === canonicalJson(requested);
}
