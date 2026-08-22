/**
 * Optional deletion-based pruning for Persona lease history (issue #478).
 *
 * This path is intentionally separate from mutation-based soft retention:
 * deletion is irreversible and needs a complete cross-record proof under the
 * same Persona runtime lock used by acquisition and reconciliation.
 */

import type { PersonaActivity, PersonaLease } from '@/shared/types/enduringAgent';
import { FEATURES } from '@/config/features';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';
import { withPersonaRuntimeLock } from './runtimeLock';
import {
  deletePersonaLeaseRecord,
  getPersonaLease,
  listActivitiesStrictForLeasePruning,
  listPersonaLeaseRecords,
  listPersonas,
} from './store';

const log = createLogger('enduringAgents/leaseHistoryPruning');

export const PERSONA_LEASE_HISTORY_RETAINED_COUNT = 1_000;
export const PERSONA_LEASE_HISTORY_MAX_DELETES_PER_SWEEP = 100;

export interface PersonaLeaseHistoryPruningOptions {
  retainedCount?: number;
  maxDeletesPerSweep?: number;
}

export interface PersonaLeaseHistoryPruningResult {
  examined: number;
  deleted: number;
  retainedProtected: number;
  retainedUnverifiable: number;
}

export interface WorkspaceLeaseHistoryPruningResult {
  personasExamined: number;
  personasFailed: number;
  recordsExamined: number;
  recordsDeleted: number;
}

const EMPTY_RESULT: PersonaLeaseHistoryPruningResult = Object.freeze({
  examined: 0,
  deleted: 0,
  retainedProtected: 0,
  retainedUnverifiable: 0,
});

function requireNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function isTerminalActivity(activity: PersonaActivity): boolean {
  return activity.status === 'completed'
    || activity.status === 'cancelled'
    || activity.status === 'error';
}

function sameLeaseAcquisition(left: PersonaLease, right: PersonaLease): boolean {
  return left.id === right.id
    && left.workspaceId === right.workspaceId
    && left.personaId === right.personaId
    && left.activityId === right.activityId
    && left.holderId === right.holderId
    && left.fencingToken === right.fencingToken
    && left.acquiredAt === right.acquiredAt;
}

function candidateReferencesAreVerifiable(
  candidate: PersonaLease,
  activities: PersonaActivity[],
): boolean {
  const ownerActivity = activities.find((activity) => activity.id === candidate.activityId);
  if (!ownerActivity || ownerActivity.personaId !== candidate.personaId) return false;

  const references = activities.filter((activity) => activity.leaseId === candidate.id);
  if (references.length === 0) {
    // A complete strict scan proved that no Activity currently relies on this
    // old acquisition. The lease's own Activity still has to exist and agree.
    return true;
  }

  return references.every((activity) => (
    activity.personaId === candidate.personaId
    && activity.id === candidate.activityId
    && isTerminalActivity(activity)
  ));
}

function orderNewestFirst(left: PersonaLease, right: PersonaLease): number {
  return right.fencingToken - left.fencingToken
    || right.acquiredAt - left.acquiredAt
    || right.id.localeCompare(left.id);
}

/**
 * Delete count-excess, terminal lease acquisitions only after a complete strict
 * history/head/Activity snapshot proves they are dead. The feature is independent
 * of ENABLE_PERSONA_RUNTIME_RETENTION and defaults off.
 */
