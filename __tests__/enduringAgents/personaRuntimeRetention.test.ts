import {
  readPersonaRuntimeRetentionConfig,
} from '@/config/features';
import {
  getPersonaRetentionCohort,
  getPersonaRetentionEligibility,
  isPersonaInRetentionCohort,
} from '@/backend/services/enduringAgents/personaRuntimeRetentionCohort';
import {
  executeRetentionPlan,
  planRetention,
  type RetentionPolicy,
} from '@/backend/services/enduringAgents/retention';

interface Probe {
  id: string;
  timestamp: number;
  payload?: string;
  compactedAt?: number;
}

function policy(save: (record: Probe) => Promise<unknown>): RetentionPolicy<Probe> {
  return {
    recordKind: 'Probe',
    isEligible: (record) => record.compactedAt === undefined,
    timestampOf: (record) => record.timestamp,
    isCompacted: (record) => record.compactedAt !== undefined,
    retentionMs: 100,
    detailedLimit: 1,
    maxWritesPerSweep: 3,
    compact: (record, compactedAt) => ({
      ...record,
      payload: undefined,
      compactedAt,
    }),
    save,
  };
}

describe('Persona runtime retention rollout primitives', () => {
  it('fails malformed deployment configuration closed without clamping', () => {
    expect(readPersonaRuntimeRetentionConfig({
      FLUJO_PERSONA_RUNTIME_RETENTION_MODE: 'active',
      FLUJO_PERSONA_RUNTIME_RETENTION_BASIS_POINTS: '10001',
    })).toMatchObject({ mode: 'disabled', rolloutBasisPoints: 0 });

    expect(readPersonaRuntimeRetentionConfig({
      FLUJO_PERSONA_RUNTIME_RETENTION_MODE: 'active',
      FLUJO_PERSONA_RUNTIME_RETENTION_BASIS_POINTS: '100',
      FLUJO_PERSONA_RUNTIME_RETENTION_CRITICAL_PERSONA_IDS: 'persona_1,persona_2',
    })).toEqual({
      mode: 'active',
      rolloutBasisPoints: 100,
      cohortVersion: 'persona-runtime-retention-v1',
      criticalPersonaIds: ['persona_1', 'persona_2'],
    });
  });

  it('assigns stable workspace-separated cohorts with exact boundaries', () => {
    const first = getPersonaRetentionCohort({
      workspaceId: 'workspace_1',
      personaId: 'persona_1',
    });
    const repeated = getPersonaRetentionCohort({
      workspaceId: 'workspace_1',
      personaId: 'persona_1',
    });
    const otherWorkspace = getPersonaRetentionCohort({
      workspaceId: 'workspace_2',
      personaId: 'persona_1',
    });

    expect(repeated).toEqual(first);
    expect(otherWorkspace.bucket).not.toBe(first.bucket);
    expect(isPersonaInRetentionCohort(first, 0)).toBe(false);
    expect(isPersonaInRetentionCohort(first, 10_000)).toBe(true);
    expect(isPersonaInRetentionCohort(first, first.bucket)).toBe(false);
    expect(isPersonaInRetentionCohort(first, first.bucket + 1)).toBe(true);
  });

  it('uses only the explicit critical-Persona source', () => {
    const eligibility = getPersonaRetentionEligibility({
      workspaceId: 'workspace_1',
      personaId: 'persona_critical',
      cohortVersion: 'v1',
      rolloutBasisPoints: 10_000,
      criticalPersonaIds: ['persona_critical'],
    });
    expect(eligibility).toMatchObject({
      eligible: false,
      reason: 'critical',
    });
  });

  it('creates deterministic capped plans with age/rank reasons and byte projections', () => {
    const save = jest.fn(async () => undefined);
    const records: Probe[] = [
      { id: 'newer', timestamp: 1_000, payload: 'x'.repeat(100) },
      { id: 'tie_b', timestamp: 900, payload: 'x'.repeat(100) },
      { id: 'tie_a', timestamp: 900, payload: 'x'.repeat(100) },
      { id: 'old', timestamp: 100, payload: 'x'.repeat(100) },
      { id: 'oldest', timestamp: 0, payload: 'x'.repeat(100) },
    ];

    const plan = planRetention(records, policy(save), 1_000);

    expect(plan.candidateCount).toBe(4);
    expect(plan.candidates.map((candidate) => candidate.record.id)).toEqual([
      'tie_b',
      'tie_a',
      'old',
    ]);
    expect(plan.candidates.map((candidate) => candidate.reason)).toEqual([
      'rank',
      'rank',
      'age-and-rank',
    ]);
    expect(plan.skipped).toBe(1);
    expect(plan.projectedBytesAfter).toBeLessThan(plan.bytesBefore);
  });

  it('uses one plan for shadow and active while shadow performs zero saves', async () => {
    const save = jest.fn(async () => undefined);
    const retentionPolicy = policy(save);
    const plan = planRetention([
      { id: 'a', timestamp: 0, payload: 'secret' },
      { id: 'b', timestamp: 1, payload: 'secret' },
    ], retentionPolicy, 1_000);

    const shadow = await executeRetentionPlan(plan, retentionPolicy, {
      shadow: true,
    });
    expect(shadow.selected).toBe(plan.candidates.length);
    expect(shadow.compacted).toBe(0);
    expect(save).not.toHaveBeenCalled();

    const active = await executeRetentionPlan(plan, retentionPolicy);
    expect(active.selected).toBe(shadow.selected);
    expect(active.compacted).toBe(plan.candidates.length);
  });

  it('stops all remaining writes when authorization is disabled mid-plan', async () => {
    const save = jest.fn(async () => undefined);
    const retentionPolicy = policy(save);
    const plan = planRetention([
      { id: 'a', timestamp: 0 },
      { id: 'b', timestamp: 1 },
      { id: 'c', timestamp: 2 },
    ], retentionPolicy, 1_000);
    let checks = 0;

    const result = await executeRetentionPlan(plan, retentionPolicy, {
      authorizeWrite: () => {
        checks += 1;
        return checks === 1;
      },
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(result.compacted).toBe(1);
    expect(result.unauthorized).toBe(2);
  });
});
