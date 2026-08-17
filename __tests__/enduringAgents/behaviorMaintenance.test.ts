import { FEATURES } from '@/config/features';
import {
  BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT,
  BEHAVIOR_MAINTENANCE_DIAGNOSIS_LEASE_MS,
  BEHAVIOR_MAINTENANCE_RETENTION_MS,
  admitBehaviorMaintenanceRun,
  compactBehaviorMaintenanceRuns,
  diagnoseBehaviorMaintenanceRun,
  executeBehaviorMaintenanceRun,
  reconcileBehaviorMaintenanceRuns,
} from '@/backend/services/enduringAgents/behaviorMaintenance';
import { getBehaviorProposal } from '@/backend/services/enduringAgents/behaviorLearning';
import {
  getBehaviorRevision,
  getBehaviorMaintenanceRun,
  listBehaviorMaintenanceRuns,
  saveBehaviorMaintenanceRun,
  savePersonaActivity,
} from '@/backend/services/enduringAgents/store';
import { createPersonaFromRole } from './fixtures/personaFactory';
import {
  BehaviorMaintenanceRunSchema,
  type PersonaActivity,
  type PersonaActivityOutcomeResolution,
} from '@/shared/types/enduringAgent';
import { runWithWorkspace } from '@/utils/workspace';

type MutableMaintenanceFeatures = {
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION: boolean;
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS: boolean;
};

const maintenanceFeatures = FEATURES as unknown as MutableMaintenanceFeatures;
let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    'behavior-maintenance-' + process.pid + '-' + workspaceSequence,
    task,
  );
}

