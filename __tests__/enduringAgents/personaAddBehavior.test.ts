import {
  addPersonaCompositionBehavior,
  readPersonaComposition,
  updatePersonaComposition,
} from '@/backend/services/enduringAgents/personaComposition';
import { resolveEffectiveBehaviorById } from '@/backend/services/enduringAgents/behaviorFlowResolver';
import { claimNextPersonaActivity, enqueuePersonaMailboxItem } from '@/backend/services/enduringAgents/activityRuntime';
import { getBehaviorRevision, getPersona, listBehaviorBindings } from '@/backend/services/enduringAgents/store';
import * as personaStore from '@/backend/services/enduringAgents/store';
import { flowService } from '@/backend/services/flow';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from './fixtures/personaFactory';

jest.mock('@/backend/services/enduringAgents/store', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/store');
  return { ...actual, createBehaviorBindingIfAbsent: jest.fn(actual.createBehaviorBindingIfAbsent) };
});

let sequence = 0;
function isolated(task: () => Promise<void>) {
  return runWithWorkspace(`persona-add-behavior-${process.pid}-${++sequence}`, task);
}

async function setup() {
  const bundle = await createPersonaFromRole({ name: 'Specialist owner', idempotencyKey: 'add-behavior' });
  const source = { ...structuredClone(bundle.behaviorRevisions[0].flowSnapshot), id: 'shared-specialist', name: 'Audit specialist' };
  expect((await flowService.saveFlow(source)).success).toBe(true);
  const composition = (await readPersonaComposition(bundle.persona.id))!;
  return { personaId: bundle.persona.id, source, composition };
}

