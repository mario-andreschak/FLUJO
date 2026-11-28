/**
 * Per-collection compaction adapters for Persona runtime records (issue #453).
 * Each adapter implements the RetentionPolicy interface for its record type,
 * plugging into the shared retention algorithm from retention.ts. The hourly
 * sweep in personaRuntimeRetentionRollout.ts is the only caller that writes.
 */

import type { ZodType } from 'zod';

import {
  PersonaActivitySchema,
  PersonaMailboxItemSchema,
  type PersonaActivity,
  type PersonaMailboxItem,
} from '@/shared/types/enduringAgent';
import {
  BehaviorCallPinSchema,
  compactBehaviorCallPin,
  saveCompactedBehaviorCallPin,
  type BehaviorCallPin,
} from './behaviorCallPins';
import { canonicalJson } from './behaviorRevisions';
import { personaMailboxAdmission, personaMailboxAdmissionDigest } from './mailboxAdmission';
import type { PersonaRuntimeLock } from './runtimeLock';
import type { PersonaFlowDispatchRecord } from './personaDispatcher';
import { PersonaFlowDispatchRecordSchema } from './personaFlowDispatchSchema';
import { savePersonaFlowDispatchForRetention } from './personaFlowDispatchRetention';
import type { RetentionPolicy } from './retention';
import { savePersonaActivity, savePersonaMailboxItem } from './store';

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
  behaviorCallPin: {
    retentionMs: 30 * DAY_MS,
    detailedLimit: 200,
  },
} as const;

export const PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP = 100;

/**
 * A compaction is valid when the stored schema accepts the result and every
 * identity field is unchanged.
 */
function validCompaction<T extends object>(
  schema: ZodType<unknown>,
  identity: readonly (keyof T)[],
): (record: T, compacted: T) => boolean {
  return (record, compacted) => schema.safeParse(compacted).success
    && identity.every((field) => canonicalJson(record[field]) === canonicalJson(compacted[field]));
}

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
    isValidCompaction: validCompaction<BehaviorCallPin>(BehaviorCallPinSchema, [
      'id', 'workspaceId', 'personaId', 'activityId', 'behaviorRevisionId', 'contentHash',
      'status', 'createdAt', 'completedAt',
    ]),
    save: (pin) => saveCompactedBehaviorCallPin(pin, lock),
  };
}

/**
 * Compaction policy for mailbox items.
 * Terminal items older than 30 days or beyond the newest 500 detailed records
 * are compacted: summary and payloadRef are blanked, compactedAt marker set,
 * and admissionDigest (idempotency preservation) is computed. A coalesced item
 * whose delivery is still pending is not terminal: it returns to the queue
 * when its target Activity ends.
 */
export function getMailboxItemRetentionPolicy(): RetentionPolicy<PersonaMailboxItem> {
  return {
    recordKind: 'PersonaMailboxItem',
    isEligible: (item) => {
      const terminal = item.status === 'completed'
        || item.status === 'rejected'
        || (item.status === 'coalesced' && item.deliveryStatus !== 'pending');
      return terminal && item.compactedAt === undefined;
    },
    timestampOf: (item) => item.completedAt ?? item.updatedAt,
    isCompacted: (item) => item.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.mailboxItem.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (item, compactedAt) => ({
      ...item,
      summary: undefined,
      payloadRef: undefined,
      admissionDigest: personaMailboxAdmissionDigest(personaMailboxAdmission(item)),
      compactedAt,
    }),
    isValidCompaction: validCompaction<PersonaMailboxItem>(PersonaMailboxItemSchema, [
      'id', 'personaId', 'idempotencyKey', 'sequence', 'kind', 'status', 'source',
      'deliveryStatus', 'claimedActivityId', 'coalescedIntoId', 'createdAt', 'updatedAt', 'completedAt',
    ]),
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
    compact: (activity, compactedAt) => ({
      ...activity,
      instructionContext: undefined,
      entryPointPayloadRef: undefined,
      resourceRefs: undefined,
      error: undefined,
      outcomeRef: undefined,
      compactedAt,
    }),
    isValidCompaction: validCompaction<PersonaActivity>(PersonaActivitySchema, [
      'id', 'personaId', 'kind', 'status', 'source', 'behaviorId', 'behaviorRevisionId',
      'coreFlowId', 'coreFlowRevisionId', 'instructionContextDigest', 'leaseId', 'conversationId',
      'outcome', 'createdAt', 'updatedAt', 'completedAt',
    ]),
    save: savePersonaActivity,
  };
}

/**
 * Compaction policy for flow dispatches.
 * Terminal dispatches whose projections are settled, older than 30 days or
 * beyond the newest 200 detailed records, are compacted:
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
      return terminal
        && dispatch.terminalProjectionsSettledAt !== undefined
        && dispatch.compactedAt === undefined;
    },
    timestampOf: (dispatch) => dispatch.completedAt ?? dispatch.updatedAt,
    isCompacted: (dispatch) => dispatch.compactedAt !== undefined,
    retentionMs: PERSONA_RUNTIME_RETENTION_POLICY.flowDispatch.retentionMs,
    detailedLimit: PERSONA_RUNTIME_RETENTION_POLICY.flowDispatch.detailedLimit,
    maxWritesPerSweep: PERSONA_RUNTIME_RETENTION_MAX_WRITES_PER_SWEEP,
    compact: (dispatch, compactedAt) => ({
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
    }),
    isValidCompaction: validCompaction<PersonaFlowDispatchRecord>(PersonaFlowDispatchRecordSchema, [
      'id', 'workspaceId', 'personaId', 'idempotencyDigest', 'requestHash', 'state', 'admission',
      'mailboxItemId', 'activityId', 'behaviorRevisionId', 'outcome', 'error', 'createdAt',
      'updatedAt', 'completedAt', 'terminalProjectionsSettledAt',
    ]),
    save: savePersonaFlowDispatchForRetention,
  };
}