async function setupPersona() {
  const bundle = await createPersonaFromRole({
    name: 'Maintenance Persona',
    autonomyLevel: 'propose_overrides',
    idempotencyKey: 'maintenance-persona',
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected a primary Behavior binding.');
  const revision = await getBehaviorRevision(binding.activeRevisionId);
  if (!revision) throw new Error('Expected a primary Behavior revision.');
  return { persona: bundle.persona, revision };
}

function activity(input: {
  id: string;
  personaId: string;
  behaviorRevisionId: string;
  now: number;
  status?: 'completed' | 'error' | 'cancelled';
  resolution?: PersonaActivityOutcomeResolution;
  nextAction?: string;
  producer?: string;
}): PersonaActivity {
  const status = input.status ?? 'completed';
  const resolution = input.resolution ?? (status === 'error' ? 'failed' : 'succeeded');
  return {
    schemaVersion: 2,
    id: input.id,
    personaId: input.personaId,
    kind: 'assignment',
    status,
    source: { kind: 'assignment', sourceId: 'work_' + input.id },
    behaviorId: 'behavior_' + input.personaId,
    behaviorRevisionId: input.behaviorRevisionId,
    outcome: {
      schemaVersion: 1,
      resolution,
      ...(resolution === 'failed' ? { blockerKind: 'unknown' as const } : {}),
      summary: 'Sanitized Activity outcome.',
      ...(input.nextAction ? { nextAction: input.nextAction } : {}),
      decisionSource: 'engine',
      evidenceRefs: [{
        kind: 'activity',
        id: input.id,
        ...(input.producer ? { producer: input.producer } : {}),
      }],
      decidedAt: input.now,
    },
    createdAt: input.now,
    startedAt: input.now,
    updatedAt: input.now,
    completedAt: input.now,
    ...(status === 'error' ? { error: 'Sanitized Activity execution error.' } : {}),
  };
}

async function persistActivity(value: PersonaActivity): Promise<void> {
  await savePersonaActivity(value);
}

describe('Behavior maintenance lifecycle', () => {
  beforeEach(() => {
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = true;
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = true;
  });

  afterEach(() => {
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
  });

  it('does not write a run when admission and diagnosis are disabled', async () => {
    await inFreshWorkspace(async () => {
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      const setup = await setupPersona();
      const now = Date.now();
      const completed = activity({
        id: 'activity_disabled',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(completed);

      await expect(admitBehaviorMaintenanceRun(completed, now)).resolves.toBeNull();
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toEqual([]);
    });
  });

  it('never admits cancelled Activities', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const cancelled = activity({
        id: 'activity_cancelled',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
        status: 'cancelled',
        resolution: 'unknown',
      });
      await persistActivity(cancelled);

      await expect(admitBehaviorMaintenanceRun(cancelled, now)).resolves.toBeNull();
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toEqual([]);
    });
  });

  it('atomically coalesces concurrent admission into one active run', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const completed = activity({
        id: 'activity_concurrent',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(completed);

      const [left, right] = await Promise.all([
        admitBehaviorMaintenanceRun(completed, now),
        admitBehaviorMaintenanceRun(completed, now),
      ]);

      expect(left?.id).toBe(right?.id);
      expect(left?.state).toBe('queued');
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('claims, diagnoses, and terminalizes a run idempotently', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const completed = activity({
        id: 'activity_diagnosed',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(completed);
      const admitted = await admitBehaviorMaintenanceRun(completed, now);
      if (!admitted) throw new Error('Expected maintenance admission.');

      const diagnosed = await executeBehaviorMaintenanceRun(admitted.id, {
        now: now + 1,
        diagnose: async (claimed) => {
          expect(claimed).toMatchObject({
            state: 'diagnosing',
            attempts: 1,
            diagnosisLeaseId: expect.any(String),
          });
          expect(await getBehaviorMaintenanceRun(claimed.id)).toMatchObject({
            state: 'diagnosing',
            diagnosisLeaseId: claimed.diagnosisLeaseId,
          });
          return { action: 'no_change', reasonCode: 'focused_test_no_change' };
        },
      });
      expect(diagnosed).toMatchObject({
        state: 'completed',
        action: 'no_change',
        reasonCode: 'focused_test_no_change',
        attempts: 1,
        completedAt: now + 1,
      });
      expect(diagnosed?.diagnosisLeaseId).toBeUndefined();

      const repeated = await executeBehaviorMaintenanceRun(admitted.id, { now: now + 2 });
      expect(repeated).toEqual(diagnosed);
    });
  });

  it('recovers an expired diagnosis lease after restart without duplicating the run', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const completed = activity({
        id: 'activity_restart',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(completed);
      const admitted = await admitBehaviorMaintenanceRun(completed, now);
      if (!admitted) throw new Error('Expected maintenance admission.');
      await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...admitted,
        state: 'diagnosing',
        diagnosisLeaseId: 'maintlease_stale',
        diagnosisLeaseExpiresAt: now + BEHAVIOR_MAINTENANCE_DIAGNOSIS_LEASE_MS,
        reasonCode: 'diagnosis_in_progress',
        attempts: 1,
      }));

      const restartedAt = now + BEHAVIOR_MAINTENANCE_DIAGNOSIS_LEASE_MS + 1;
      await reconcileBehaviorMaintenanceRuns(setup.persona.id, restartedAt);
      const recovered = await getBehaviorMaintenanceRun(admitted.id);
      expect(recovered).toMatchObject({
        state: 'completed',
        action: 'no_change',
        reasonCode: 'goal_achieved_no_reusable_lesson',
        attempts: 2,
      });
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('fails closed for externally tainted evidence and malformed claims', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const tainted = activity({
        id: 'activity_tainted',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
        status: 'error',
        resolution: 'failed',
        producer: 'external_untrusted',
      });
      await persistActivity(tainted);
      const admitted = await admitBehaviorMaintenanceRun(tainted, now);
      if (!admitted) throw new Error('Expected maintenance admission.');

      await expect(diagnoseBehaviorMaintenanceRun(admitted)).resolves.toEqual({
        action: 'needs_human_diagnosis',
        reasonCode: 'external_untrusted_evidence',
      });
      await expect(executeBehaviorMaintenanceRun(admitted.id, { now: now + 1 }))
        .resolves.toMatchObject({
          state: 'completed',
          action: 'needs_human_diagnosis',
          reasonCode: 'external_untrusted_evidence',
        });
    });
  });

  it('terminalizes shadow-only admissions so later evidence windows are not blocked', async () => {
    await inFreshWorkspace(async () => {
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      const setup = await setupPersona();
      const now = Date.now();
      const first = activity({
        id: 'activity_shadow_one',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(first);
      const firstRun = await admitBehaviorMaintenanceRun(first, now);
      expect(firstRun).toMatchObject({
        state: 'completed',
        reasonCode: 'shadow_admission_only',
        action: 'no_change',
        completedAt: now,
      });

      const replayed = await admitBehaviorMaintenanceRun(first, now);
      expect(replayed).toEqual(firstRun);
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);

      const second = activity({
        id: 'activity_shadow_two',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
      });
      await persistActivity(second);
      const secondRun = await admitBehaviorMaintenanceRun(second, now + 1);
      expect(secondRun?.id).not.toBe(firstRun?.id);
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(2);
    });
  });

  it('repairs a legacy queued shadow admission before admitting a later window', async () => {
    await inFreshWorkspace(async () => {
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      const setup = await setupPersona();
      const now = Date.now();
      const first = activity({
        id: 'activity_legacy_shadow_one',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(first);
      const firstRun = await admitBehaviorMaintenanceRun(first, now);
      if (!firstRun) throw new Error('Expected shadow maintenance admission.');
      const legacySourceActivityIds = [...firstRun.sourceActivityIds];
      const legacyDigest = firstRun.sourceWindowDigest;
      await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...firstRun,
        state: 'queued',
        reasonCode: 'shadow_admission_only',
        action: undefined,
        completedAt: undefined,
      }));

      const second = activity({
        id: 'activity_legacy_shadow_two',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
      });
      await persistActivity(second);
      const secondRun = await admitBehaviorMaintenanceRun(second, now + 1);

      expect(await getBehaviorMaintenanceRun(firstRun.id)).toMatchObject({
        id: firstRun.id,
        state: 'completed',
        reasonCode: 'shadow_admission_only',
        action: 'no_change',
        sourceActivityIds: legacySourceActivityIds,
        sourceWindowDigest: legacyDigest,
        baseRevisionId: firstRun.baseRevisionId,
        createdAt: firstRun.createdAt,
        updatedAt: now + 1,
        completedAt: now + 1,
      });
      expect(secondRun).toMatchObject({
        state: 'completed',
        reasonCode: 'shadow_admission_only',
        action: 'no_change',
      });
      expect(secondRun?.id).not.toBe(firstRun.id);
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(2);
    });
  });

  it('does not repair an ordinary queued diagnosis run when diagnosis is disabled', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const first = activity({
        id: 'activity_pending_diagnosis_one',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(first);
      const pending = await admitBehaviorMaintenanceRun(first, now);
      if (!pending) throw new Error('Expected queued maintenance admission.');

      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      const second = activity({
        id: 'activity_pending_diagnosis_two',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
      });
      await persistActivity(second);
      const coalesced = await admitBehaviorMaintenanceRun(second, now + 1);

      expect(coalesced).toEqual(pending);
      expect(await getBehaviorMaintenanceRun(pending.id)).toMatchObject({
        state: 'queued',
        reasonCode: 'diagnosis_pending',
      });
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('terminalizes an in-flight run when diagnosis is disabled mid-flight', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const source = activity({
        id: 'activity_midflight_diagnosis_off',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(source);
      const pending = await admitBehaviorMaintenanceRun(source, now);
      if (!pending) throw new Error('Expected queued maintenance admission.');
      expect(pending).toMatchObject({ state: 'queued', reasonCode: 'diagnosis_pending' });

      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      await reconcileBehaviorMaintenanceRuns(setup.persona.id, now + 1);

      expect(await getBehaviorMaintenanceRun(pending.id)).toMatchObject({
        id: pending.id,
        state: 'completed',
        reasonCode: 'shadow_admission_only',
        updatedAt: now + 1,
        completedAt: now + 1,
      });
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('terminalizes an in-flight run when admission is disabled mid-flight', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const source = activity({
        id: 'activity_midflight_admission_off',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(source);
      const pending = await admitBehaviorMaintenanceRun(source, now);
      if (!pending) throw new Error('Expected queued maintenance admission.');

      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      const later = activity({
        id: 'activity_midflight_admission_off_two',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
      });
      await persistActivity(later);
      await expect(admitBehaviorMaintenanceRun(later, now + 1)).resolves.toBeNull();

      await reconcileBehaviorMaintenanceRuns(setup.persona.id, now + 2);

      expect(await getBehaviorMaintenanceRun(pending.id)).toMatchObject({
        id: pending.id,
        state: 'completed',
        reasonCode: 'shadow_admission_only',
        completedAt: now + 2,
      });
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('never strands or duplicates a run across repeated disabled reconciles', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const source = activity({
        id: 'activity_midflight_idempotent',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(source);
      const pending = await admitBehaviorMaintenanceRun(source, now);
      if (!pending) throw new Error('Expected queued maintenance admission.');

      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
      maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
      await reconcileBehaviorMaintenanceRuns(setup.persona.id, now + 1);
      const first = await getBehaviorMaintenanceRun(pending.id);
      expect(first).toMatchObject({ state: 'completed', attempts: 0 });

      await reconcileBehaviorMaintenanceRuns(setup.persona.id, now + 2);
      expect(await getBehaviorMaintenanceRun(pending.id)).toEqual(first);
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('does not repair a queued shadow admission while diagnosis is enabled', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const first = activity({
        id: 'activity_enabled_shadow_one',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(first);
      const pending = await admitBehaviorMaintenanceRun(first, now);
      if (!pending) throw new Error('Expected queued maintenance admission.');
      const legacyShadow = await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...pending,
        reasonCode: 'shadow_admission_only',
      }));

      const second = activity({
        id: 'activity_enabled_shadow_two',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
      });
      await persistActivity(second);
      const coalesced = await admitBehaviorMaintenanceRun(second, now + 1);

      expect(coalesced).toEqual(legacyShadow);
      expect(await getBehaviorMaintenanceRun(legacyShadow.id)).toMatchObject({
        state: 'queued',
        reasonCode: 'shadow_admission_only',
      });
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toHaveLength(1);
    });
  });

  it('compacts an aged awaiting-review run without changing its proposal or audit metadata', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const reusableLesson = 'Verify the focused change before reporting success.';
      const first = activity({
        id: 'activity_review_first',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
        status: 'error',
        resolution: 'failed',
        nextAction: reusableLesson,
      });
      const second = activity({
        id: 'activity_review_second',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now: now + 1,
        status: 'error',
        resolution: 'failed',
        nextAction: reusableLesson,
      });
      await persistActivity(first);
      await persistActivity(second);
      const admitted = await admitBehaviorMaintenanceRun(second, now + 1);
      if (!admitted) throw new Error('Expected maintenance admission.');

      await expect(diagnoseBehaviorMaintenanceRun(admitted)).resolves.toEqual({
        action: 'instruction_behavior_candidate',
        reasonCode: 'repeated_reusable_instruction_lesson',
        instruction: reusableLesson,
      });
      const awaitingReview = await executeBehaviorMaintenanceRun(admitted.id, { now: now + 2 });
      if (!awaitingReview) throw new Error('Expected review-pending maintenance run.');
      expect(awaitingReview).toMatchObject({
        state: 'awaiting_review',
        action: 'instruction_behavior_candidate',
        relatedProposalIds: [expect.any(String)],
      });
      expect(awaitingReview.completedAt).toBeUndefined();

      const proposalId = awaitingReview.relatedProposalIds[0];
      const proposalBefore = await getBehaviorProposal(proposalId);
      expect(proposalBefore).toMatchObject({
        id: proposalId,
        personaId: setup.persona.id,
        status: 'awaiting_approval',
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ kind: 'activity', id: first.id }),
          expect.objectContaining({ kind: 'activity', id: second.id }),
        ]),
        auditTrail: expect.arrayContaining([
          expect.objectContaining({ action: 'proposed' }),
        ]),
      });

      const compactAt = now + BEHAVIOR_MAINTENANCE_RETENTION_MS + 3;
      await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt)).resolves.toBe(1);
      const compacted = await getBehaviorMaintenanceRun(admitted.id);
      expect(BehaviorMaintenanceRunSchema.parse(compacted)).toEqual({
        ...awaitingReview,
        sourceActivityIds: [],
        updatedAt: compactAt,
        compactedAt: compactAt,
      });
      expect(compacted?.state).toBe('awaiting_review');
      expect(compacted?.completedAt).toBeUndefined();
      expect(await getBehaviorProposal(proposalId)).toEqual(proposalBefore);

      await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt + 1)).resolves.toBe(0);
      expect(await getBehaviorMaintenanceRun(admitted.id)).toEqual(compacted);
      expect(await getBehaviorProposal(proposalId)).toEqual(proposalBefore);
    });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'compacts expired %s detail while retaining audit metadata',
    async (state) => {
      await inFreshWorkspace(async () => {
        const setup = await setupPersona();
        const now = Date.now();
        const source = activity({
          id: 'activity_retention_' + state,
          personaId: setup.persona.id,
          behaviorRevisionId: setup.revision.id,
          now,
        });
        await persistActivity(source);
        const admitted = await admitBehaviorMaintenanceRun(source, now);
        if (!admitted) throw new Error('Expected maintenance admission.');
        const terminalAt = now + 1;
        const terminal = await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
          ...admitted,
          state,
          reasonCode: 'retention_' + state,
          action: state === 'completed' ? 'no_change' : undefined,
          updatedAt: terminalAt,
          completedAt: terminalAt,
        }));

        const compactAt = terminalAt + BEHAVIOR_MAINTENANCE_RETENTION_MS + 1;
        await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt)).resolves.toBe(1);
        expect(await getBehaviorMaintenanceRun(admitted.id)).toEqual({
          ...terminal,
          sourceActivityIds: [],
          updatedAt: compactAt,
          compactedAt: compactAt,
        });
      });
    },
  );

  it('uses updatedAt for the strict awaiting-review retention cutoff', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const source = activity({
        id: 'activity_cutoff_exact',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(source);
      const admitted = await admitBehaviorMaintenanceRun(source, now);
      if (!admitted) throw new Error('Expected maintenance admission.');
      const cutoff = now + 1_000;
      const exact = await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...admitted,
        state: 'awaiting_review',
        reasonCode: 'cutoff_exact',
        action: 'instruction_behavior_candidate',
        updatedAt: cutoff,
      }));
      const older = await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...exact,
        id: 'maint_cutoff_older',
        sourceActivityIds: ['activity_cutoff_older'],
        reasonCode: 'cutoff_older',
        updatedAt: cutoff - 1,
      }));
      const compactAt = cutoff + BEHAVIOR_MAINTENANCE_RETENTION_MS;

      await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt)).resolves.toBe(1);
      expect(await getBehaviorMaintenanceRun(exact.id)).toEqual(exact);
      expect(await getBehaviorMaintenanceRun(older.id)).toEqual({
        ...older,
        sourceActivityIds: [],
        updatedAt: compactAt,
        compactedAt: compactAt,
      });
    });
  });

  it('retains only the newest 100 detailed runs across all compactable states', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const now = Date.now();
      const source = activity({
        id: 'activity_limit_template',
        personaId: setup.persona.id,
        behaviorRevisionId: setup.revision.id,
        now,
      });
      await persistActivity(source);
      const admitted = await admitBehaviorMaintenanceRun(source, now);
      if (!admitted) throw new Error('Expected maintenance admission.');
      const states = ['completed', 'failed', 'cancelled', 'awaiting_review'] as const;

      for (let index = 0; index <= BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT; index += 1) {
        const state = states[index % states.length];
        const timestamp = now + index + 1;
        const suffix = index.toString().padStart(3, '0');
        await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
          ...admitted,
          id: 'maint_limit_' + suffix,
          sourceActivityIds: ['activity_limit_' + suffix],
          state,
          reasonCode: 'retention_limit_' + state,
          action: state === 'awaiting_review' ? 'instruction_behavior_candidate' : 'no_change',
          createdAt: now,
          updatedAt: timestamp,
          completedAt: state === 'awaiting_review' ? undefined : timestamp,
        }));
      }

      const alreadyCompacted = await saveBehaviorMaintenanceRun(BehaviorMaintenanceRunSchema.parse({
        ...admitted,
        id: 'maint_limit_already_compacted',
        sourceActivityIds: [],
        state: 'awaiting_review',
        reasonCode: 'retention_limit_already_compacted',
        action: 'instruction_behavior_candidate',
        createdAt: now,
        updatedAt: now + 150,
        compactedAt: now + 150,
      }));
      const compactAt = now + 200;

      await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt)).resolves.toBe(1);
      const limitRuns = (await listBehaviorMaintenanceRuns(setup.persona.id))
        .filter((run) => run.id.startsWith('maint_limit_'));
      expect(limitRuns.filter((run) => run.compactedAt === undefined))
        .toHaveLength(BEHAVIOR_MAINTENANCE_DETAILED_RUN_LIMIT);
      expect(limitRuns.filter((run) => run.compactedAt !== undefined)).toHaveLength(2);
      expect(await getBehaviorMaintenanceRun('maint_limit_000')).toMatchObject({
        state: 'completed',
        sourceActivityIds: [],
        compactedAt: compactAt,
      });
      const retainedReviewRun = await getBehaviorMaintenanceRun('maint_limit_099');
      expect(retainedReviewRun).toMatchObject({
        state: 'awaiting_review',
        sourceActivityIds: ['activity_limit_099'],
      });
      expect(retainedReviewRun?.compactedAt).toBeUndefined();
      expect(await getBehaviorMaintenanceRun(alreadyCompacted.id)).toEqual(alreadyCompacted);
      await expect(compactBehaviorMaintenanceRuns(setup.persona.id, compactAt + 1)).resolves.toBe(0);
    });
  });
});