export async function prunePersonaLeaseHistory(
  personaId: string,
  options: PersonaLeaseHistoryPruningOptions = {},
): Promise<PersonaLeaseHistoryPruningResult> {
  if (!FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING) return { ...EMPTY_RESULT };

  const retainedCount = requireNonNegativeInteger(
    options.retainedCount ?? PERSONA_LEASE_HISTORY_RETAINED_COUNT,
    'retainedCount',
  );
  const maxDeletesPerSweep = requireNonNegativeInteger(
    options.maxDeletesPerSweep ?? PERSONA_LEASE_HISTORY_MAX_DELETES_PER_SWEEP,
    'maxDeletesPerSweep',
  );

  return withPersonaRuntimeLock(personaId, async (lock) => {
    // Recheck after waiting for the lock so disabling the rollout stops deletion
    // before the operation performs authoritative reads.
    if (!FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING) return { ...EMPTY_RESULT };
    await lock.assertOwned();

    const [history, head, activities] = await Promise.all([
      listPersonaLeaseRecords(personaId),
      getPersonaLease(personaId),
      listActivitiesStrictForLeasePruning(),
    ]);

    if (history.length === 0) {
      if (head) {
        throw new Error('Lease-history pruning found an authority head without acquisition history.');
      }
      return { ...EMPTY_RESULT };
    }

    const workspaceId = getCurrentWorkspace();
    for (const record of history) {
      if (record.workspaceId !== workspaceId || record.personaId !== personaId) {
        throw new Error('Lease-history pruning encountered mismatched record ownership.');
      }
    }

    const byToken = new Map<number, PersonaLease>();
    for (const record of history) {
      const duplicate = byToken.get(record.fencingToken);
      if (duplicate && duplicate.id !== record.id) {
        throw new Error('Lease-history pruning found conflicting fencing-token acquisitions.');
      }
      byToken.set(record.fencingToken, record);
    }

    const newest = [...history].sort(orderNewestFirst)[0];
    if (
      !head
      || head.workspaceId !== workspaceId
      || head.personaId !== personaId
      || !sameLeaseAcquisition(head, newest)
    ) {
      throw new Error('Lease-history pruning found an unverifiable authority head.');
    }

    const protectedIds = new Set<string>([newest.id, head.id]);
    for (const record of history) {
      if (record.status === 'active') protectedIds.add(record.id);
    }

    const terminal = history
      .filter((record) => record.status === 'released' || record.status === 'expired')
      .sort(orderNewestFirst);
    for (const record of terminal.slice(0, retainedCount)) {
      protectedIds.add(record.id);
    }

    const candidates = terminal
      .filter((record) => !protectedIds.has(record.id))
      .reverse()
      .slice(0, maxDeletesPerSweep);

    const verified: PersonaLease[] = [];
    let retainedUnverifiable = 0;
    for (const candidate of candidates) {
      if (!candidateReferencesAreVerifiable(candidate, activities)) {
        retainedUnverifiable += 1;
        continue;
      }
      verified.push(candidate);
    }

    let deleted = 0;
    for (const candidate of verified) {
      if (!FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING) break;
      await lock.assertOwned();
      await deletePersonaLeaseRecord(candidate);
      deleted += 1;
    }

    return {
      examined: history.length,
      deleted,
      retainedProtected: protectedIds.size,
      retainedUnverifiable,
    };
  });
}

/**
 * Hourly workspace sweep entry point. Persona failures are isolated; every
 * individual operation still fails closed before selecting candidates.
 */
export async function pruneWorkspacePersonaLeaseHistories(
  options: PersonaLeaseHistoryPruningOptions = {},
): Promise<WorkspaceLeaseHistoryPruningResult> {
  if (!FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING) {
    return {
      personasExamined: 0,
      personasFailed: 0,
      recordsExamined: 0,
      recordsDeleted: 0,
    };
  }

  const personas = await listPersonas();
  const result: WorkspaceLeaseHistoryPruningResult = {
    personasExamined: personas.length,
    personasFailed: 0,
    recordsExamined: 0,
    recordsDeleted: 0,
  };

  for (const persona of personas) {
    try {
      const pruned = await prunePersonaLeaseHistory(persona.id, options);
      result.recordsExamined += pruned.examined;
      result.recordsDeleted += pruned.deleted;
    } catch {
      result.personasFailed += 1;
      log.warn('Lease-history pruning failed closed for one Persona.');
    }
  }

  if (result.recordsDeleted > 0 || result.personasFailed > 0) {
    log.info(`Lease-history pruning summary: ${JSON.stringify(result)}`);
  }
  return result;
}
