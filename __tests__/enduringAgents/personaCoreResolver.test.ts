import {
  activateBehaviorProposal,
  approveBehaviorProposal,
  createBehaviorProposal,
  rollbackBehaviorProposal,
  updatePersonaComposition,
  type BehaviorProposalCompileResult,
} from '@/backend/services/enduringAgents';
import {
  behaviorRevisionId,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import {
  authoredCoreFlowRef,
} from '@/backend/services/enduringAgents/personaComposition';
import {
  PersonaCoreResolutionError,
  resolvePersonaCoreRevision,
} from '@/backend/services/enduringAgents/personaCoreResolver';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  activateBehaviorBindingRevision,
  createBehaviorRevision,
  getBehaviorBinding,
  getBehaviorRevision,
  getPersona,
  listBehaviorRevisions,
} from '@/backend/services/enduringAgents/store';
import { flowService } from '@/backend/services/flow';
import {
  BEHAVIOR_REVISION_SCHEMA_VERSION,
  BehaviorRevisionSchema,
  PersonaSchema,
  type BehaviorRevision,
  type Persona,
} from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';
import { saveCollectionItem } from '@/utils/storage/backend';
import { runWithWorkspace } from '@/utils/workspace';

import { createPersonaFromRole } from './fixtures/personaFactory';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    'enduring-persona-core-resolver-' + process.pid + '-' + workspaceSequence,
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

async function setupPersona() {
  const bundle = await createPersonaFromRole({
    name: 'Core Resolver Jim',
    autonomyLevel: 'propose_overrides',
    idempotencyKey: 'core-resolver-jim',
  });
  const binding = bundle.behaviorBindings.find((candidate) => candidate.slotKey === 'primary');
  if (!binding) throw new Error('Expected the primary Behavior binding.');
  const baseRevision = await getBehaviorRevision(binding.activeRevisionId);
  if (!baseRevision) throw new Error('Expected the primary Behavior revision.');
  return { bundle, binding, baseRevision };
}