describe('adding a specialist Behavior after Persona creation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('creates a durable callable slot, resolves its selected Flow, and preserves old revisions after editing', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    const added = await addPersonaCompositionBehavior(personaId, {
      expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef: source.id, mode: 'shared',
    });
    const behavior = added.behaviors.at(-1)!;
    expect(behavior).toMatchObject({ name: source.name, binding: { mode: 'shared', sharedFlowRef: source.id } });
    expect(behavior.slotKey).toMatch(/^picked_/);
    const first = await resolveEffectiveBehaviorById(personaId, behavior.ref);
    const original = structuredClone(first.revision);
    const edited = structuredClone(source);
    edited.nodes.find((node) => node.data.type === 'process')!.data.properties!.promptTemplate = 'Changed specialist instructions';
    expect((await flowService.saveFlow(edited)).success).toBe(true);
    const second = await resolveEffectiveBehaviorById(personaId, behavior.ref);
    expect(second.revision.id).not.toBe(first.revision.id);
    expect(await getBehaviorRevision(first.revision.id)).toEqual(original);
    expect(added.behaviors.slice(0, -1)).toEqual(composition.behaviors);
  }));

  it('creates an independent owned copy and leaves its source unchanged', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    const before = await flowService.getFlow(source.id);
    const added = await addPersonaCompositionBehavior(personaId, {
      expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef: source.id, mode: 'persona_copy',
    });
    const card = added.behaviorCards.at(-1)!;
    expect(card.binding.mode).toBe('persona_copy');
    expect(card.effectiveFlowRef).not.toBe(source.id);
    expect(card.flow?.personaOwnership?.personaId).toBe(personaId);
    expect(await flowService.getFlow(source.id)).toEqual(before);
    expect((await resolveEffectiveBehaviorById(personaId, card.ref)).revision.flowSnapshot.name).toContain('Audit specialist');
  }));

  it('fences duplicate clicks and concurrent stale edits without extra bindings', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    const input = { expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef: source.id, mode: 'shared' };
    const results = await Promise.allSettled([
      addPersonaCompositionBehavior(personaId, input), addPersonaCompositionBehavior(personaId, input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const current = (await getPersona(personaId))!;
    await expect(addPersonaCompositionBehavior(personaId, { ...input, expectedUpdatedAt: current.updatedAt }))
      .rejects.toThrow('already has a Behavior');
    expect(await listBehaviorBindings(personaId)).toHaveLength(composition.behaviors.length + 1);
  }));

  it('recovers a detached durable binding after a failed copy without publishing partial composition', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    jest.spyOn(flowService, 'cloneFlowForPersona').mockResolvedValueOnce({ success: false, error: 'copy interrupted' });
    const input = { expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef: source.id, mode: 'persona_copy' };
    await expect(addPersonaCompositionBehavior(personaId, input)).rejects.toThrow('copy interrupted');
    expect((await getPersona(personaId))?.updatedAt).toBe(composition.expectedUpdatedAt);
    expect((await readPersonaComposition(personaId))?.behaviors).toEqual(composition.behaviors);
    const before = await listBehaviorBindings(personaId);
    const added = await addPersonaCompositionBehavior(personaId, input);
    expect(added.behaviors).toHaveLength(composition.behaviors.length + 1);
    expect(await listBehaviorBindings(personaId)).toEqual(before);
  }));

  it('can reattach a removed specialist without rolling back its active revision', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    const input = { sourceFlowRef: source.id, mode: 'shared' };
    const added = await addPersonaCompositionBehavior(personaId, { ...input, expectedUpdatedAt: composition.expectedUpdatedAt });
    const behavior = added.behaviors.at(-1)!;
    const resolved = await resolveEffectiveBehaviorById(personaId, behavior.ref);
    const removed = await updatePersonaComposition(personaId, {
      expectedUpdatedAt: (await getPersona(personaId))!.updatedAt,
      behaviors: added.behaviors.filter((item) => item.ref !== behavior.ref),
    });
    const reattached = await addPersonaCompositionBehavior(personaId, { ...input, expectedUpdatedAt: removed.expectedUpdatedAt });
    expect(reattached.behaviors.at(-1)!.ref).toBe(behavior.ref);
    expect((await listBehaviorBindings(personaId)).find((item) => item.id === behavior.ref)?.activeRevisionId).toBe(resolved.revision.id);
  }));

  it('reuses an immutable revision when interrupted before the binding write, even if its source was edited', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    jest.mocked(personaStore.createBehaviorBindingIfAbsent).mockRejectedValueOnce(new Error('binding write interrupted'));
    const input = { expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef: source.id, mode: 'shared' };
    await expect(addPersonaCompositionBehavior(personaId, input)).rejects.toThrow('binding write interrupted');
    const edited = structuredClone(source);
    edited.nodes.find((node) => node.data.type === 'process')!.data.properties!.promptTemplate = 'New instructions after interruption';
    expect((await flowService.saveFlow(edited)).success).toBe(true);
    const added = await addPersonaCompositionBehavior(personaId, input);
    const resolved = await resolveEffectiveBehaviorById(personaId, added.behaviors.at(-1)!.ref);
    expect(resolved.revision.flowSnapshot.nodes.find((node) => node.data.type === 'process')!.data.properties!.promptTemplate)
      .toBe('New instructions after interruption');
  }));

  it('rejects foreign Persona ownership, unavailable workspace Flows and Core recursion before mutation', () => isolated(async () => {
    const { personaId, composition } = await setup();
    const other = await createPersonaFromRole({ name: 'Other owner', idempotencyKey: 'other-owner' });
    for (const [sourceFlowRef, error] of [
      [other.persona.composition!.coreFlowRef!, 'another Persona'],
      ['missing-workspace-flow', 'Flow'],
      [composition.coreFlowRef!, 'distinct from'],
    ]) {
      await expect(addPersonaCompositionBehavior(personaId, {
        expectedUpdatedAt: composition.expectedUpdatedAt, sourceFlowRef, mode: 'persona_copy',
      })).rejects.toThrow(error);
    }
    expect((await getPersona(personaId))!.updatedAt).toBe(composition.expectedUpdatedAt);
    expect(await listBehaviorBindings(personaId)).toHaveLength(composition.behaviors.length);
  }));

  it('refuses changes while an Activity owns the Persona lease', () => isolated(async () => {
    const { personaId, source, composition } = await setup();
    await enqueuePersonaMailboxItem({
      personaId, idempotencyKey: 'busy-activity', kind: 'assignment',
      source: { kind: 'assignment', sourceId: 'audit-source' }, summary: 'Keep the owner busy',
    });
    expect(await claimNextPersonaActivity({ personaId, ttlMs: 30_000 })).not.toBeNull();
    await expect(addPersonaCompositionBehavior(personaId, {
      expectedUpdatedAt: (await getPersona(personaId))!.updatedAt,
      sourceFlowRef: source.id, mode: 'shared',
    })).rejects.toMatchObject({ code: 'PERSONA_DOMAIN_BUSY' });
    expect(await listBehaviorBindings(personaId)).toHaveLength(composition.behaviors.length);
  }));
});
