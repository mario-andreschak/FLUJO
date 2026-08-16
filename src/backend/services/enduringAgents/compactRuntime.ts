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
import { BEHAVIOR_MAINTENANCE_RETENTION_MS, BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT } from './behaviorMaintenance';
import { canonicalJson } from './behaviorRevisions';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';
import { applyRetention, type RetentionPolicy } from './retention';
import {
  listPersonaActivities,
  listPersonaLeaseRecords,
  listPersonaMailboxItems,
  savePersonaActivity,
  savePersonaMailboxItem,
  savePersonaLease,
} from './store';

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Compaction policy for mailbox items.
 * Terminal items older than BEHAVIOR_MAINTENANCE_RETENTION_MS or beyond the newest 100
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
    retentionMs: BEHAVIOR_MAINTENANCE_RETENTION_MS,
    detailedLimit: BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT,
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
 * Terminal activities older than retention window or beyond newest 100 are compacted:
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
    retentionMs: BEHAVIOR_MAINTENANCE_RETENTION_MS,
    detailedLimit: BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT,
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
 * Terminal dispatches older than retention window or beyond newest 100 are compacted:
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
    retentionMs: BEHAVIOR_MAINTENANCE_RETENTION_MS,
    detailedLimit: BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT,
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
    save: async () => {
      // This would normally call savePersonaFlowDispatch, which doesn't exist yet.
      // For now, this is a stub; the actual flow dispatch save function will be
      // called from the dispatcher's postActivity handler.
      throw new Error('Flow dispatch save not yet implemented for retention');
    },
  };
}

/**
 * Compaction policy for lease history.
 * Archived (released/expired) leases older than retention window are removed from the
 * live collection. This is simpler than mailbox/activity/dispatch because leases
 * are all small (no bulky fields to blank) — compaction is purely count-reduction.
 */
export function getLeaseHistoryRetentionPolicy(): RetentionPolicy<PersonaLease> {
  return {
    recordKind: 'PersonaLease',
    isEligible: (lease) => {
      return lease.status === 'released' && lease.compactedAt === undefined;
    },
    timestampOf: (lease) => lease.releasedAt ?? lease.expiresAt,
    isCompacted: (lease) => lease.compactedAt !== undefined,
    retentionMs: BEHAVIOR_MAINTENANCE_RETENTION_MS,
    detailedLimit: 1000, // Keep newest 1000 archived leases for audit.
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
 * Runs under the persona runtime lock and applies the retention policy.
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
 * Compact lease history for a specific Persona.
 */
export async function compactPersonaLeaseHistory(
  personaId: string,
  now = Date.now(),
): Promise<{ compacted: number; remaining: number }> {
  const items = await listPersonaLeaseRecords(personaId);
  const policy = getLeaseHistoryRetentionPolicy();
  return applyRetention(items, policy, now);
}

/**
 * Per-Persona storage statistics for observability (issue #453, acceptance criterion 5).
 */
export interface PersonaStorageStats {
  personaId: string;
  recordCounts: {
    mailboxItems: number;
    mailboxItemsCompacted: number;
    activities: number;
    activitiesCompacted: number;
    leaseRecords: number;
    leaseRecordsArchived: number;
  };
  estimatedBytes: number;
  oldestMailboxItemCreatedAt?: number;
  oldestActivityCreatedAt?: number;
  oldestLeaseCreatedAt?: number;
}

/**
 * Gather per-Persona storage stats for the dashboard and lane-11 observability.
 */
export async function getPersonaStorageStats(personaId: string): Promise<PersonaStorageStats> {
  const [mailboxItems, activities, leaseRecords] = await Promise.all([
    listPersonaMailboxItems(personaId),
    listPersonaActivities(personaId),
    listPersonaLeaseRecords(personaId),
  ]);

  const mailboxItemsCompacted = mailboxItems.filter((i) => i.compactedAt !== undefined).length;
  const activitiesCompacted = activities.filter((a) => a.compactedAt !== undefined).length;
  const leaseRecordsArchived = leaseRecords.filter((l) => l.compactedAt !== undefined).length;

  // Rough byte estimate (not exact; for observability only).
  const estimatedBytes = mailboxItems.length * 500
    + activities.length * 2000
    + leaseRecords.length * 250;

  const oldestMailbox = mailboxItems.reduce(
    (min, i) => (i.createdAt < min ? i.createdAt : min),
    Infinity,
  );
  const oldestActivity = activities.reduce(
    (min, a) => (a.createdAt < min ? a.createdAt : min),
    Infinity,
  );
  const oldestLease = leaseRecords.reduce(
    (min, l) => (l.acquiredAt < min ? l.acquiredAt : min),
    Infinity,
  );

  return {
    personaId,
    recordCounts: {
      mailboxItems: mailboxItems.length,
      mailboxItemsCompacted,
      activities: activities.length,
      activitiesCompacted,
      leaseRecords: leaseRecords.length,
      leaseRecordsArchived,
    },
    estimatedBytes,
    oldestMailboxItemCreatedAt: oldestMailbox === Infinity ? undefined : oldestMailbox,
    oldestActivityCreatedAt: oldestActivity === Infinity ? undefined : oldestActivity,
    oldestLeaseCreatedAt: oldestLease === Infinity ? undefined : oldestLease,
  };
}
