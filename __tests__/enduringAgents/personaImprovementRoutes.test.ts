const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: (handler: unknown) => handler,
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({
    verbose: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(),
  }),
}));

import { NextRequest, NextResponse } from 'next/server';

import { GET as listImprovements } from '@/app/v1/personas/[personaId]/improvements/route';
import { POST as applyImprovement } from '@/app/v1/personas/[personaId]/improvements/[proposalId]/apply/route';
import { POST as rejectImprovement } from '@/app/v1/personas/[personaId]/improvements/[proposalId]/reject/route';
import { POST as promoteImprovement } from '@/app/v1/personas/[personaId]/improvements/[proposalId]/promote/route';
import { POST as undoImprovement } from '@/app/v1/personas/[personaId]/improvements/[proposalId]/undo/route';
import {
  createBehaviorProposal,
  getBehaviorProposal,
  listBehaviorProposals,
  type BehaviorProposalCompileResult,
  type CreateBehaviorProposalInput,
} from '@/backend/services/enduringAgents';
import { createPersonaFromRole } from './fixtures/personaFactory';
import { FEATURES } from '@/config/features';
import {
  getBehaviorBinding,
  getBehaviorRevision,
  type PersonaBundle,
} from '@/backend/services/enduringAgents/store';
import type {
  BehaviorBinding,
  BehaviorRevision,
} from '@/shared/types/enduringAgent';
import type { Flow } from '@/shared/types/flow';
import { runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    `persona-improvement-routes-${process.pid}-${workspaceSequence}`,
    task,
  );
}

