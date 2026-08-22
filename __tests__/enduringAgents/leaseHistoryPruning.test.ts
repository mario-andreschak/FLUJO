import {
  ENDURING_AGENT_SCHEMA_VERSION,
  type PersonaActivity,
  type PersonaLease,
} from '@/shared/types/enduringAgent';
import { FEATURES } from '@/config/features';
import {
  prunePersonaLeaseHistory,
} from '@/backend/services/enduringAgents/leaseHistoryPruning';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

const personaId = 'persona_pruning';
let workspaceSequence = 0;

function freshWorkspace(label: string): string {
  workspaceSequence += 1;
  return `lease-pruning-${label}-${process.pid}-${workspaceSequence}`;
}

function lease(
  workspaceId: string,
  fencingToken: number,
  status: PersonaLease['status'],
  overrides: Partial<PersonaLease> = {},
): PersonaLease {
  const acquiredAt = fencingToken * 10;
  return {
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: `lease_${fencingToken}`,
    workspaceId,
    personaId,
    activityId: `activity_${fencingToken}`,
    holderId: `holder_${fencingToken}`,
    status,
    fencingToken,
    acquiredAt,
    renewedAt: acquiredAt,
    expiresAt: acquiredAt + 5,
    ...(status === 'released' ? { releasedAt: acquiredAt + 1 } : {}),
    ...overrides,
  };
}

function activity(
  sourceLease: PersonaLease,
  status: PersonaActivity['status'] = 'completed',
  overrides: Partial<PersonaActivity> = {},
): PersonaActivity {
  const terminal = status === 'completed' || status === 'cancelled' || status === 'error';
  return {
    schemaVersion: ENDURING_AGENT_SCHEMA_VERSION,
    id: sourceLease.activityId,
    personaId: sourceLease.personaId,
    kind: 'assignment',
    status,
    source: { kind: 'assignment' },
    leaseId: sourceLease.id,
    createdAt: 1,
    updatedAt: 3,
    ...(status !== 'queued' ? { startedAt: 2 } : {}),
    ...(terminal ? { completedAt: 3 } : {}),
    ...(status === 'error' ? { error: 'expected test error' } : {}),
    ...overrides,
  };
}

async function saveLeaseBundle(
  history: PersonaLease[],
  head: PersonaLease,
  activities: PersonaActivity[],
): Promise<void> {
  for (const record of history) {
    await saveCollectionItem(
      ENDURING_AGENT_COLLECTIONS.leaseHistory,
      record.id,
      record,
    );
  }
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, personaId, head);
  for (const record of activities) {
    await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.activities, record.id, record);
  }
}

async function loadHistory(id: string): Promise<unknown | null> {
  return loadCollectionItem(
    ENDURING_AGENT_COLLECTIONS.leaseHistory,
    id,
    null,
  );
}

