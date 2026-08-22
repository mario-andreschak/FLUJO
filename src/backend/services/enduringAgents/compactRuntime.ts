/**
 * Per-collection compaction adapters for Persona runtime records (issue #453).
 * Each adapter implements the RetentionPolicy interface for its record type,
 * plugging into the shared retention algorithm from retention.ts.
 */

import { createHash } from 'crypto';
import type {
  PersonaActivity,
  PersonaLease,
  PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import { canonicalJson } from './behaviorRevisions';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';
import {
  listPersonaFlowDispatchRecordsForRetention,
  savePersonaFlowDispatchForRetention,
} from './personaFlowDispatchRetention';
import { applyRetention, type RetentionPolicy } from './retention';
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
} as const;

export const PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP = 100;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
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
        admissionDigest: digest({
          idempotencyKey: item.idempotencyKey,
          personaId: item.personaId,
          status: item.status,
          deliveredAt: item.deliveredAt,
          completedAt: item.completedAt,
        }),
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
 * but identity and audit fields (id, status, outcome, timestamps, leaseId) are preserved
 * for crash recovery and reconciliation.
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
        instructionContextDigest: undefined,
        instructionContextSchemaVersion: undefined,
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

/**
 * Compact mailbox items for a specific Persona.
 * Caller must hold the Persona runtime lock for the complete list/apply/save sweep.
 */
export async function compactPersonaMailboxItems(
  personaId: string,
  now = Date.now(),
): Promise<{ compacted: number; remaining: number }> {
  const items = await listPersonaMailboxItems(personaId);
  const policy = getMailboxItemRetentionPolicy();
  return applyRetention(items, policy, now);
}

/**
 * Compact activities for a specific Persona.
 * Caller must hold the Persona runtime lock for the complete list/apply/save sweep.
 */
export async function compactPersonaActivities(
  personaId: string,
  now = Date.now(),
): Promise<{ compacted: number; remaining: number }> {
  const items = await listPersonaActivities(personaId);
  const policy = getActivityRetentionPolicy();
  return applyRetention(items, policy, now);
}

/**
 * Compact Flow dispatches for a specific Persona.
 * Caller must hold the Persona runtime lock for the complete list/apply/save sweep.
 */
export async function compactPersonaFlowDispatches(
  personaId: string,
  now = Date.now(),
): Promise<{ compacted: number; remaining: number }> {
  const items = await listPersonaFlowDispatchRecordsForRetention(personaId);
  const policy = getFlowDispatchRetentionPolicy();
  return applyRetention(items, policy, now);
}

/**
 * Legacy compatibility adapter. This does not prune records and is not scheduled.
 * Caller must hold the Persona runtime lock for the complete list/apply/save sweep.
 */
export async function compactPersonaLeaseHistory(
  personaId: string,
  now = Date.now(),
): Promise<{ compacted: number; remaining: number }> {
  const items = await listPersonaLeaseRecords(personaId);
  const policy = getLeaseHistoryRetentionPolicy();
  return applyRetention(items, policy, now);
}

// Backward-compatible direct-module exports; the implementation lives in the dedicated service.
