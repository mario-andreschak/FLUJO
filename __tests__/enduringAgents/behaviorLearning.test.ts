import {
  BehaviorLearningPolicyError,
  BehaviorProposalConflictError,
  activateBehaviorProposal,
  approveBehaviorProposal,
  createBehaviorProposal,
  createPersonaFromRole,
  createProceduralHint,
  deletePersona,
  getBehaviorProposal,
  listBehaviorProposals,
  promoteBehaviorProposalToRoleVersion,
  previewPersonaDeletion,
  rollbackBehaviorProposal,
  type BehaviorProposalCompileResult,
  type CreateBehaviorProposalInput,
} from '@/backend/services/enduringAgents';
import {
  getBehaviorBinding,
  getBehaviorRevision,
  getPersona,
  getRoleVersion,
  listBehaviorRevisions,
  listMemoryItems,
  listRoleVersions,
} from '@/backend/services/enduringAgents/store';
import {
  BehaviorProposalSchema,
  type BehaviorProposal,
  type PersonaAutonomyLevel,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    'enduring-behavior-learning-' + process.pid + '-' + workspaceSequence,
    task,
  );
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
    idempotencyKey: 'jim-' + autonomyLevel,
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected the primary Behavior.');
  const baseRevision = await getBehaviorRevision(binding.activeRevisionId);
  if (!baseRevision) throw new Error('Expected the active Behavior revision.');
  return { bundle, binding, baseRevision };
}

function passingCompiler(baseFlow: Flow): () => Promise<BehaviorProposalCompileResult> {
  return async () => {
    const flow = clone(baseFlow);
    const node = processNode(flow);
    node.data.properties = {
      ...node.data.properties,
      promptTemplate: 'Inspect evidence, implement carefully, and verify the focused change.',
    };
    return {
      success: true,
      flow,
      errorCount: 0,
      warningCount: 0,
      issues: [],
    };
  };
}

function proposalInput(
  setup: Awaited<ReturnType<typeof setupPersona>>,
  overrides: Partial<CreateBehaviorProposalInput> = {},
): CreateBehaviorProposalInput {
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
      run: ({ candidateFlow, candidateContentHash }) => ({
        passed: processNode(candidateFlow).data.properties?.promptTemplate
          === 'Inspect evidence, implement carefully, and verify the focused change.',
        details: 'Evaluated immutable candidate ' + candidateContentHash,
      }),
    }],
    actor: 'maintenance-activity',
    ...overrides,
  };
}