describe('guarded Persona lease-history pruning', () => {
  afterEach(() => {
    FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = false;
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = false;
  });

  it('stays off when soft runtime retention is enabled independently', async () => {
    FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = true;
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = false;

    await expect(prunePersonaLeaseHistory('not_a_safe_storage_id', {
      retainedCount: 0,
      maxDeletesPerSweep: 10,
    })).resolves.toEqual({
      examined: 0,
      deleted: 0,
      retainedProtected: 0,
      retainedUnverifiable: 0,
    });
  });

  it('runs independently while soft runtime retention remains disabled', async () => {
    FEATURES.ENABLE_PERSONA_RUNTIME_RETENTION = false;
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('eligible');

    await runWithWorkspace(workspaceId, async () => {
      const expired = lease(workspaceId, 1, 'expired');
      const released = lease(workspaceId, 2, 'released');
      const active = lease(workspaceId, 3, 'active');
      await saveLeaseBundle(
        [expired, released, active],
        active,
        [activity(expired), activity(released), activity(active, 'running')],
      );

      const result = await prunePersonaLeaseHistory(personaId, {
        retainedCount: 1,
        maxDeletesPerSweep: 10,
      });

      expect(result).toEqual({
        examined: 3,
        deleted: 1,
        retainedProtected: 2,
        retainedUnverifiable: 0,
      });
      expect(await loadHistory(expired.id)).toBeNull();
      expect(await loadHistory(released.id)).not.toBeNull();
      expect(await loadHistory(active.id)).not.toBeNull();
      expect(await loadCollectionItem(
        ENDURING_AGENT_COLLECTIONS.leases,
        personaId,
        null,
      )).toEqual(active);

      await expect(prunePersonaLeaseHistory(personaId, {
        retainedCount: 1,
        maxDeletesPerSweep: 10,
      })).resolves.toEqual(expect.objectContaining({ deleted: 0 }));
    });
  });

  it('preserves a terminal maximum-token authority head independently of status', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('terminal-head');

    await runWithWorkspace(workspaceId, async () => {
      const old = lease(workspaceId, 1, 'released');
      const head = lease(workspaceId, 2, 'released');
      await saveLeaseBundle([old, head], head, [activity(old), activity(head)]);

      const result = await prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 10,
      });

      expect(result.deleted).toBe(1);
      expect(await loadHistory(old.id)).toBeNull();
      expect(await loadHistory(head.id)).not.toBeNull();
    });
  });

  it('retains a candidate referenced by a waiting Activity', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('waiting-reference');

    await runWithWorkspace(workspaceId, async () => {
      const candidate = lease(workspaceId, 1, 'released');
      const head = lease(workspaceId, 2, 'active');
      await saveLeaseBundle(
        [candidate, head],
        head,
        [activity(candidate, 'waiting'), activity(head, 'running')],
      );

      const result = await prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 10,
      });

      expect(result).toEqual(expect.objectContaining({
        deleted: 0,
        retainedUnverifiable: 1,
      }));
      expect(await loadHistory(candidate.id)).not.toBeNull();
    });
  });

  it('retains a candidate whose owning Activity is missing', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('missing-activity');

    await runWithWorkspace(workspaceId, async () => {
      const candidate = lease(workspaceId, 1, 'expired');
      const head = lease(workspaceId, 2, 'active');
      await saveLeaseBundle([candidate, head], head, [activity(head, 'running')]);

      const result = await prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 10,
      });

      expect(result.retainedUnverifiable).toBe(1);
      expect(result.deleted).toBe(0);
      expect(await loadHistory(candidate.id)).not.toBeNull();
    });
  });

  it('fails closed on conflicting fencing tokens without deleting anything', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('duplicate-token');

    await runWithWorkspace(workspaceId, async () => {
      const first = lease(workspaceId, 1, 'released');
      const conflicting = lease(workspaceId, 1, 'released', {
        id: 'lease_conflicting',
        activityId: 'activity_conflicting',
      });
      await saveLeaseBundle(
        [first, conflicting],
        conflicting,
        [activity(first), activity(conflicting)],
      );

      await expect(prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 10,
      })).rejects.toThrow('conflicting fencing-token acquisitions');

      expect(await loadHistory(first.id)).not.toBeNull();
      expect(await loadHistory(conflicting.id)).not.toBeNull();
    });
  });

  it('fails closed when the strict Activity scan encounters malformed storage', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('malformed-activity');

    await runWithWorkspace(workspaceId, async () => {
      const candidate = lease(workspaceId, 1, 'released');
      const head = lease(workspaceId, 2, 'active');
      await saveLeaseBundle(
        [candidate, head],
        head,
        [activity(candidate), activity(head, 'running')],
      );
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        'activity_malformed',
        { schemaVersion: ENDURING_AGENT_SCHEMA_VERSION, id: 'activity_malformed' },
      );

      await expect(prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 10,
      })).rejects.toThrow();

      expect(await loadHistory(candidate.id)).not.toBeNull();
    });
  });

  it('enforces the per-sweep delete cap in oldest-first token order', async () => {
    FEATURES.ENABLE_PERSONA_LEASE_HISTORY_PRUNING = true;
    const workspaceId = freshWorkspace('delete-cap');

    await runWithWorkspace(workspaceId, async () => {
      const terminal = [1, 2, 3, 4].map((token) => lease(
        workspaceId,
        token,
        token % 2 === 0 ? 'expired' : 'released',
      ));
      const head = lease(workspaceId, 5, 'active');
      await saveLeaseBundle(
        [...terminal, head],
        head,
        [...terminal.map((record) => activity(record)), activity(head, 'running')],
      );

      const result = await prunePersonaLeaseHistory(personaId, {
        retainedCount: 0,
        maxDeletesPerSweep: 2,
      });

      expect(result.deleted).toBe(2);
      expect(await loadHistory('lease_1')).toBeNull();
      expect(await loadHistory('lease_2')).toBeNull();
      expect(await loadHistory('lease_3')).not.toBeNull();
      expect(await loadHistory('lease_4')).not.toBeNull();
      expect(await loadHistory('lease_5')).not.toBeNull();
    });
  });
});
