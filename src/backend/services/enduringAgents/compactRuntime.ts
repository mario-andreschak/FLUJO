/**
 * Per-collection compaction adapters for Persona runtime records (issue #453).
 * Each adapter implements the RetentionPolicy interface for its record type,
 * plugging into the shared retention algorithm from retention.ts.
 */

import type {
  PersonaActivity,
  PersonaLease,
  PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import { compactBehaviorCallPin, saveCompactedBehaviorCallPin, type BehaviorCallPin } from './behaviorCallPins';
import { personaMailboxAdmission, personaMailboxAdmissionDigest } from './mailboxAdmission';
import type { PersonaRuntimeLock } from './runtimeLock';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';
import {
  listPersonaFlowDispatchRecordsForRetention,
  savePersonaFlowDispatchForRetention,
} from './personaFlowDispatchRetention';
import {
  assertPersonaRuntimeRetentionWriteGrant,
  type PersonaRuntimeRetentionWriteGrant,
} from './personaRuntimeRetentionControl';
import { executeRetentionPlan, planRetention, type RetentionPolicy } from './retention';
import {
  listPersonaActivities,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  savePersonaActivity,
  savePersonaMailboxItem,
  savePersonaLease,
} from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checked-in Persona runtime retention decision from issue #479.
 *
 * These values are intentionally independent of behavior maintenance, whose
 * 30-day/newest-100 policy serves a different record family. Runtime overrides
 * are not supported: changing a value requires review alongside recovery,
 * storage, and lane-1 latency evidence.
 */
export const PERSONA_RUNTIME_RETENTION_POLICY = {
  mailboxItem: {
    retentionMs: 30 * DAY_MS,
    detailedLimit: 500,
  },
  activity: {
    retentionMs: 30 * DAY_MS,
    detailedLimit: 200,
  },
  flowDispatch: {
    retentionMs: 30 * DAY_MS,
    detailedLimit: 200,
  },
  leaseHistory: {
    retentionMs: 90 * DAY_MS,
    detailedLimit: 1_000,
  },
  behaviorCallPin: {
    retentionMs: 30 * DAY_MS,
    detailedLimit: 200,
  },
} as const;

export const PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP = 100;

/** A child may finish before its parent; retain all detail until that Activity is terminal. */
export function getBehaviorCallPinRetentionPolicy(
  activities: readonly PersonaActivity[],
  lock: PersonaRuntimeLock,
): RetentionPolicy<BehaviorCallPin> {
  const terminalActivities = new Set(activities
    .filter((activity) => ['completed', 'cancelled', 'error'].includes(activity.status))
    .map((activity) => activity.id));
  return {
    recordKind: 'BehaviorCallPin',
    isEligible: (pin) => pin.compactedAt === undefined && terminalActivities.has(pin.activityId),
    timestampOf: (pin) => pin.completedAt ?? pin.updatedAt,
    isCompacted: (pin) => pin.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.behaviorCallPin.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.behaviorCallPin.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: compactBehaviorCallPin,
    save: (pin) => saveCompactedBehaviorCallPin(pin, lock),
  };
}

/**
 * Compaction policy for mailbox items.
 * Terminal items older than 30 days or beyond the newest 500 detailed records
 * are compacted: summary and payloadRef are blanked, compactedAt marker set,
 * and admissionDigest (idempotency preservation) is computed.
 */
export function getMailboxItemRetentionPolicy(): RetentionPolicy<PersonaMailboxItem> {
  return {
    recordKind: 'PersonaMailboxItem',
    isEligible: (item) => {
      const terminal = item.status === 'coalesced'
        || item.status === 'completed'
        || item.status === 'rejected';
      return terminal && item.compactedAt === undefined;
    },
    timestampOf: (item) => item.completedAt ?? item.updatedAt,
    isCompacted: (item) => item.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (item, compactedAt) => (
      {
        ...item,
        summary: undefined,
        payloadRef: undefined,
        admissionDigest: personaMailboxAdmissionDigest(personaMailboxAdmission(item)),
        compactedAt,
      } as unknown as PersonaMailboxItem
    ),
    save: savePersonaMailboxItem,
  };
}

/**
 * Compaction policy for activities.
 * Terminal activities older than 30 days or beyond the newest 200 detailed
 * records are compacted:
 * bulky fields (instructionContext, resourceRefs, error) are blanked, compactedAt marker set,
 * but identity and audit fields (including the Core snapshot digest) are preserved for crash
 * recovery and reconciliation.
 */
export function getActivityRetentionPolicy(): RetentionPolicy<PersonaActivity> {
  return {
    recordKind: 'PersonaActivity',
    isEligible: (activity) => {
      const terminal = activity.status === 'completed'
        || activity.status === 'cancelled'
        || activity.status === 'error';
      return terminal && activity.compactedAt === undefined;
    },
    timestampOf: (activity) => activity.completedAt ?? activity.updatedAt,
    isCompacted: (activity) => activity.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.activity.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.activity.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (activity, compactedAt) => (
      {
        ...activity,
        instructionContext: undefined,
        entryPointPayloadRef: undefined,
        resourceRefs: undefined,
        error: undefined,
        outcomeRef: undefined,
        compactedAt,
      } as unknown as PersonaActivity
    ),
    save: savePersonaActivity,
  };
}

/**
 * Compaction policy for flow dispatches.
 * Terminal dispatches older than 30 days or beyond the newest 200 detailed
 * records are compacted:
 * bulky fields (flowInput, instructionContext, maintenancePlan, maintenanceResult, routingDecision)
 * are blanked, but identity/dedup/audit fields (id, idempotencyDigest, requestHash, state,
 * admission, activityId, memoryCandidateLimit, timestamps) are preserved for
 * reconciliation and retried dedup.
 */
export function getFlowDispatchRetentionPolicy(): RetentionPolicy<PersonaFlowDispatchRecord> {
  return {
    recordKind: 'PersonaFlowDispatchRecord',
    isEligible: (dispatch) => {
      const terminal = dispatch.state === 'completed'
        || dispatch.state === 'error'
        || dispatch.state === 'cancelled';
      return terminal && dispatch.compactedAt === undefined;
    },
    timestampOf: (dispatch) => dispatch.completedAt ?? dispatch.updatedAt,
    isCompacted: (dispatch) => dispatch.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.flowDispatch.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.flowDispatch.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (dispatch, compactedAt) => (
      {
        ...dispatch,
        flowInput: undefined,
        instructionContext: undefined,
        maintenancePlan: undefined,
        maintenanceResult: undefined,
        routingDecision: undefined,
        targetActivityId: undefined,
        waitingReason: undefined,
        lastError: undefined,
        resumeRequestedAt: undefined,
        resumeSettledAt: undefined,
        resumeReason: undefined,
        resumeFromWaitingReason: undefined,
        resumePreparationRequired: undefined,
        compactedAt,
      } as unknown as PersonaFlowDispatchRecord
    ),
    save: savePersonaFlowDispatchForRetention,
  };
}

/**
 * Legacy lease-history soft-compaction policy retained for direct compatibility.
 * Released records older than 90 days or beyond the newest 1000 are marked
 * compacted. This does not reduce record count and is not scheduled; irreversible
 * count pruning lives in leaseHistoryPruning.ts behind its own independent,
 * default-off feature flag (issue #478).
 */
export function getLeaseHistoryRetentionPolicy(): RetentionPolicy<PersonaLease> {
  return {
    recordKind: 'PersonaLease',
    isEligible: (lease) => {
      return lease.status === 'released' && lease.compactedAt === undefined;
    },
    timestampOf: (lease) => lease.releasedAt ?? lease.expiresAt,
    isCompacted: (lease) => lease.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.leaseHistory.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.leaseHistory.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (lease, compactedAt) => (
      {
        ...lease,
        compactedAt,
      } as unknown as PersonaLease
    ),
    save: savePersonaLease,
  };
}

export interface PersonaRuntimeCompactionResult {
  compacted: number;
  remaining: number;
  /** Planned writes not made because the grant was withdrawn mid-run. */
  unauthorized: number;
}

async function compactWithGrant<T extends { id: string }>(
  grant: PersonaRuntimeRetentionWriteGrant,
  records: readonly T[],
  policy: RetentionPolicy<T>,
  now: number,
): Promise<PersonaRuntimeCompactionResult> {
  const plan = planRetention(records, policy, now);
  const result = await executeRetentionPlan(plan, policy, {
    authorizeWrite: () => grant.authorize(),
  });
  return {
    compacted: result.compacted,
    remaining: result.remaining,
    unauthorized: result.unauthorized,
  };
}

/**
 * Compact mailbox items for the grant's Persona. The grant proves the runtime
 * lock is held and retention is active; it is re-checked before every write.
 */
export async function compactPersonaMailboxItems(
  grant: PersonaRuntimeRetentionWriteGrant,
  now = Date.now(),
): Promise<PersonaRuntimeCompactionResult> {
  assertPersonaRuntimeRetentionWriteGrant(grant);
  const items = await listPersonaMailboxItems(grant.personaId);
  return compactWithGrant(grant, items, getMailboxItemRetentionPolicy(), now);
}

/** Compact Activities for the grant's Persona; see compactPersonaMailboxItems. */
export async function compactPersonaActivities(
  grant: PersonaRuntimeRetentionWriteGrant,
  now = Date.now(),
): Promise<PersonaRuntimeCompactionResult> {
  assertPersonaRuntimeRetentionWriteGrant(grant);
  const items = await listPersonaActivities(grant.personaId);
  return compactWithGrant(grant, items, getActivityRetentionPolicy(), now);
}

/** Compact Flow dispatches for the grant's Persona; see compactPersonaMailboxItems. */
export async function compactPersonaFlowDispatches(
  grant: PersonaRuntimeRetentionWriteGrant,
  now = Date.now(),
): Promise<PersonaRuntimeCompactionResult> {
  assertPersonaRuntimeRetentionWriteGrant(grant);
  const items = await listPersonaFlowDispatchRecordsForRetention(grant.personaId);
  return compactWithGrant(grant, items, getFlowDispatchRetentionPolicy(), now);
}

/**
 * Legacy compatibility adapter. This does not prune records and is not scheduled.
 */
export async function compactPersonaLeaseHistory(
  grant: PersonaRuntimeRetentionWriteGrant,
  now = Date.now(),
): Promise<PersonaRuntimeCompactionResult> {
  assertPersonaRuntimeRetentionWriteGrant(grant);
  const items = await listPersonaLeaseRecords(grant.personaId);
  return compactWithGrant(grant, items, getLeaseHistoryRetentionPolicy(), now);
}

// Backward-compatible direct-module exports; the implementation lives in the dedicated service.