async function approvedProposal(
  setup: Awaited<ReturnType<typeof setupPersona>>,
): Promise<BehaviorProposal> {
  const proposal = await createBehaviorProposal(
    proposalInput(setup),
    { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
  );
  return approveBehaviorProposal(proposal.id, {
    actor: 'reviewer:alice',
    reason: 'The evidence, Flow diff, validation, and deterministic eval are acceptable.',
  });
}

describe('behavioral learning policy and evidence', () => {
  it('records evidence-backed procedural hints as candidates and blocks locked Personas', async () => {
    await inFreshWorkspace(async () => {
      const locked = await setupPersona('locked');
      const evidence = [{
        kind: 'activity' as const,
        id: 'activity_lesson',
        observedAt: 1_786_400_000_000,
      }];
      await expect(createProceduralHint({
        personaId: locked.bundle.persona.id,
        content: 'Run the focused test before the broader suite.',
        confidence: 0.9,
        importance: 0.7,
        sourceRefs: evidence,
        trust: 'model_inference',
      })).rejects.toBeInstanceOf(BehaviorLearningPolicyError);

      const learner = await setupPersona('learn_hints');
      const hint = await createProceduralHint({
        personaId: learner.bundle.persona.id,
        content: 'Run the focused test before the broader suite.',
        confidence: 0.9,
        importance: 0.7,
        sourceRefs: evidence,
        trust: 'model_inference',
      });
      expect(hint).toMatchObject({
        personaId: learner.bundle.persona.id,
        kind: 'procedural_hint',
        status: 'candidate',
        content: 'Run the focused test before the broader suite.',
      });
      expect(hint.sourceRefs[0]).toMatchObject({
        kind: 'activity',
        id: 'activity_lesson',
        workspaceId: expect.any(String),
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(await listMemoryItems(learner.bundle.persona.id)).toEqual([hint]);
    });
  });

  it.each(['locked', 'learn_hints'] as const)(
    'does not let %s autonomy create Behavior proposals',
    async (autonomyLevel) => {
      await inFreshWorkspace(async () => {
        const setup = await setupPersona(autonomyLevel);
        await expect(createBehaviorProposal(
          proposalInput(setup),
          { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
        )).rejects.toBeInstanceOf(BehaviorLearningPolicyError);
      });
    },
  );

  it('persists compile and eval failures but never lets them reach approval', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const compileFailure = await createBehaviorProposal(
        proposalInput(setup),
        {
          compiler: async () => ({
            success: false,
            errorCount: 1,
            warningCount: 0,
            issues: [{
              severity: 'error',
              code: 'compile-failed',
              message: 'Candidate graph is disconnected.',
            }],
          }),
        },
      );
      expect(compileFailure).toMatchObject({
        status: 'validation_failed',
        validation: {
          compileSucceeded: false,
          errorCount: 1,
        },
        evalResults: [],
      });
      expect(compileFailure.auditTrail.map((event) => event.action))
        .toEqual(['validation_failed']);
      await expect(approveBehaviorProposal(compileFailure.id, {
        actor: 'reviewer',
        reason: 'Try to bypass validation.',
      })).rejects.toBeInstanceOf(BehaviorLearningPolicyError);

      const evalFailure = await createBehaviorProposal(
        proposalInput(setup, {
          evals: [{
            id: 'deterministic-regression',
            run: () => ({ passed: false, details: 'Expected regression fixture failed.' }),
          }],
        }),
        { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
      );
      expect(evalFailure.status).toBe('validation_failed');
      expect(evalFailure.evalResults).toEqual([
        expect.objectContaining({
          id: 'deterministic-regression',
          passed: false,
          candidateContentHash: evalFailure.candidateContentHash,
        }),
      ]);
    });
  });
});

describe('Behavior proposal activation and rollback', () => {
  it('requires approval, activates one immutable Persona revision, and rolls back by CAS', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const proposal = await createBehaviorProposal(
        proposalInput(setup),
        { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
      );
      expect(proposal.status).toBe('awaiting_approval');
      expect(proposal.evidenceRefs[0]).toMatchObject({
        workspaceId: expect.any(String),
        contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await expect(activateBehaviorProposal(proposal.id))
        .rejects.toBeInstanceOf(BehaviorLearningPolicyError);

      const approved = await approveBehaviorProposal(proposal.id, {
        actor: 'reviewer:alice',
        reason: 'Reviewed the evidence and deterministic eval.',
      });
      expect(approved.status).toBe('approved');

      const [activatedA, activatedB] = await Promise.all([
        activateBehaviorProposal(proposal.id),
        activateBehaviorProposal(proposal.id),
      ]);
      expect(activatedA.activatedRevisionId).toBe(activatedB.activatedRevisionId);
      const activated = await getBehaviorProposal(proposal.id);
      expect(activated).toMatchObject({
        status: 'activated',
        approval: { kind: 'manual', actor: 'reviewer:alice' },
        activatedRevisionId: expect.any(String),
      });
      expect(activated?.auditTrail.filter((event) => event.action === 'activated'))
        .toHaveLength(1);

      const revision = await getBehaviorRevision(activated!.activatedRevisionId!);
      expect(revision).toMatchObject({
        personaId: setup.bundle.persona.id,
        behaviorId: setup.binding.id,
        revision: 2,
        source: {
          kind: 'persona_override',
          parentRevisionId: setup.baseRevision.id,
          evidenceRefs: expect.arrayContaining([proposal.id, 'activity_verified_failure']),
        },
      });
      expect(processNode(revision!.flowSnapshot).data.properties?.promptTemplate)
        .toContain('verify the focused change');
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(revision!.id);

      const rolledBack = await rollbackBehaviorProposal(proposal.id, {
        actor: 'reviewer:alice',
        reason: 'Observed regression; restore the exact previous immutable revision.',
      });
      expect(rolledBack).toMatchObject({
        status: 'rolled_back',
        activatedRevisionId: revision!.id,
        rollbackRevisionId: setup.baseRevision.id,
      });
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.baseRevision.id);
      expect(await rollbackBehaviorProposal(proposal.id, {
        actor: 'reviewer:alice',
        reason: 'Idempotent retry.',
      })).toEqual(rolledBack);
      expect(await listBehaviorRevisions(setup.bundle.persona.id)).toHaveLength(3);
    });
  });

  it('fails closed when another approved proposal wins the binding CAS', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const first = await approvedProposal(setup);
      const second = await approvedProposal(setup);

      const winner = await activateBehaviorProposal(first.id);
      await expect(activateBehaviorProposal(second.id)).rejects.toThrow(/changed|active/i);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(winner.activatedRevisionId);
      expect((await getBehaviorProposal(second.id))?.status).toBe('approved');
    });
  });
});

