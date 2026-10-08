import {
  BEHAVIOR_OUTCOME_DETECTOR_ACTOR,
  BEHAVIOR_OUTCOME_MIN_SAMPLES,
  activateBehaviorProposal,
  approveBehaviorProposal,
  behaviorOutcomeMetricId,
  createBehaviorProposal,
  getBehaviorProposal,
  recordBehaviorOutcomeSample,
  rollbackBehaviorProposal,
  type BehaviorProposalCompileResult,
  type CreateBehaviorProposalInput,
} from '@/backend/services/enduringAgents';
import {
  DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS,
  admitBehaviorMaintenanceRun,
} from '@/backend/services/enduringAgents/behaviorMaintenance';
import {
  behaviorRevisionId,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import {
  activateBehaviorBindingRevision,
  createBehaviorRevision,
  getBehaviorBinding,
  getBehaviorOutcomeMetric,
  getBehaviorRevision,
  getPersona,
  listBehaviorOutcomeMetrics,
  savePersonaActivity,
  updatePersona,
} from '@/backend/services/enduringAgents/store';
import { FEATURES } from '@/config/features';
import {
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
  PERSONA_ACTIVITY_SCHEMA_VERSION,
  type BehaviorProposal,
  type PersonaActivity,
  type PersonaAutonomyLevel,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

let workspaceSequence = 0;

function freshWorkspaceId(): string {
  workspaceSequence += 1;
  return 'enduring-behavior-outcome-' + process.pid + '-' + workspaceSequence;
}

function inFreshWorkspace<T>(task: (workspaceId: string) => T): T {
  const workspaceId = freshWorkspaceId();
  return runWithWorkspace(workspaceId, () => task(workspaceId));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function processNode(flow: Flow): FlowNode {
  const node = flow.nodes.find((candidate) => candidate.type === 'process');
  if (!node) throw new Error('Expected a process node.');
  return node;
}

async function setupPersona(autonomyLevel: PersonaAutonomyLevel = 'propose_overrides') {
  const bundle = await createPersonaFromRole({
    name: 'Jim',
    autonomyLevel,
    idempotencyKey: 'jim-outcome-' + autonomyLevel,
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected the primary Behavior.');
  const baseRevision = await getBehaviorRevision(binding.activeRevisionId);
  if (!baseRevision) throw new Error('Expected the active Behavior revision.');
  return { bundle, binding, baseRevision };
}

type PersonaSetup = Awaited<ReturnType<typeof setupPersona>>;

function passingCompiler(baseFlow: Flow): () => Promise<BehaviorProposalCompileResult> {
  return async () => {
    const flow = clone(baseFlow);
    const node = processNode(flow);
    node.data.properties = {
      ...node.data.properties,
      promptTemplate: 'Inspect evidence, implement carefully, and verify the focused change.',
    };
    return { success: true, flow, errorCount: 0, warningCount: 0, issues: [] };
  };
}

function proposalInput(setup: PersonaSetup): CreateBehaviorProposalInput {
  return {
    personaId: setup.bundle.persona.id,
    behaviorId: setup.binding.id,
    baseBehaviorRevisionId: setup.baseRevision.id,
    rationale: 'A repeated implementation mistake shows that explicit focused verification is needed.',
    evidenceRefs: [{
      kind: 'activity',
      id: 'activity_verified_failure',
      observedAt: 1_786_400_000_000,
    }],
    candidateSpec: { lesson: 'verify focused change' },
    evals: [{
      id: 'prompt-contains-verification',
      run: ({ candidateFlow }) => ({
        passed: processNode(candidateFlow).data.properties?.promptTemplate
          === 'Inspect evidence, implement carefully, and verify the focused change.',
      }),
    }],
    actor: 'maintenance-activity',
  };
}

async function activatedProposal(setup: PersonaSetup): Promise<BehaviorProposal> {
  const proposal = await createBehaviorProposal(
    proposalInput(setup),
    { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
  );
  await approveBehaviorProposal(proposal.id, {
    actor: 'reviewer:alice',
    reason: 'The evidence, Flow diff, validation, and deterministic eval are acceptable.',
  });
  return activateBehaviorProposal(proposal.id);
}

function terminalActivity(options: {
  id: string;
  setup: PersonaSetup;
  revisionId: string;
  succeeded: boolean;
  at?: number;
}): PersonaActivity {
  const at = options.at ?? Date.now();
  return {
    schemaVersion: PERSONA_ACTIVITY_SCHEMA_VERSION,
    id: options.id,
    personaId: options.setup.bundle.persona.id,
    kind: 'assignment',
    status: 'completed',
    source: { kind: 'assignment' },
    behaviorId: options.setup.binding.id,
    behaviorRevisionId: options.revisionId,
    outcome: {
      schemaVersion: PERSONA_ACTIVITY_OUTCOME_SCHEMA_VERSION,
      resolution: options.succeeded ? 'succeeded' : 'failed',
      ...(options.succeeded ? {} : { blockerKind: 'unknown' as const }),
      decisionSource: 'engine',
      evidenceRefs: [],
      decidedAt: at,
    },
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    completedAt: at,
  };
}

/** Persist historical Activities so the baseline snapshot can measure them. */
async function seedBaseline(
  setup: PersonaSetup,
  options: { succeeded: number; failed: number },
): Promise<void> {
  const at = Date.now() - 60_000;
  for (let index = 0; index < options.succeeded; index += 1) {
    await savePersonaActivity(terminalActivity({
      id: 'activity_base_ok_' + index,
      setup,
      revisionId: setup.baseRevision.id,
      succeeded: true,
      at,
    }));
  }
  for (let index = 0; index < options.failed; index += 1) {
    await savePersonaActivity(terminalActivity({
      id: 'activity_base_bad_' + index,
      setup,
      revisionId: setup.baseRevision.id,
      succeeded: false,
      at,
    }));
  }
}

async function observeSamples(
  setup: PersonaSetup,
  revisionId: string,
  options: { succeeded: number; failed: number; prefix?: string },
): Promise<void> {
  const prefix = options.prefix ?? 'activity_after';
  for (let index = 0; index < options.succeeded; index += 1) {
    await recordBehaviorOutcomeSample(terminalActivity({
      id: prefix + '_ok_' + index,
      setup,
      revisionId,
      succeeded: true,
    }));
  }
  for (let index = 0; index < options.failed; index += 1) {
    await recordBehaviorOutcomeSample(terminalActivity({
      id: prefix + '_bad_' + index,
      setup,
      revisionId,
      succeeded: false,
    }));
  }
}

function metricFor(proposal: BehaviorProposal) {
  return getBehaviorOutcomeMetric(behaviorOutcomeMetricId(proposal.id));
}

describe('Behavior outcome metrics and automatic rollback', () => {
  const originalMetrics = FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS;
  const originalAutoRollback = FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK;
  const originalMaintenanceAdmission = FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION;

  beforeEach(() => {
    FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = true;
    FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = false;
  });

  afterEach(() => {
    FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = originalMetrics;
    FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = originalAutoRollback;
    FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = originalMaintenanceAdmission;
  });

  it('freezes the baseline of the previous revision when a proposal is activated', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 9, failed: 1 });

      const activated = await activatedProposal(setup);
      const metric = await metricFor(activated);
      const activatedRevision = await getBehaviorRevision(activated.activatedRevisionId!);

      expect(metric).toMatchObject({
        personaId: setup.bundle.persona.id,
        behaviorId: setup.binding.id,
        proposalId: activated.id,
        baseBehaviorRevisionId: setup.baseRevision.id,
        baseContentHash: setup.baseRevision.contentHash,
        activatedRevisionId: activated.activatedRevisionId,
        activatedContentHash: activatedRevision!.contentHash,
        verdict: 'pending',
        baseline: { samples: 10, succeeded: 9, failed: 1, successRate: 0.9 },
        observed: { samples: 0, successRate: 0 },
        countedActivityIds: [],
      });
      // Activation is idempotent, so the metric must not be recreated.
      await activateBehaviorProposal(activated.id);
      expect((await metricFor(activated))?.createdAt).toBe(metric!.createdAt);
    });
  });

  it('counts only terminal Activities pinned to the exact activated revision', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 2, failed: 1 });
      // An Activity that still ran on the earlier revision must be ignored.
      await recordBehaviorOutcomeSample(terminalActivity({
        id: 'activity_other_revision',
        setup,
        revisionId: setup.baseRevision.id,
        succeeded: false,
      }));

      expect(await metricFor(activated)).toMatchObject({
        observed: { samples: 3, succeeded: 2, failed: 1, successRate: 0.666667 },
        verdict: 'insufficient_samples',
      });
    });
  });

  it('counts one Activity once even when the terminal projection retries', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);
      const activity = terminalActivity({
        id: 'activity_retried',
        setup,
        revisionId: activated.activatedRevisionId!,
        succeeded: true,
      });

      await recordBehaviorOutcomeSample(activity);
      await recordBehaviorOutcomeSample(activity);

      const metric = await metricFor(activated);
      expect(metric?.observed.samples).toBe(1);
      expect(metric?.countedActivityIds).toEqual(['activity_retried']);
    });
  });

  it('takes no action below the minimum sample size, however bad the results are', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, {
        succeeded: 0,
        failed: BEHAVIOR_OUTCOME_MIN_SAMPLES - 1,
      });

      const metric = await metricFor(activated);
      expect(metric?.verdict).toBe('insufficient_samples');
      expect(metric?.observed.samples).toBe(BEHAVIOR_OUTCOME_MIN_SAMPLES - 1);
      expect(metric?.autoRollbackAt).toBeUndefined();
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);
      expect((await getBehaviorProposal(activated.id))?.status).toBe('activated');
    });
  });

  it('reverts a regressed proposal automatically and records why', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
      FEATURES.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = true;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 0, failed: 10 });

      const metric = await metricFor(activated);
      expect(metric?.verdict).toBe('rolled_back');
      expect(metric?.autoRollbackAt).toEqual(expect.any(Number));
      expect(metric?.verdictReason).toContain('100.0%');
      expect(metric?.verdictReason).toContain('0.0%');
      expect(metric?.verdictReason).toContain('n=10');

      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.baseRevision.id);
      const proposal = await getBehaviorProposal(activated.id);
      expect(proposal).toMatchObject({
        status: 'rolled_back',
        rollbackRevisionId: setup.baseRevision.id,
        activatedRevisionId: activated.activatedRevisionId,
      });
      expect(proposal!.auditTrail.at(-1)).toMatchObject({
        action: 'auto_rolled_back',
        actor: BEHAVIOR_OUTCOME_DETECTOR_ACTOR,
        revisionId: setup.baseRevision.id,
      });

      const cooldownCandidate = terminalActivity({
        id: 'activity_rolled_back_cooldown',
        setup,
        revisionId: activated.activatedRevisionId!,
        succeeded: false,
        at: metric!.autoRollbackAt!,
      });
      await savePersonaActivity(cooldownCandidate);
      const admitted = await admitBehaviorMaintenanceRun(
        cooldownCandidate,
        metric!.autoRollbackAt!,
      );
      expect(admitted?.sourceActivityIds).not.toContain(cooldownCandidate.id);
      expect(admitted?.suppressedCandidates).toContainEqual({
        activityId: cooldownCandidate.id,
        activatedRevisionId: activated.activatedRevisionId,
        proposalId: activated.id,
        metricId: metric!.id,
        reasonCode: 'auto_rollback_cooldown',
        autoRollbackAt: metric!.autoRollbackAt,
        cooldownUntil: metric!.autoRollbackAt! + DEFAULT_BEHAVIOR_AUTO_ROLLBACK_COOLDOWN_MS,
      });

      // Terminal: later samples cannot reopen the measurement.
      await observeSamples(setup, activated.activatedRevisionId!, {
        succeeded: 1,
        failed: 0,
        prefix: 'activity_late',
      });
      expect((await metricFor(activated))?.observed.samples).toBe(10);
    });
  });

  it('records a regression without acting while the rollback flag is off', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 0, failed: 10 });

      expect(await metricFor(activated)).toMatchObject({
        verdict: 'regressed',
        observed: { samples: 10, succeeded: 0, successRate: 0 },
      });
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);
      expect((await getBehaviorProposal(activated.id))?.status).toBe('activated');
    });
  });

  it('keeps a genuine improvement in place with visible before and after numbers', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 5, failed: 5 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 9, failed: 1 });

      expect(await metricFor(activated)).toMatchObject({
        verdict: 'improved',
        baseline: { samples: 10, successRate: 0.5 },
        observed: { samples: 10, successRate: 0.9 },
      });
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);
      expect((await getBehaviorProposal(activated.id))?.status).toBe('activated');
    });
  });

  it('never reverts automatically for a Persona whose review setting forbids it', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);
      const persona = await getPersona(setup.bundle.persona.id);
      await updatePersona({
        ...persona!,
        autonomyLevel: 'locked',
        updatedAt: Math.max(Date.now(), persona!.updatedAt + 1),
      });

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 0, failed: 10 });

      const metric = await metricFor(activated);
      expect(metric?.verdict).toBe('regressed');
      expect(metric?.autoRollbackAt).toBeUndefined();
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);

      // The manual undo path is unaffected by the autonomy gate.
      const undone = await rollbackBehaviorProposal(activated.id, {
        actor: 'persona-owner',
        reason: 'Undone from the Persona Improvements screen.',
      });
      expect(undone.status).toBe('rolled_back');
      expect(undone.auditTrail.at(-1)).toMatchObject({ action: 'rolled_back' });
    });
  });

  it('fails closed when the Behavior moved out from under the detector', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_AUTO_ROLLBACK = true;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      const competing = clone(setup.baseRevision.flowSnapshot);
      processNode(competing).data.properties = {
        ...processNode(competing).data.properties,
        promptTemplate: 'A competing revision activated by someone else.',
      };
      const flowSnapshot = snapshotBehaviorFlow(competing);
      const contentHash = hashBehaviorFlow(flowSnapshot);
      const competingRevision = await createBehaviorRevision({
        schemaVersion: BEHAVIOR_REVISION_SCHEMA_VERSION,
        id: behaviorRevisionId({
          personaId: setup.bundle.persona.id,
          behaviorId: setup.binding.id,
          revision: 3,
          contentHash,
        }),
        behaviorId: setup.binding.id,
        personaId: setup.bundle.persona.id,
        slotKey: setup.binding.slotKey,
        revision: 3,
        contentHash,
        flowSnapshot,
        source: {
          kind: 'persona_override',
          parentRevisionId: activated.activatedRevisionId,
          evidenceRefs: ['competing-activation'],
        },
        createdAt: Date.now(),
      });
      await activateBehaviorBindingRevision({
        personaId: setup.bundle.persona.id,
        behaviorId: setup.binding.id,
        revisionId: competingRevision.id,
        expectedActiveRevisionId: activated.activatedRevisionId!,
      });

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 0, failed: 10 });

      const metric = await metricFor(activated);
      expect(metric?.verdict).toBe('regressed');
      expect(metric?.verdictReason).toContain('changed while');
      expect(metric?.autoRollbackAt).toBeUndefined();
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(competingRevision.id);
      expect((await getBehaviorProposal(activated.id))?.status).toBe('activated');
    });
  });

  it('keeps outcome metrics inside the workspace that recorded them', async () => {
    const personaId = await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);
      expect(await listBehaviorOutcomeMetrics(setup.bundle.persona.id))
        .toHaveLength(1);
      expect(activated.status).toBe('activated');
      return setup.bundle.persona.id;
    });

    await runWithWorkspace(freshWorkspaceId(), async () => {
      expect(await listBehaviorOutcomeMetrics(personaId)).toEqual([]);
    });
  });

  it('records nothing at all while the recording flag is off', async () => {
    await inFreshWorkspace(async () => {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = false;
      const setup = await setupPersona();
      await seedBaseline(setup, { succeeded: 10, failed: 0 });
      const activated = await activatedProposal(setup);

      await observeSamples(setup, activated.activatedRevisionId!, { succeeded: 0, failed: 10 });

      expect(await listBehaviorOutcomeMetrics(setup.bundle.persona.id)).toEqual([]);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);
    });
  });
});
