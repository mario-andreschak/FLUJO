import {
  BehaviorLearningPolicyError,
  activateBehaviorProposal,
  approveBehaviorProposal,
  createProceduralHint,
  getBehaviorProposal,
  listBehaviorProposals,
  suggestBehaviorInstructionImprovement,
} from '@/backend/services/enduringAgents';
import {
  admitBehaviorMaintenanceRun,
  executeBehaviorMaintenanceRun,
} from '@/backend/services/enduringAgents/behaviorMaintenance';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  getBehaviorBinding,
  getBehaviorRevision,
  listBehaviorMaintenanceRuns,
} from '@/backend/services/enduringAgents/store';
import { FEATURES } from '@/config/features';
import {
  type PersonaActivity,
  type PersonaActivityOutcomeResolution,
  type PersonaAutonomyLevel,
} from '@/shared/types/enduringAgent';
import { saveCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

/**
 * The rollout gates are plain mutable module state, so the enabled path is
 * exercised by flipping them directly (the same convention as
 * `behaviorMaintenance.test.ts`). Every test restores them in `afterEach`
 * because `FEATURES` is a shared singleton inside one Jest worker.
 */
type MutableMaintenanceFeatures = {
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION: boolean;
  ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS: boolean;
};

const maintenanceFeatures = FEATURES as unknown as MutableMaintenanceFeatures;
const REUSABLE_LESSON = 'Run the focused regression test before reporting completion.';
let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    'behavior-self-improvement-' + process.pid + '-' + workspaceSequence,
    task,
  );
}