describe('automatic approval and deliberate Role promotion', () => {
  it('auto-applies only validated candidates allowed by explicit audit policy', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('auto_apply_validated');
      const policy = jest.fn(async () => ({
        allowed: true,
        actor: 'policy:self-mod-v1',
        reason: 'Configured eval gate passed and audit policy permits activation.',
      }));
      const proposal = await createBehaviorProposal(
        proposalInput(setup),
        {
          compiler: passingCompiler(setup.baseRevision.flowSnapshot),
          autoApplyPolicy: policy,
        },
      );
      expect(policy).toHaveBeenCalledTimes(1);
      expect(proposal).toMatchObject({
        status: 'activated',
        approval: { kind: 'policy', actor: 'policy:self-mod-v1' },
      });
      expect(proposal.auditTrail.map((event) => event.action)).toEqual([
        'proposed',
        'auto_approved',
        'activated',
      ]);
    });
  });

  it('never auto-activates external-untrusted evidence', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('auto_apply_validated');
      const policy = jest.fn(async () => ({
        allowed: true,
        actor: 'policy:self-mod-v1',
        reason: 'Would otherwise allow.',
      }));
      const proposal = await createBehaviorProposal(
        proposalInput(setup, {
          evidenceRefs: [{
            kind: 'tool_result',
            id: 'webpage_observation',
            producer: 'external_untrusted',
          }],
        }),
        {
          compiler: passingCompiler(setup.baseRevision.flowSnapshot),
          autoApplyPolicy: policy,
        },
      );
      expect(policy).not.toHaveBeenCalled();
      expect(proposal.status).toBe('awaiting_approval');
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.baseRevision.id);
    });
  });

  it('promotes deliberately to a new immutable Role version without repinning Personas', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const approved = await approvedProposal(setup);
      const activated = await activateBehaviorProposal(approved.id);
      const originalRoleVersionId = setup.bundle.persona.roleVersionId;
      const originalRoleVersion = await getRoleVersion(originalRoleVersionId);

      const promoted = await promoteBehaviorProposalToRoleVersion(activated.id, {
        confirmation: 'PROMOTE',
        actor: 'role-maintainer:alice',
        name: 'Developer verification v2',
        migrationNotes: 'Deliberately promote the verified focused-test behavior.',
      });
      expect(promoted).toMatchObject({
        roleDefinitionId: originalRoleVersion!.roleDefinitionId,
        version: originalRoleVersion!.version + 1,
        name: 'Developer verification v2',
        migrationNotes: 'Deliberately promote the verified focused-test behavior.',
      });
      expect(processNode(
        promoted.behaviorSlots.find((slot) => slot.key === 'primary')!.flowTemplate,
      ).data.properties?.promptTemplate).toContain('verify the focused change');
      expect((await getPersona(setup.bundle.persona.id))?.roleVersionId)
        .toBe(originalRoleVersionId);
      expect(await getRoleVersion(originalRoleVersionId)).toEqual(originalRoleVersion);
      expect(await listRoleVersions(originalRoleVersion!.roleDefinitionId)).toHaveLength(2);
      expect((await getBehaviorProposal(activated.id))?.promotedRoleVersionId)
        .toBe(promoted.id);

      await expect(promoteBehaviorProposalToRoleVersion(activated.id, {
        confirmation: 'PROMOTE',
        actor: 'role-maintainer:alice',
        name: 'Changed retry',
        migrationNotes: 'Changed retry payload.',
      })).rejects.toBeInstanceOf(BehaviorProposalConflictError);
    });
  });
});

describe('Behavior proposal schema and workspace isolation', () => {
  it('binds evals and terminal state to exact immutable revision hashes', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const proposal = await createBehaviorProposal(
        proposalInput(setup),
        { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
      );
      expect(() => BehaviorProposalSchema.parse({
        ...proposal,
        candidateFlow: undefined,
      })).toThrow();
      expect(() => BehaviorProposalSchema.parse({
        ...proposal,
        evalResults: proposal.evalResults.map((result) => ({
          ...result,
          candidateContentHash: '0'.repeat(64),
        })),
      })).toThrow();
      expect(() => BehaviorProposalSchema.parse({
        ...proposal,
        status: 'activated',
        approval: {
          kind: 'manual',
          actor: 'reviewer',
          reason: 'Reviewed.',
          approvedAt: proposal.updatedAt,
        },
      })).toThrow();
    });
  });

  it('keeps proposal records workspace-scoped', async () => {
    const suffix = process.pid + '-' + ++workspaceSequence;
    const workspaceA = 'behavior-learning-a-' + suffix;
    const workspaceB = 'behavior-learning-b-' + suffix;
    const proposal = await runWithWorkspace(workspaceA, async () => {
      const setup = await setupPersona();
      return createBehaviorProposal(
        proposalInput(setup),
        { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
      );
    });

    expect(await runWithWorkspace(
      workspaceA,
      () => listBehaviorProposals(proposal.personaId),
    )).toEqual([proposal]);
    expect(await runWithWorkspace(
      workspaceB,
      () => listBehaviorProposals(proposal.personaId),
    )).toEqual([]);
  });

  it('includes private proposals in deletion preview and erases them with the Persona', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const proposal = await createBehaviorProposal(
        proposalInput(setup),
        { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
      );
      const preview = await previewPersonaDeletion(setup.bundle.persona.id);
      expect(preview.counts.behaviorProposals).toBe(1);

      await deletePersona(setup.bundle.persona.id, {
        previewToken: preview.previewToken,
        archivePolicy: 'retain_tombstone',
        confirmation: 'DELETE',
      });
      expect(await listBehaviorProposals(proposal.personaId)).toEqual([]);
    });
  });
});
