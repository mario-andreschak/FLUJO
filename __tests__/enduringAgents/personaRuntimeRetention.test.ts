import { createHash } from 'crypto';

import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import type { BehaviorCallPin } from '@/backend/services/enduringAgents/behaviorCallPins';
import { getMailboxItemRetentionPolicy } from '@/backend/services/enduringAgents/compactRuntime';
import {
  isSamePersonaMailboxAdmission,
  personaMailboxAdmission,
} from '@/backend/services/enduringAgents/mailboxAdmission';
import type { PersonaFlowDispatchRecord } from '@/backend/services/enduringAgents/personaDispatcher';
import {
  PERSONA_RUNTIME_RETENTION_GRADUATION,
  afterPersonaRuntimeRetentionAnomaly,
  afterPersonaRuntimeRetentionSweep,
  initialPersonaRuntimeRetentionState,
  personaRuntimeRetentionVolumeBudget,
  type PersonaRuntimeRetentionState,
  type PersonaRuntimeRetentionSweepSummary,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionControl';
import {
  findPersonaRuntimeRecordsInUse,
  type PersonaRuntimeRecords,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionReferences';
import {
  executeRetentionPlan,
  planRetention,
  type RetentionPolicy,
} from '@/backend/services/enduringAgents/retention';
import type {
  BehaviorMaintenanceRun,
  PersonaActivity,
  PersonaMailboxItem,
} from '@/shared/types/enduringAgent';

interface Probe {
  id: string;
  timestamp: number;
  payload?: string;
  owner?: string;
  compactedAt?: number;
}

function policy(save: (record: Probe) => Promise<unknown> = async () => undefined): RetentionPolicy<Probe> {
  return {
    recordKind: 'Probe',
    isEligible: (record) => record.compactedAt === undefined,
    timestampOf: (record) => record.timestamp,
    isCompacted: (record) => record.compactedAt !== undefined,
    retentionMs: 100,
    detailedLimit: 1,
    maxWritesPerSweep: 3,
    compact: (record, compactedAt) => ({ ...record, payload: undefined, compactedAt }),
    isValidCompaction: (record, compacted) => record.owner === compacted.owner,
    save,
  };
}

const bulky = 'x'.repeat(100);

describe('Persona history cleanup planning', () => {
  it('creates deterministic capped plans with age/rank reasons and byte projections', () => {
    const records: Probe[] = [
      { id: 'newer', timestamp: 1_000, payload: bulky },
      { id: 'tie_b', timestamp: 900, payload: bulky },
      { id: 'tie_a', timestamp: 900, payload: bulky },
      { id: 'old', timestamp: 100, payload: bulky },
      { id: 'oldest', timestamp: 0, payload: bulky },
    ];

    const plan = planRetention(records, policy(), 1_000);

    expect(plan.candidateCount).toBe(4);
    expect(plan.candidates.map((candidate) => candidate.record.id)).toEqual(['tie_b', 'tie_a', 'old']);
    expect(plan.candidates.map((candidate) => candidate.reason)).toEqual(['rank', 'rank', 'age-and-rank']);
    expect(plan.overCap).toBe(1);
    expect(plan.projectedBytesAfter).toBeLessThan(plan.bytesBefore);
  });

  it('never selects a record in use, a record whose cleaned-up form is invalid, or one that would not shrink', () => {
    const records: Probe[] = [
      { id: 'newest', timestamp: 1_000, payload: bulky },
      { id: 'in_use', timestamp: 0, payload: bulky },
      { id: 'invalid', timestamp: 0, payload: bulky, owner: 'changes' },
      { id: 'tiny', timestamp: 0 },
      { id: 'shrinks', timestamp: 0, payload: bulky },
    ];
    const changesOwner: RetentionPolicy<Probe> = {
      ...policy(),
      compact: (record, compactedAt) => ({
        ...record,
        payload: undefined,
        owner: record.owner ? 'someone else' : undefined,
        compactedAt,
      }),
    };

    const plan = planRetention(records, changesOwner, 1_000, { isInUse: (record) => record.id === 'in_use' });

    expect(plan).toMatchObject({ inUse: 1, invalid: 1, notSmaller: 1, candidateCount: 1 });
    expect(plan.candidates.map((candidate) => candidate.record.id)).toEqual(['shrinks']);
  });

  it('writes nothing without a grant and refuses a grant it did not issue', async () => {
    const save = jest.fn(async () => undefined);
    const retentionPolicy = policy(save);
    const plan = planRetention([
      { id: 'a', timestamp: 0, payload: bulky },
      { id: 'b', timestamp: 1, payload: bulky },
    ], retentionPolicy, 1_000);

    const measured = await executeRetentionPlan(plan, retentionPolicy, { grant: null });
    expect(measured).toMatchObject({ selected: 2, compacted: 0, stopped: 0 });
    await expect(executeRetentionPlan(plan, retentionPolicy, {
      grant: { personaId: 'persona_1', authorize: async () => true },
    })).rejects.toThrow('acquirePersonaRuntimeRetentionWriteGrant');
    expect(save).not.toHaveBeenCalled();
  });
});

const DAY_MS = 24 * 60 * 60 * 1_000;
const { cleanSweeps: GRADUATION_SWEEPS, spanMs: GRADUATION_SPAN_MS } = PERSONA_RUNTIME_RETENTION_GRADUATION;

function summary(overrides: Partial<PersonaRuntimeRetentionSweepSummary>): PersonaRuntimeRetentionSweepSummary {
  return { at: 0, mode: 'shadow', personas: 1, candidates: 10, compacted: 0, anomalies: [], ...overrides };
}

function measure(
  state: PersonaRuntimeRetentionState,
  runs: number,
  everyMs: number,
  startAt = 1_000,
): PersonaRuntimeRetentionState {
  let current = state;
  for (let run = 0; run < runs; run += 1) {
    current = afterPersonaRuntimeRetentionSweep(current, summary({ at: startAt + run * everyMs })).state;
  }
  return current;
}

describe('Persona history cleanup rollout rules', () => {
  it('switches cleanup on only after enough clean runs over enough days', () => {
    const quick = measure(initialPersonaRuntimeRetentionState(), GRADUATION_SWEEPS * 2, 60_000);
    expect(quick).toMatchObject({ mode: 'shadow', cleanSweeps: GRADUATION_SWEEPS * 2 });

    const few = measure(initialPersonaRuntimeRetentionState(), GRADUATION_SWEEPS - 1, DAY_MS);
    expect(few).toMatchObject({ mode: 'shadow', cleanSweeps: GRADUATION_SWEEPS - 1 });

    const interval = Math.ceil(GRADUATION_SPAN_MS / (GRADUATION_SWEEPS - 1));
    const almost = measure(initialPersonaRuntimeRetentionState(), GRADUATION_SWEEPS - 1, interval);
    const last = afterPersonaRuntimeRetentionSweep(
      almost,
      summary({ at: 1_000 + (GRADUATION_SWEEPS - 1) * interval }),
    );
    expect(last.transition).toBe('graduated');
    expect(last.state).toMatchObject({
      mode: 'active',
      cleanSweeps: GRADUATION_SWEEPS,
      streakStartedAt: 1_000,
      graduatedAt: 1_000 + (GRADUATION_SWEEPS - 1) * interval,
    });
  });

  it('starts a fresh streak after an anomaly while measuring, without counting a rollback', () => {
    const streak = measure(initialPersonaRuntimeRetentionState(), 5, DAY_MS);
    const { state, transition } = afterPersonaRuntimeRetentionAnomaly(streak, 'referenced', 9_000);

    expect(transition).toBeNull();
    expect(state).toMatchObject({
      mode: 'shadow',
      cleanSweeps: 0,
      rollbacks: 0,
      lastAnomaly: { kind: 'referenced', at: 9_000, mode: 'shadow' },
    });
    expect(state.streakStartedAt).toBeUndefined();
    expect(state.candidateBaseline).toBeUndefined();
  });

  it.each(['referenced', 'invalid', 'error', 'volume'] as const)(
    'goes back to measuring on a %s anomaly while cleaning up',
    (kind) => {
      const active: PersonaRuntimeRetentionState = {
        ...initialPersonaRuntimeRetentionState(),
        mode: 'active',
        cleanSweeps: GRADUATION_SWEEPS,
        streakStartedAt: 1,
        candidateBaseline: 40,
        graduatedAt: 2,
      };
      const { state, transition } = afterPersonaRuntimeRetentionAnomaly(active, kind, 3);

      expect(transition).toBe('rolled-back');
      expect(state).toMatchObject({ mode: 'shadow', cleanSweeps: 0, rollbacks: 1, lastAnomaly: { kind, mode: 'active' } });
      expect(state.graduatedAt).toBeUndefined();
      expect(personaRuntimeRetentionVolumeBudget(state)).toBeNull();
    },
  );

  it('allows at most twice the largest clean run plus a little, learning from every clean run', () => {
    const fresh = initialPersonaRuntimeRetentionState();
    expect(personaRuntimeRetentionVolumeBudget(fresh)).toBeNull();

    const first = afterPersonaRuntimeRetentionSweep(fresh, summary({ candidates: 40 })).state;
    expect(personaRuntimeRetentionVolumeBudget(first)).toBe(180);
    const smaller = afterPersonaRuntimeRetentionSweep(first, summary({ at: 1, candidates: 5 })).state;
    expect(personaRuntimeRetentionVolumeBudget(smaller)).toBe(180);
    const larger = afterPersonaRuntimeRetentionSweep(smaller, summary({ at: 2, candidates: 120 })).state;
    expect(personaRuntimeRetentionVolumeBudget(larger)).toBe(340);
  });

  it('does not count a run that found an anomaly or raced a change made elsewhere', () => {
    const streak = measure(initialPersonaRuntimeRetentionState(), 3, DAY_MS);

    const anomalous = afterPersonaRuntimeRetentionSweep(streak, summary({ at: 9, anomalies: ['error'] }));
    expect(anomalous.state.cleanSweeps).toBe(3);
    expect(anomalous.state.lastSweep).toMatchObject({ at: 9, anomalies: ['error'] });

    const raced = afterPersonaRuntimeRetentionSweep(streak, summary({ at: 10, mode: 'active', candidates: 999 }));
    expect(raced.state).toMatchObject({ mode: 'shadow', cleanSweeps: 3 });
    expect(personaRuntimeRetentionVolumeBudget(raced.state)).toBe(personaRuntimeRetentionVolumeBudget(streak));
  });

  it('restarts the streak when the clock moved back', () => {
    const streak = measure(initialPersonaRuntimeRetentionState(), 10, DAY_MS, 100 * DAY_MS);
    const { state } = afterPersonaRuntimeRetentionSweep(streak, summary({ at: DAY_MS }));
    expect(state).toMatchObject({ mode: 'shadow', cleanSweeps: 1, streakStartedAt: DAY_MS });
  });
});

const activity = (id: string, status: PersonaActivity['status'], extra: Partial<PersonaActivity> = {}) => ({
  id, personaId: 'persona_1', status, ...extra,
}) as PersonaActivity;
const item = (id: string, status: PersonaMailboxItem['status'], extra: Partial<PersonaMailboxItem> = {}) => ({
  id, personaId: 'persona_1', status, ...extra,
}) as PersonaMailboxItem;
const dispatch = (
  id: string,
  state: PersonaFlowDispatchRecord['state'],
  extra: Partial<PersonaFlowDispatchRecord> = {},
) => ({ id, personaId: 'persona_1', state, ...extra }) as PersonaFlowDispatchRecord;

function inUse(records: Partial<PersonaRuntimeRecords>) {
  const found = findPersonaRuntimeRecordsInUse({
    mailboxItems: [], activities: [], flowDispatches: [], behaviorCallPins: [], maintenanceRuns: [], ...records,
  });
  return {
    mailboxItems: [...found.mailboxItems].sort(),
    activities: [...found.activities].sort(),
    flowDispatches: [...found.flowDispatches].sort(),
    behaviorCallPins: [...found.behaviorCallPins].sort(),
  };
}

describe('records unfinished work still uses', () => {
  it('finds nothing in use once all work is finished and settled', () => {
    expect(inUse({
      activities: [activity('activity_1', 'completed')],
      mailboxItems: [item('item_1', 'completed', { claimedActivityId: 'activity_1' })],
      flowDispatches: [dispatch('dispatch_1', 'completed', {
        activityId: 'activity_1', mailboxItemId: 'item_1', terminalProjectionsSettledAt: 5,
      })],
    })).toEqual({ mailboxItems: [], activities: [], flowDispatches: [], behaviorCallPins: [] });
  });

  it('keeps an input whose delivery is pending or whose Activity still runs', () => {
    expect(inUse({
      activities: [activity('activity_running', 'running'), activity('activity_done', 'completed')],
      mailboxItems: [
        item('item_pending', 'coalesced', { targetActivityId: 'activity_done', deliveryStatus: 'pending' }),
        item('item_claimed_by_running', 'completed', { claimedActivityId: 'activity_running' }),
        item('item_interrupting', 'completed'),
        item('item_root', 'completed'),
        item('item_coalesced_waiting', 'queued', { coalescedIntoId: 'item_root' }),
      ],
    }).mailboxItems).toEqual(['item_claimed_by_running', 'item_pending', 'item_root']);

    expect(inUse({
      activities: [activity('activity_running', 'running', { interruptionRequestedByMailboxItemId: 'item_x' })],
      mailboxItems: [item('item_x', 'completed')],
    }).mailboxItems).toEqual(['item_x']);
  });

  it('keeps an Activity that an unsettled dispatch, a waiting input or an open maintenance run needs', () => {
    expect(inUse({
      activities: [
        activity('activity_unsettled', 'completed'),
        activity('activity_targeted', 'completed'),
        activity('activity_diagnosed', 'error'),
      ],
      mailboxItems: [item('item_queued', 'queued', { targetActivityId: 'activity_targeted' })],
      flowDispatches: [dispatch('dispatch_unsettled', 'completed', { activityId: 'activity_unsettled' })],
      maintenanceRuns: [
        { state: 'diagnosing', sourceActivityIds: ['activity_diagnosed'] } as BehaviorMaintenanceRun,
        { state: 'completed', sourceActivityIds: ['activity_targeted'] } as BehaviorMaintenanceRun,
      ],
    })).toMatchObject({
      activities: ['activity_diagnosed', 'activity_targeted', 'activity_unsettled'],
      flowDispatches: ['dispatch_unsettled'],
    });
  });

  it('keeps a dispatch or specialist call whose Activity is unfinished, but not an orphan receipt', () => {
    expect(inUse({
      activities: [activity('activity_running', 'running'), activity('activity_failed', 'error')],
      flowDispatches: [dispatch('dispatch_settled', 'completed', {
        activityId: 'activity_running', terminalProjectionsSettledAt: 1,
      })],
      behaviorCallPins: [
        { id: 'pin_child', activityId: 'activity_running', status: 'completed' } as BehaviorCallPin,
        { id: 'pin_orphan', activityId: 'activity_failed', status: 'running' } as BehaviorCallPin,
      ],
    })).toMatchObject({ flowDispatches: ['dispatch_settled'], behaviorCallPins: ['pin_child'] });
  });
});

describe('mailbox retries after compaction', () => {
  const original: PersonaMailboxItem = {
    schemaVersion: 1,
    id: 'mailbox_1',
    personaId: 'persona_1',
    idempotencyKey: 'a'.repeat(64),
    sequence: 1,
    kind: 'assignment',
    priority: 'normal',
    status: 'completed',
    source: { kind: 'assignment', sourceId: 'source_1' },
    behaviorSlotKey: 'primary',
    summary: 'Original request',
    createdAt: 1,
    updatedAt: 2,
    completedAt: 2,
  };
  const request = personaMailboxAdmission(original);

  it('matches the same request and rejects different work through the kept digest', () => {
    const compacted = getMailboxItemRetentionPolicy().compact(original, 3);
    expect(compacted.summary).toBeUndefined();
    expect(isSamePersonaMailboxAdmission(compacted, request)).toBe(true);
    expect(isSamePersonaMailboxAdmission(compacted, { ...request, summary: 'Other work' })).toBe(false);
  });

  it('still matches items compacted with the older digest on every field it kept', () => {
    const olderDigest = createHash('sha256').update(canonicalJson({
      idempotencyKey: original.idempotencyKey,
      personaId: original.personaId,
      status: original.status,
      deliveredAt: original.deliveredAt,
      completedAt: original.completedAt,
    })).digest('hex');
    const compacted: PersonaMailboxItem = {
      ...original,
      summary: undefined,
      compactedAt: 3,
      admissionDigest: olderDigest,
    };
    expect(isSamePersonaMailboxAdmission(compacted, request)).toBe(true);
    expect(isSamePersonaMailboxAdmission(compacted, { ...request, kind: 'scheduled' })).toBe(false);
  });
});