function improvedCompiler(
  baseFlow: Flow,
): () => Promise<BehaviorProposalCompileResult> {
  return async () => {
    const flow = clone(baseFlow);
    const node = processNode(flow);
    node.data.properties = {
      ...node.data.properties,
      promptTemplate: 'Keep the accepted Core improvement active until authored content changes.',
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

async function approvedImprovement(
  setup: Awaited<ReturnType<typeof setupPersona>>,
) {
  const proposal = await createBehaviorProposal({
    personaId: setup.bundle.persona.id,
    behaviorId: setup.binding.id,
    baseBehaviorRevisionId: setup.baseRevision.id,
    rationale: 'Preserve an accepted improvement over the authored Core baseline.',
    evidenceRefs: [{
      kind: 'activity',
      id: 'activity_core_resolution_regression',
      observedAt: 1_786_400_000_000,
    }],
    candidateSpec: { lesson: 'preserve accepted Core improvement' },
    evals: [{
      id: 'accepted-core-prompt',
      run: ({ candidateFlow }) => ({
        passed: processNode(candidateFlow).data.properties?.promptTemplate
          === 'Keep the accepted Core improvement active until authored content changes.',
      }),
    }],
    actor: 'maintenance-activity',
  }, {
    compiler: improvedCompiler(setup.baseRevision.flowSnapshot),
  });
  return approveBehaviorProposal(proposal.id, {
    actor: 'reviewer:alice',
    reason: 'The focused Core-resolution change is safe.',
  });
}

async function activateImprovement(
  setup: Awaited<ReturnType<typeof setupPersona>>,
) {
  const proposal = await approvedImprovement(setup);
  const activated = await activateBehaviorProposal(proposal.id);
  const revision = await getBehaviorRevision(activated.activatedRevisionId!);
  if (!revision) throw new Error('Expected the activated improvement revision.');
  return { proposal, activated, revision };
}

async function requireAuthoredFlow(persona: Pick<Persona, 'composition'>) {
  const flowRef = authoredCoreFlowRef(persona);
  if (!flowRef) throw new Error('Expected an authored Core Flow reference.');
  const flow = await flowService.getFlow(flowRef);
  if (!flow) throw new Error('Expected the authored Core Flow.');
  return { flowRef, flow };
}

async function saveSharedClone(flow: Flow, id: string): Promise<Flow> {
  const shared = {
    ...clone(flow),
    id,
    name: id,
    personaOwnership: undefined,
    updatedAt: Math.max(Date.now(), (flow.updatedAt ?? 0) + 1),
  };
  const saved = await flowService.saveFlow(shared);
  if (!saved.success) throw new Error(saved.error || 'Could not save shared test Flow.');
  return shared;
}

async function useLegacyCoreFlowRef(personaId: string, flowRef: string): Promise<void> {
  const persona = await getPersona(personaId);
  if (!persona) throw new Error('Expected Persona.');
  const next = PersonaSchema.parse({
    ...persona,
    composition: {
      ...persona.composition,
      coreBinding: undefined,
      coreFlowRef: flowRef,
    },
    updatedAt: Math.max(Date.now(), persona.updatedAt + 1),
  });
  await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, next);
}

async function installOverride(
  setup: Awaited<ReturnType<typeof setupPersona>>,
  flowSnapshot: Flow,
  source: BehaviorRevision['source'],
): Promise<BehaviorRevision> {
  const revisions = (await listBehaviorRevisions(setup.bundle.persona.id))
    .filter((revision) => revision.behaviorId === setup.binding.id);
  const revision = Math.max(...revisions.map((candidate) => candidate.revision)) + 1;
  const snapshot = snapshotBehaviorFlow(flowSnapshot);
  const contentHash = hashBehaviorFlow(snapshot);
  const candidate = BehaviorRevisionSchema.parse({
    schemaVersion: BEHAVIOR_REVISION_SCHEMA_VERSION,
    id: behaviorRevisionId({
      personaId: setup.bundle.persona.id,
      behaviorId: setup.binding.id,
      revision,
      contentHash,
    }),
    behaviorId: setup.binding.id,
    personaId: setup.bundle.persona.id,
    slotKey: 'primary',
    revision,
    contentHash,
    flowSnapshot: snapshot,
    source,
    createdAt: Date.now(),
  });
  await createBehaviorRevision(candidate);
  const binding = await getBehaviorBinding(setup.binding.id);
  if (!binding) throw new Error('Expected Behavior binding.');
  await activateBehaviorBindingRevision({
    personaId: setup.bundle.persona.id,
    behaviorId: setup.binding.id,
    revisionId: candidate.id,
    expectedActiveRevisionId: binding.activeRevisionId,
  });
  return candidate;
}

describe('Persona Core provenance resolution', () => {
  it.each(['persona_copy', 'shared', 'legacy'] as const)(
    'preserves an accepted improvement for unchanged %s authored Core content',
    async (mode) => {
      await inFreshWorkspace(async () => {
        const setup = await setupPersona();
        const original = await requireAuthoredFlow(setup.bundle.persona);
        let expectedFlowRef = original.flowRef;

        if (mode === 'shared') {
          const shared = await saveSharedClone(original.flow, 'shared_core_baseline');
          const persona = await getPersona(setup.bundle.persona.id);
          await updatePersonaComposition(setup.bundle.persona.id, {
            expectedUpdatedAt: persona!.updatedAt,
            coreFlowRef: shared.id,
          });
          expectedFlowRef = shared.id;
        } else if (mode === 'legacy') {
          await useLegacyCoreFlowRef(setup.bundle.persona.id, original.flowRef);
        }

        const activated = await activateImprovement(setup);
        expect(activated.revision.source).toMatchObject({
          kind: 'persona_override',
          authoredFlowProvenance: {
            flowRef: expectedFlowRef,
            contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        });
        const revisionCount = (await listBehaviorRevisions(setup.bundle.persona.id)).length;

        const [resolvedA, resolvedB] = await Promise.all([
          resolvePersonaCoreRevision(setup.bundle.persona.id),
          resolvePersonaCoreRevision(setup.bundle.persona.id),
        ]);
        expect(resolvedA.id).toBe(activated.revision.id);
        expect(resolvedB.id).toBe(activated.revision.id);
        expect(await listBehaviorRevisions(setup.bundle.persona.id)).toHaveLength(revisionCount);
      });
    },
  );

  it('creates one authored-derived child after content changes and then converges', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const activated = await activateImprovement(setup);
      const authored = await requireAuthoredFlow(setup.bundle.persona);
      const changed = clone(authored.flow);
      processNode(changed).data.properties = {
        ...processNode(changed).data.properties,
        promptTemplate: 'This is an intentional authored Core edit.',
      };
      changed.updatedAt = Math.max(Date.now(), (changed.updatedAt ?? 0) + 1);
      await expect(flowService.saveFlow(changed)).resolves.toMatchObject({ success: true });

      const resolved = await resolvePersonaCoreRevision(setup.bundle.persona.id);
      expect(resolved.id).not.toBe(activated.revision.id);
      expect(resolved.source).toMatchObject({
        kind: 'persona_override',
        parentRevisionId: activated.revision.id,
        sourceFlowRef: authored.flowRef,
      });
      const count = (await listBehaviorRevisions(setup.bundle.persona.id)).length;
      expect((await resolvePersonaCoreRevision(setup.bundle.persona.id)).id).toBe(resolved.id);
      expect(await listBehaviorRevisions(setup.bundle.persona.id)).toHaveLength(count);
    });
  });

  it('supersedes an accepted override when the authored Core reference changes', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const activated = await activateImprovement(setup);
      const authored = await requireAuthoredFlow(setup.bundle.persona);
      const replacement = await saveSharedClone(authored.flow, 'shared_core_replacement');
      processNode(replacement).data.properties = {
        ...processNode(replacement).data.properties,
        promptTemplate: 'The replacement reference is intentionally authored.',
      };
      await expect(flowService.saveFlow(replacement)).resolves.toMatchObject({ success: true });
      const persona = await getPersona(setup.bundle.persona.id);
      await updatePersonaComposition(setup.bundle.persona.id, {
        expectedUpdatedAt: persona!.updatedAt,
        coreFlowRef: replacement.id,
      });

      const resolved = await resolvePersonaCoreRevision(setup.bundle.persona.id);
      expect(resolved.id).not.toBe(activated.revision.id);
      expect(resolved.source).toMatchObject({
        kind: 'persona_override',
        parentRevisionId: activated.revision.id,
        sourceFlowRef: replacement.id,
      });
    });
  });

  it('fails explicitly when a configured authored Core Flow is missing', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const authored = await requireAuthoredFlow(setup.bundle.persona);
      await flowService.deleteFlow(authored.flowRef);

      await expect(resolvePersonaCoreRevision(setup.bundle.persona.id))
        .rejects.toThrow(
          new PersonaCoreResolutionError(
            `Persona Core Flow "${authored.flowRef}" no longer exists.`,
          ),
        );

      const proposal = await approvedImprovement(setup);
      await expect(activateBehaviorProposal(proposal.id))
        .rejects.toBeInstanceOf(PersonaCoreResolutionError);
    });
  });

  it.each<[string, { evidenceRefs?: string[] }]>([
    ['recognizable accepted', { evidenceRefs: ['proposal_legacy_accepted'] }],
    ['ambiguous', {}],
  ])('preserves a %s legacy override without provenance', async (_label, marker) => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const legacyFlow = clone(setup.baseRevision.flowSnapshot);
      processNode(legacyFlow).data.properties = {
        ...processNode(legacyFlow).data.properties,
        promptTemplate: 'Legacy accepted content must not be overwritten.',
      };
      const legacy = await installOverride(setup, legacyFlow, {
        kind: 'persona_override',
        parentRevisionId: setup.baseRevision.id,
        ...marker,
      });
      const count = (await listBehaviorRevisions(setup.bundle.persona.id)).length;

      expect((await resolvePersonaCoreRevision(setup.bundle.persona.id)).id).toBe(legacy.id);
      expect(await listBehaviorRevisions(setup.bundle.persona.id)).toHaveLength(count);
    });
  });

  it('rematerializes a clearly authored-derived legacy revision after an authored edit', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const authored = await requireAuthoredFlow(setup.bundle.persona);
      const legacy = await installOverride(setup, authored.flow, {
        kind: 'persona_override',
        parentRevisionId: setup.baseRevision.id,
        sourceFlowRef: authored.flowRef,
      });
      const changed = clone(authored.flow);
      changed.name = changed.name + ' authored edit';
      changed.updatedAt = Math.max(Date.now(), (changed.updatedAt ?? 0) + 1);
      await expect(flowService.saveFlow(changed)).resolves.toMatchObject({ success: true });

      const resolved = await resolvePersonaCoreRevision(setup.bundle.persona.id);
      expect(resolved.id).not.toBe(legacy.id);
      expect(resolved.source).toMatchObject({
        kind: 'persona_override',
        parentRevisionId: legacy.id,
        sourceFlowRef: authored.flowRef,
      });
    });
  });

  it('does not let unchanged authored content immediately undo a rollback', async () => {
    await inFreshWorkspace(async () => {
      const setup = await setupPersona();
      const activated = await activateImprovement(setup);
      const rolledBack = await rollbackBehaviorProposal(activated.proposal.id, {
        actor: 'reviewer:alice',
        reason: 'Restore the prior immutable Core revision.',
      });

      const resolved = await resolvePersonaCoreRevision(setup.bundle.persona.id);
      expect(resolved.id).toBe(rolledBack.rollbackRevisionId);
      expect((await getBehaviorBinding(setup.binding.id))?.activeRevisionId)
        .toBe(rolledBack.rollbackRevisionId);

      const authored = await requireAuthoredFlow(setup.bundle.persona);
      const changed = clone(authored.flow);
      changed.name = changed.name + ' after rollback';
      changed.updatedAt = Math.max(Date.now(), (changed.updatedAt ?? 0) + 1);
      await expect(flowService.saveFlow(changed)).resolves.toMatchObject({ success: true });

      const afterAuthoredChange = await resolvePersonaCoreRevision(setup.bundle.persona.id);
      expect(afterAuthoredChange.id).not.toBe(rolledBack.rollbackRevisionId);
      expect(afterAuthoredChange.source).toMatchObject({
        kind: 'persona_override',
        parentRevisionId: rolledBack.rollbackRevisionId,
        sourceFlowRef: authored.flowRef,
      });
    });
  });
});