function request(
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): NextRequest {
  return new NextRequest(`http://localhost:4200${path}`, {
    method,
    headers: {
      host: 'localhost:4200',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function personaContext(personaId: string) {
  return { params: Promise.resolve({ personaId }) } as never;
}

function proposalContext(personaId: string, proposalId: string) {
  return { params: Promise.resolve({ personaId, proposalId }) } as never;
}

interface ImprovementSetup {
  bundle: PersonaBundle;
  binding: BehaviorBinding;
  baseRevision: BehaviorRevision;
}

async function setupPersona(label: string): Promise<ImprovementSetup> {
  const bundle = await createPersonaFromRole({
    name: label,
    autonomyLevel: 'propose_overrides',
    idempotencyKey: `improvement-route-${label}`,
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected a primary Behavior binding.');
  const baseRevision = await getBehaviorRevision(binding.activeRevisionId);
  if (!baseRevision) throw new Error('Expected an active primary Behavior revision.');
  return { bundle, binding, baseRevision };
}

function passingCompiler(baseFlow: Flow): () => Promise<BehaviorProposalCompileResult> {
  return async () => {
    const flow = structuredClone(baseFlow);
    const process = flow.nodes.find((node) => node.type === 'process');
    if (!process) throw new Error('Expected a Process node.');
    process.data.properties = {
      ...process.data.properties,
      promptTemplate: 'Complete the work, verify the focused result, and report clearly.',
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

function proposalInput(setup: ImprovementSetup): CreateBehaviorProposalInput {
  return {
    personaId: setup.bundle.persona.id,
    behaviorId: setup.binding.id,
    baseBehaviorRevisionId: setup.baseRevision.id,
    rationale: 'Repeated work needed a clearer verification step.',
    evidenceRefs: [{
      kind: 'activity',
      id: 'activity_improvement_route_evidence',
      observedAt: 1_786_400_000_000,
    }],
    candidateSpec: { lesson: 'verify the focused result' },
    evals: [{
      id: 'includes-focused-verification',
      run: ({ candidateFlow }) => ({
        passed: candidateFlow.nodes.some((node) => (
          node.type === 'process'
          && node.data.properties?.promptTemplate
            === 'Complete the work, verify the focused result, and report clearly.'
        )),
      }),
    }],
    actor: 'maintenance-activity',
  };
}

async function createProposal(setup: ImprovementSetup) {
  return createBehaviorProposal(
    proposalInput(setup),
    { compiler: passingCompiler(setup.baseRevision.flowSnapshot) },
  );
}

describe('Persona Improvements routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assertLocalRequestMock.mockReturnValue(null);
    assertUnlockedMock.mockResolvedValue(null);
  });

  it('lists only improvements owned by the requested Persona', async () => {
    await inFreshWorkspace(async () => {
      const jim = await setupPersona('Jim scoped improvements');
      const sara = await setupPersona('Sara scoped improvements');
      const jimProposal = await createProposal(jim);
      await createProposal(sara);

      const response = await listImprovements(
        request(`/v1/personas/${jim.bundle.persona.id}/improvements`),
        personaContext(jim.bundle.persona.id),
      );

      expect(response.status).toBe(200);
      expect((await response.json()).map((proposal: { id: string }) => proposal.id))
        .toEqual([jimProposal.id]);
    });
  });

  it('attaches the recorded outcome metric to each improvement it has one for', async () => {
    const original = FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS;
    FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = true;
    try {
      await inFreshWorkspace(async () => {
        const setup = await setupPersona('Jim measured improvement');
        const measured = await createProposal(setup);
        await applyImprovement(
          request(
            `/v1/personas/${setup.bundle.persona.id}/improvements/${measured.id}/apply`,
            'POST',
          ),
          proposalContext(setup.bundle.persona.id, measured.id),
        );

        const response = await listImprovements(
          request(`/v1/personas/${setup.bundle.persona.id}/improvements`),
          personaContext(setup.bundle.persona.id),
        );

        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload).toHaveLength(1);
        expect(payload[0]).toMatchObject({
          id: measured.id,
          status: 'activated',
          outcome: {
            proposalId: measured.id,
            verdict: 'pending',
            baseBehaviorRevisionId: setup.baseRevision.id,
          },
        });
      });
    } finally {
      FEATURES.ENABLE_PERSONA_BEHAVIOR_OUTCOME_METRICS = original;
    }
  });

  it('omits the outcome field for improvements that were never measured', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Jim unmeasured improvement');
      const proposal = await createProposal(setup);

      const response = await listImprovements(
        request(`/v1/personas/${setup.bundle.persona.id}/improvements`),
        personaContext(setup.bundle.persona.id),
      );

      const payload = await response.json();
      expect(payload).toHaveLength(1);
      expect(payload[0].id).toBe(proposal.id);
      expect(payload[0].outcome).toBeUndefined();
    });
  });

  it('applies an awaiting improvement through approval and activation', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Jim applies improvement');
      const proposal = await createProposal(setup);

      const response = await applyImprovement(
        request(
          `/v1/personas/${setup.bundle.persona.id}/improvements/${proposal.id}/apply`,
          'POST',
        ),
        proposalContext(setup.bundle.persona.id, proposal.id),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: proposal.id,
        status: 'activated',
        approval: { kind: 'manual', actor: 'persona-owner' },
        activatedRevisionId: expect.any(String),
      });
      const durable = await getBehaviorProposal(proposal.id);
      expect(durable?.auditTrail.map((event) => event.action))
        .toEqual(['proposed', 'approved', 'activated']);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(durable?.activatedRevisionId);
    });
  });

  it('durably rejects an improvement and keeps retries idempotent', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Jim rejects improvement');
      const proposal = await createProposal(setup);
      const path = `/v1/personas/${setup.bundle.persona.id}/improvements/${proposal.id}/reject`;
      const context = proposalContext(setup.bundle.persona.id, proposal.id);

      const first = await rejectImprovement(request(path, 'POST'), context);
      const retry = await rejectImprovement(request(path, 'POST'), context);

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ id: proposal.id, status: 'rejected' });
      const durable = await getBehaviorProposal(proposal.id);
      expect(durable?.status).toBe('rejected');
      expect(durable?.auditTrail.filter((event) => event.action === 'rejected'))
        .toHaveLength(1);
      expect((await listBehaviorProposals(setup.bundle.persona.id))[0]).toEqual(durable);
    });
  });

  it('undoes an applied improvement and restores the exact prior revision', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Jim undoes improvement');
      const proposal = await createProposal(setup);
      const context = proposalContext(setup.bundle.persona.id, proposal.id);
      await applyImprovement(request(
        `/v1/personas/${setup.bundle.persona.id}/improvements/${proposal.id}/apply`,
        'POST',
      ), context);

      const response = await undoImprovement(request(
        `/v1/personas/${setup.bundle.persona.id}/improvements/${proposal.id}/undo`,
        'POST',
      ), context);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: proposal.id,
        status: 'rolled_back',
        rollbackRevisionId: setup.baseRevision.id,
      });
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(setup.baseRevision.id);
      expect((await getBehaviorProposal(proposal.id))?.auditTrail.at(-1)?.action)
        .toBe('rolled_back');
    });
  });

  it('saves an activated improvement as an audited Role version only after confirmation', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Jim shares improvement');
      const proposal = await createProposal(setup);
      const context = proposalContext(setup.bundle.persona.id, proposal.id);
      const base = `/v1/personas/${setup.bundle.persona.id}/improvements/${proposal.id}`;
      await applyImprovement(request(`${base}/apply`, 'POST'), context);

      const missingConfirmation = await promoteImprovement(request(
        `${base}/promote`,
        'POST',
        {
          confirmation: 'SHARE',
          migrationNotes: 'Reuse the focused verification lesson across this Role.',
        },
      ), context);
      expect(missingConfirmation.status).toBe(400);
      expect((await getBehaviorProposal(proposal.id))?.promotedRoleVersionId).toBeUndefined();

      const response = await promoteImprovement(request(
        `${base}/promote`,
        'POST',
        {
          confirmation: 'PROMOTE',
          migrationNotes: 'Reuse the focused verification lesson across this Role.',
        },
      ), context);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        proposal: {
          id: proposal.id,
          promotedRoleVersionId: expect.any(String),
          auditTrail: expect.arrayContaining([
            expect.objectContaining({ action: 'promoted_to_role', actor: 'persona-owner' }),
          ]),
        },
        roleVersion: {
          id: expect.any(String),
          migrationNotes: 'Reuse the focused verification lesson across this Role.',
        },
      });
    });
  });

  it('returns 404 for every mutation when a proposal belongs to another Persona', async () => {
    await inFreshWorkspace(async () => {
      const owner = await setupPersona('Proposal owner');
      const stranger = await setupPersona('Different Persona');
      const proposal = await createProposal(owner);
      const context = proposalContext(stranger.bundle.persona.id, proposal.id);
      const base = `/v1/personas/${stranger.bundle.persona.id}/improvements/${proposal.id}`;

      const responses = await Promise.all([
        applyImprovement(request(`${base}/apply`, 'POST'), context),
        rejectImprovement(request(`${base}/reject`, 'POST'), context),
        undoImprovement(request(`${base}/undo`, 'POST'), context),
        promoteImprovement(request(`${base}/promote`, 'POST', {
          confirmation: 'PROMOTE',
          migrationNotes: 'Should never cross Persona ownership.',
        }), context),
      ]);

      expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
      expect((await getBehaviorProposal(proposal.id))?.status).toBe('awaiting_approval');
      expect((await getBehaviorBinding(owner.binding.id))?.activeRevisionId)
        .toBe(owner.baseRevision.id);
    });
  });

  it('runs local and unlock guards before listing or mutating improvements', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona('Guarded improvements');
      const proposal = await createProposal(setup);
      const personaId = setup.bundle.persona.id;
      const context = proposalContext(personaId, proposal.id);
      const listContext = personaContext(personaId);
      const base = `/v1/personas/${personaId}/improvements/${proposal.id}`;

      assertLocalRequestMock.mockReturnValue(new Response('forbidden', { status: 403 }));
      const remote = await Promise.all([
        listImprovements(request(`/v1/personas/${personaId}/improvements`), listContext),
        applyImprovement(request(`${base}/apply`, 'POST'), context),
        rejectImprovement(request(`${base}/reject`, 'POST'), context),
        undoImprovement(request(`${base}/undo`, 'POST'), context),
        promoteImprovement(request(`${base}/promote`, 'POST'), context),
      ]);
      expect(remote.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
      expect(assertUnlockedMock).not.toHaveBeenCalled();
      expect((await getBehaviorProposal(proposal.id))?.status).toBe('awaiting_approval');

      assertLocalRequestMock.mockReturnValue(null);
      assertUnlockedMock.mockResolvedValue(
        NextResponse.json({ error: 'encryption_locked' }, { status: 423 }),
      );
      const locked = await Promise.all([
        listImprovements(request(`/v1/personas/${personaId}/improvements`), listContext),
        applyImprovement(request(`${base}/apply`, 'POST'), context),
        rejectImprovement(request(`${base}/reject`, 'POST'), context),
        undoImprovement(request(`${base}/undo`, 'POST'), context),
        promoteImprovement(request(`${base}/promote`, 'POST'), context),
      ]);
      expect(locked.map((response) => response.status)).toEqual([423, 423, 423, 423, 423]);
      expect(assertUnlockedMock).toHaveBeenCalledTimes(5);
      expect((await getBehaviorProposal(proposal.id))?.status).toBe('awaiting_approval');
    });
  });
});