async function setupPersona(autonomyLevel: PersonaAutonomyLevel = 'propose_overrides') {
  const bundle = await createPersonaFromRole({
    name: 'Self-improving Persona',
    autonomyLevel,
    idempotencyKey: 'self-improvement-' + autonomyLevel,
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected a primary Behavior binding.');
  const revision = await getBehaviorRevision(binding.activeRevisionId);
  if (!revision) throw new Error('Expected a primary Behavior revision.');
  return { persona: bundle.persona, binding, revision };
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
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.activities, value.id, value);
}

/**
 * Persist two failed Activities that share one reusable next action, which is
 * the only shape the closed diagnosis router turns into an instruction
 * candidate.
 */
async function persistRepeatedLesson(
  personaId: string,
  behaviorRevisionId: string,
  now: number,
  idPrefix: string,
): Promise<PersonaActivity[]> {
  const first = activity({
    id: idPrefix + '_one',
    personaId,
    behaviorRevisionId,
    now,
    status: 'error',
    resolution: 'failed',
    nextAction: REUSABLE_LESSON,
  });
  const second = activity({
    id: idPrefix + '_two',
    personaId,
    behaviorRevisionId,
    now: now + 1,
    status: 'error',
    resolution: 'failed',
    nextAction: REUSABLE_LESSON,
  });
  await persistActivity(first);
  await persistActivity(second);
  return [first, second];
}

describe('Persona self-improvement with both rollout gates enabled', () => {
  beforeEach(() => {
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = true;
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = true;
  });

  afterEach(() => {
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_ADMISSION = false;
    maintenanceFeatures.ENABLE_PERSONA_BEHAVIOR_MAINTENANCE_DIAGNOSIS = false;
  });

  it('drives the full chain from Activity outcomes to an activated Behavior revision', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('propose_overrides');
      const now = Date.now();
      const [first, second] = await persistRepeatedLesson(
        setup.persona.id,
        setup.revision.id,
        now,
        'activity_e2e',
      );

      const admitted = await admitBehaviorMaintenanceRun(second, now + 1);
      expect(admitted).toMatchObject({
        personaId: setup.persona.id,
        state: 'queued',
        reasonCode: 'diagnosis_pending',
        baseRevisionId: setup.revision.id,
        relatedProposalIds: [],
        attempts: 0,
      });
      if (!admitted) throw new Error('Expected maintenance admission.');

      const diagnosed = await executeBehaviorMaintenanceRun(admitted.id, { now: now + 2 });
      expect(diagnosed).toMatchObject({
        id: admitted.id,
        state: 'awaiting_review',
        action: 'instruction_behavior_candidate',
        reasonCode: 'repeated_reusable_instruction_lesson',
        relatedProposalIds: [expect.any(String)],
        attempts: 1,
      });
      expect(diagnosed?.diagnosisLeaseId).toBeUndefined();
      expect(diagnosed?.diagnosisLeaseExpiresAt).toBeUndefined();
      expect(diagnosed?.completedAt).toBeUndefined();

      const proposalId = diagnosed!.relatedProposalIds[0];
      const drafted = await getBehaviorProposal(proposalId);
      expect(drafted).toMatchObject({
        personaId: setup.persona.id,
        behaviorId: setup.binding.id,
        baseBehaviorRevisionId: setup.revision.id,
        status: 'awaiting_approval',
        provenance: {
          origin: 'persona_tool',
          diffRiskClass: 'instruction_only',
          policyDecisionCode: 'owner_approval_required',
        },
        validation: { compileSucceeded: true },
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({ kind: 'activity', id: first.id }),
          expect.objectContaining({ kind: 'activity', id: second.id }),
        ]),
      });
      expect(drafted?.evalResults.length).toBeGreaterThan(0);
      expect(drafted?.evalResults.every((result) => result.passed)).toBe(true);

      const approved = await approveBehaviorProposal(proposalId, {
        actor: 'reviewer:alice',
        reason: 'The evidence, bounded instruction diff, and deterministic eval are acceptable.',
      });
      expect(approved.status).toBe('approved');

      const activated = await activateBehaviorProposal(proposalId);
      expect(activated).toMatchObject({
        status: 'activated',
        approval: { kind: 'manual', actor: 'reviewer:alice' },
        activatedRevisionId: expect.any(String),
      });
      expect(activated.activatedRevisionId).not.toBe(setup.revision.id);

      const activeRevision = await getBehaviorRevision(activated.activatedRevisionId!);
      expect(activeRevision).toMatchObject({
        personaId: setup.persona.id,
        behaviorId: setup.binding.id,
        revision: 2,
        source: { kind: 'persona_override', parentRevisionId: setup.revision.id },
      });
      expect(JSON.stringify(activeRevision!.flowSnapshot)).toContain(REUSABLE_LESSON);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(activated.activatedRevisionId);
    });
  });

  it('never activates a drafted improvement without an explicit approval', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('propose_overrides');
      const now = Date.now();
      const [, second] = await persistRepeatedLesson(
        setup.persona.id,
        setup.revision.id,
        now,
        'activity_no_auto_apply',
      );

      const admitted = await admitBehaviorMaintenanceRun(second, now + 1);
      if (!admitted) throw new Error('Expected maintenance admission.');
      const diagnosed = await executeBehaviorMaintenanceRun(admitted.id, { now: now + 2 });
      const proposalId = diagnosed!.relatedProposalIds[0];

      expect((await getBehaviorProposal(proposalId))?.status).toBe('awaiting_approval');
      await expect(activateBehaviorProposal(proposalId))
        .rejects.toBeInstanceOf(BehaviorLearningPolicyError);
      expect((await getBehaviorProposal(proposalId))?.activatedRevisionId).toBeUndefined();
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.revision.id);
    });
  });

  it('keeps learn_hints autonomy authoritative over the enabled rollout gates', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('learn_hints');
      const now = Date.now();
      const [, second] = await persistRepeatedLesson(
        setup.persona.id,
        setup.revision.id,
        now,
        'activity_learn_hints',
      );

      const admitted = await admitBehaviorMaintenanceRun(second, now + 1);
      if (!admitted) throw new Error('Expected maintenance admission.');
      const diagnosed = await executeBehaviorMaintenanceRun(admitted.id, { now: now + 2 });
      expect(diagnosed).toMatchObject({
        state: 'completed',
        action: 'needs_human_diagnosis',
        reasonCode: 'instruction_candidate_draft_failed',
        relatedProposalIds: [],
      });
      expect(await listBehaviorProposals(setup.persona.id)).toEqual([]);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.revision.id);

      await expect(suggestBehaviorInstructionImprovement({
        personaId: setup.persona.id,
        slotKey: 'primary',
        rationale: 'Repeated failures show a reusable lesson.',
        instruction: REUSABLE_LESSON,
        evidenceRefs: [{ kind: 'activity', id: second.id }],
      })).rejects.toBeInstanceOf(BehaviorLearningPolicyError);
    });
  });

  it('keeps a locked Persona out of admission, hints, and proposals', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('locked');
      const now = Date.now();
      const [, second] = await persistRepeatedLesson(
        setup.persona.id,
        setup.revision.id,
        now,
        'activity_locked',
      );

      await expect(admitBehaviorMaintenanceRun(second, now + 1)).resolves.toBeNull();
      expect(await listBehaviorMaintenanceRuns(setup.persona.id)).toEqual([]);

      await expect(createProceduralHint({
        personaId: setup.persona.id,
        content: REUSABLE_LESSON,
        confidence: 0.9,
        importance: 0.7,
        sourceRefs: [{ kind: 'activity', id: second.id }],
        trust: 'model_inference',
      })).rejects.toBeInstanceOf(BehaviorLearningPolicyError);

      await expect(suggestBehaviorInstructionImprovement({
        personaId: setup.persona.id,
        slotKey: 'primary',
        rationale: 'Repeated failures show a reusable lesson.',
        instruction: REUSABLE_LESSON,
        evidenceRefs: [{ kind: 'activity', id: second.id }],
      })).rejects.toBeInstanceOf(BehaviorLearningPolicyError);

      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.revision.id);
    });
  });
});
