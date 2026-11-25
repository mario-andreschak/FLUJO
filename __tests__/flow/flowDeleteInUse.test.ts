/**
 * Deleting a flow that Personas, automations or other flows still use (#1389).
 * Each place gets the person's answer first (another flow, or giving the flow
 * up), and the flow is deleted last, so nothing points at a missing flow, even
 * when the work stops part-way.
 */
import type { Flow } from '@/shared/types/flow';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

const executions: PlannedExecution[] = [];
jest.mock('@/backend/services/scheduler', () => {
  const actual = jest.requireActual('@/backend/services/scheduler');
  const scheduler = {
    listConfigs: async () => executions.map((execution) => structuredClone(execution)),
    get: async (id: string) => executions.find((execution) => execution.id === id) ?? null,
    update: async (id: string, patch: Partial<PlannedExecution>) => {
      const index = executions.findIndex((execution) => execution.id === id);
      if (index < 0) return { error: `No planned execution with id "${id}"` };
      executions[index] = { ...executions[index], ...patch };
      return { execution: executions[index] };
    },
  };
  return { ...actual, getSchedulerService: () => scheduler };
});
jest.mock('@/backend/services/enduringAgents/personaFlowRelease', () => {
  const actual = jest.requireActual('@/backend/services/enduringAgents/personaFlowRelease');
  return { ...actual, releasePersonaFlow: jest.fn(actual.releasePersonaFlow) };
});

import {
  addPersonaCompositionBehavior,
  copyPersonaCompositionFlow,
  readPersonaComposition,
  updatePersonaComposition,
} from '@/backend/services/enduringAgents/personaComposition';
import { getPersona } from '@/backend/services/enduringAgents/store';
import { PersonaDomainBusyError } from '@/backend/services/enduringAgents/domainMutation';
import { releasePersonaFlow } from '@/backend/services/enduringAgents/personaFlowRelease';
import { flowService } from '@/backend/services/flow';
import { deleteFlowAndMoveUses, findFlowUsage } from '@/backend/services/flow/flowDeletion';
import { runWithWorkspace } from '@/utils/workspace';
import { createPersonaFromRole } from '../enduringAgents/fixtures/personaFactory';

jest.setTimeout(120_000);

let sequence = 0;
function isolated(task: () => Promise<void>) {
  return runWithWorkspace(`flow-delete-in-use-${process.pid}-${++sequence}`, async () => {
    executions.length = 0;
    await task();
  });
}

async function saveShared(template: Flow, id: string, name: string): Promise<Flow> {
  const flow = { ...structuredClone(template), id, name } as Flow;
  delete (flow as Partial<Flow>).personaOwnership;
  expect((await flowService.saveFlow(flow)).success).toBe(true);
  return (await flowService.getFlow(id))!;
}

/** A Persona whose Core Flow is the shared flow `coreId`. */
async function personaOnCore(name: string, coreId: string, key: string) {
  const bundle = await createPersonaFromRole({ name, idempotencyKey: key });
  const template = bundle.behaviorRevisions[0].flowSnapshot as Flow;
  if (!await flowService.getFlow(coreId)) await saveShared(template, coreId, `Shared ${coreId}`);
  await updatePersonaComposition(bundle.persona.id, {
    expectedUpdatedAt: (await getPersona(bundle.persona.id))!.updatedAt,
    coreFlowRef: coreId,
  });
  return { personaId: bundle.persona.id, template };
}

describe('deleting a flow that is still used', () => {
  afterEach(() => jest.restoreAllMocks());

  it('deletes an unused flow at once, as before', () => isolated(async () => {
    const template = (await createPersonaFromRole({ name: 'Bystander', idempotencyKey: 'bystander' }))
      .behaviorRevisions[0].flowSnapshot as Flow;
    await saveShared(template, 'lonely', 'Lonely');

    const outcome = await deleteFlowAndMoveUses('lonely', null, null);

    expect(outcome.status).toBe('deleted');
    expect(await flowService.getFlow('lonely')).toBeNull();
  }));

  it('lists the Persona and keeps the flow when no choice was sent', () => isolated(async () => {
    const { personaId } = await personaOnCore('Jim', 'research', 'jim');

    const outcome = await deleteFlowAndMoveUses('research', null, null);

    expect(outcome).toMatchObject({ status: 'in-use', changed: false });
    if (outcome.status !== 'in-use') throw new Error('expected in-use');
    expect(outcome.usage.uses).toEqual([expect.objectContaining({
      key: `persona:${personaId}:core`,
      place: { kind: 'persona-core', personaId, personaName: 'Jim' },
      canRemove: true,
      removePauses: true,
    })]);
    expect(await flowService.getFlow('research')).not.toBeNull();
  }));

  it('switches one Persona to another flow and deletes', () => isolated(async () => {
    const { personaId, template } = await personaOnCore('Jim', 'research', 'jim');
    await saveShared(template, 'research-v2', 'Research v2');

    const outcome = await deleteFlowAndMoveUses('research', {
      choices: { [`persona:${personaId}:core`]: { replaceWith: 'research-v2' } },
    }, null);

    expect(outcome).toMatchObject({ status: 'deleted', summary: { personas: ['Jim'], pausedPersonas: [] } });
    expect(await flowService.getFlow('research')).toBeNull();
    const persona = (await getPersona(personaId))!;
    expect(persona.composition?.coreBinding).toEqual({ mode: 'shared', sharedFlowRef: 'research-v2' });
    expect(persona.lifecycleState).toBe('idle');
    expect((await readPersonaComposition(personaId))!.core?.readiness.state).not.toBe('missing');
  }));

  it('gives several Personas their own answers: one switches, one is paused without a Core Flow', () => isolated(async () => {
    const jim = await personaOnCore('Jim', 'research', 'jim');
    const ana = await personaOnCore('Ana', 'research', 'ana');
    await saveShared(jim.template, 'research-v2', 'Research v2');

    const outcome = await deleteFlowAndMoveUses('research', {
      choices: {
        [`persona:${jim.personaId}:core`]: { replaceWith: 'research-v2' },
        [`persona:${ana.personaId}:core`]: { remove: true },
      },
    }, null);

    expect(outcome).toMatchObject({ status: 'deleted', summary: { pausedPersonas: ['Ana'] } });
    expect((await getPersona(jim.personaId))!.composition?.coreBinding)
      .toEqual({ mode: 'shared', sharedFlowRef: 'research-v2' });
    const paused = (await getPersona(ana.personaId))!;
    expect(paused.lifecycleState).toBe('sleeping');
    expect(paused.composition?.coreBinding).toBeUndefined();
    expect(paused.composition?.coreFlowRef).toBeUndefined();
    expect(await flowService.getFlow('research')).toBeNull();
  }));

  it('removes an optional behavior, but a Role part always needs another flow', () => isolated(async () => {
    const { personaId, template } = await personaOnCore('Jim', 'core-flow', 'jim');
    await saveShared(template, 'helper', 'Helper');
    const added = await addPersonaCompositionBehavior(personaId, {
      expectedUpdatedAt: (await getPersona(personaId))!.updatedAt, sourceFlowRef: 'helper', mode: 'shared',
    });
    const helperRef = added.behaviors.at(-1)!.ref;
    const usage = (await findFlowUsage('helper'))!;
    expect(usage.uses).toEqual([expect.objectContaining({
      key: `persona:${personaId}:behavior:${helperRef}`, canRemove: true, removePauses: false,
    })]);

    const outcome = await deleteFlowAndMoveUses('helper', {
      choices: { [`persona:${personaId}:behavior:${helperRef}`]: { remove: true } },
    }, null);
    expect(outcome.status).toBe('deleted');
    expect((await getPersona(personaId))!.composition?.behaviors?.some((item) => item.ref === helperRef)).toBe(false);
    expect((await getPersona(personaId))!.lifecycleState).toBe('idle');

    const roleCopy = (await getPersona(personaId))!.composition!.behaviors!
      .find((item) => item.slotKey === 'maintain_memory')!;
    const roleFlowId = roleCopy.binding!.mode === 'persona_copy' ? roleCopy.binding!.personaFlowRef : '';
    const roleUsage = (await findFlowUsage(roleFlowId))!;
    expect(roleUsage.uses).toEqual([expect.objectContaining({ canRemove: false })]);
    const refused = await deleteFlowAndMoveUses(roleFlowId, {
      choices: { [roleUsage.uses[0].key]: { remove: true } },
    }, null);
    expect(refused).toMatchObject({ status: 'in-use', changed: true });
    expect(await flowService.getFlow(roleFlowId)).not.toBeNull();
  }));

  it('lets a Persona keep its own copy and forget where the copy came from', () => isolated(async () => {
    const { personaId, template } = await personaOnCore('Jim', 'core-flow', 'jim');
    await saveShared(template, 'original', 'Original');
    await copyPersonaCompositionFlow(personaId, {
      expectedUpdatedAt: (await getPersona(personaId))!.updatedAt, target: 'core', sourceFlowRef: 'original',
    });
    const copyId = (await getPersona(personaId))!.composition!.coreFlowRef!;

    const usage = (await findFlowUsage('original'))!;
    expect(usage.uses).toEqual([]);
    expect(usage.copySources).toEqual([{ personaId, personaName: 'Jim' }]);

    expect((await deleteFlowAndMoveUses('original', null, null)).status).toBe('deleted');
    expect((await getPersona(personaId))!.composition?.coreBinding).toEqual({ mode: 'persona_copy', personaFlowRef: copyId });
    expect(await flowService.getFlow(copyId)).not.toBeNull();
  }));

  it('suggests the original when deleting a Persona’s own copy', () => isolated(async () => {
    const { personaId, template } = await personaOnCore('Jim', 'core-flow', 'jim');
    await saveShared(template, 'original', 'Original');
    await copyPersonaCompositionFlow(personaId, {
      expectedUpdatedAt: (await getPersona(personaId))!.updatedAt, target: 'core', sourceFlowRef: 'original',
    });
    const copyId = (await getPersona(personaId))!.composition!.coreFlowRef!;

    const usage = (await findFlowUsage(copyId))!;
    expect(usage.uses).toEqual([expect.objectContaining({ suggestedFlowId: 'original' })]);
    const outcome = await deleteFlowAndMoveUses(copyId, {
      choices: { [usage.uses[0].key]: { replaceWith: 'original' } },
    }, null);
    expect(outcome.status).toBe('deleted');
    expect((await getPersona(personaId))!.composition?.coreBinding).toEqual({ mode: 'shared', sharedFlowRef: 'original' });
  }));

  it('switches automations and the steps of other flows, or turns them off and empties them', () => isolated(async () => {
    const template = (await createPersonaFromRole({ name: 'Bystander', idempotencyKey: 'bystander' }))
      .behaviorRevisions[0].flowSnapshot as Flow;
    await saveShared(template, 'target', 'Target');
    await saveShared(template, 'target-v2', 'Target v2');
    const parent = await saveShared(template, 'parent', 'Parent');
    parent.nodes.push(
      { id: 'one', type: 'subflow', position: { x: 0, y: 0 }, data: { label: 'One', type: 'subflow', properties: { subflowId: 'target' } } },
      { id: 'fan', type: 'subflow', position: { x: 0, y: 0 }, data: { label: 'Fan', type: 'subflow', properties: { parallelSubflowIds: ['target', 'target-v2'] } } },
    );
    expect((await flowService.saveFlow(parent)).success).toBe(true);
    const other = await saveShared(template, 'other-parent', 'Other parent');
    other.nodes.push({ id: 'call', type: 'subflow', position: { x: 0, y: 0 }, data: { label: 'Call', type: 'subflow', properties: { subflowId: 'target' } } });
    expect((await flowService.saveFlow(other)).success).toBe(true);
    const base = { prompt: '', enabled: true, trigger: { type: 'webhook' } } as unknown as PlannedExecution;
    executions.push(
      { ...base, id: 'daily', name: 'Daily digest', flowId: 'target' },
      { ...base, id: 'follow', name: 'Follow up', flowId: 'parent', trigger: { type: 'flow-event', source: { flowId: 'target' }, on: ['completed'] } },
      // Already off: it never starts the flow, and its editor asks for another one.
      { ...base, id: 'off', name: 'Old job', enabled: false, flowId: 'target' },
    );

    const usage = (await findFlowUsage('target'))!;
    expect(usage.uses.map((use) => use.key).sort()).toEqual([
      'automation:daily:runs', 'automation:follow:waits-for', 'flow:other-parent', 'flow:parent',
    ]);

    const outcome = await deleteFlowAndMoveUses('target', {
      choices: {
        'automation:daily:runs': { remove: true },
        'automation:follow:waits-for': { replaceWith: 'target-v2' },
        'flow:parent': { replaceWith: 'target-v2' },
        'flow:other-parent': { remove: true },
      },
    }, null);

    expect(outcome).toMatchObject({ status: 'deleted', summary: { turnedOffAutomations: ['Daily digest'] } });
    expect(executions.find((item) => item.id === 'daily')).toMatchObject({ enabled: false });
    expect(executions.find((item) => item.id === 'follow')!.trigger).toMatchObject({ source: { flowId: 'target-v2' } });
    const switched = (await flowService.getFlow('parent'))!;
    expect(switched.nodes.find((node) => node.id === 'one')!.data.properties).toMatchObject({ subflowId: 'target-v2' });
    expect(switched.nodes.find((node) => node.id === 'fan')!.data.properties!.parallelSubflowIds).toEqual(['target-v2']);
    expect((await flowService.getFlow('other-parent'))!.nodes.find((node) => node.id === 'call')!.data.properties!.subflowId)
      .toBeUndefined();
    expect(await flowService.getFlow('target')).toBeNull();
  }));

  it('keeps the flow and every switched place when the work stops part-way, and finishes on the next try', () => isolated(async () => {
    const jim = await personaOnCore('Jim', 'research', 'jim');
    const ana = await personaOnCore('Ana', 'research', 'ana');
    await saveShared(jim.template, 'research-v2', 'Research v2');
    const plan = {
      choices: {
        [`persona:${jim.personaId}:core`]: { replaceWith: 'research-v2' },
        [`persona:${ana.personaId}:core`]: { replaceWith: 'research-v2' },
      },
    };
    const realRelease = jest.requireActual('@/backend/services/enduringAgents/personaFlowRelease').releasePersonaFlow;
    jest.mocked(releasePersonaFlow)
      .mockImplementationOnce(realRelease)
      .mockImplementationOnce(async () => { throw new Error('process stopped'); });

    await expect(deleteFlowAndMoveUses('research', plan, null)).rejects.toThrow('process stopped');

    expect(await flowService.getFlow('research')).not.toBeNull();
    const usage = (await findFlowUsage('research'))!;
    expect(usage.uses).toHaveLength(1);
    const retried = await deleteFlowAndMoveUses('research', plan, null);
    expect(retried.status).toBe('deleted');
    for (const personaId of [jim.personaId, ana.personaId]) {
      expect((await getPersona(personaId))!.composition?.coreBinding).toEqual({ mode: 'shared', sharedFlowRef: 'research-v2' });
    }
  }));

  it('keeps the flow when the file removal fails after every place moved', () => isolated(async () => {
    const { personaId, template } = await personaOnCore('Jim', 'research', 'jim');
    await saveShared(template, 'research-v2', 'Research v2');
    jest.spyOn(flowService, 'deleteFlow').mockResolvedValueOnce({ success: false, error: 'disk busy' });

    const outcome = await deleteFlowAndMoveUses('research', {
      choices: { [`persona:${personaId}:core`]: { replaceWith: 'research-v2' } },
    }, null);

    expect(outcome).toMatchObject({ status: 'refused' });
    expect(await flowService.getFlow('research')).not.toBeNull();
    expect((await findFlowUsage('research'))!.uses).toEqual([]);
    expect((await deleteFlowAndMoveUses('research', null, null)).status).toBe('deleted');
  }));

  it('asks again when a new place started using the flow after the choices were made', () => isolated(async () => {
    const jim = await personaOnCore('Jim', 'research', 'jim');
    await saveShared(jim.template, 'research-v2', 'Research v2');
    const plan = { choices: { [`persona:${jim.personaId}:core`]: { replaceWith: 'research-v2' } } };
    const ana = await personaOnCore('Ana', 'research', 'ana');

    const outcome = await deleteFlowAndMoveUses('research', plan, null);

    expect(outcome).toMatchObject({ status: 'in-use', changed: true });
    expect(await flowService.getFlow('research')).not.toBeNull();
    expect((await getPersona(ana.personaId))!.composition?.coreFlowRef).toBe('research');
    expect((await getPersona(jim.personaId))!.composition?.coreFlowRef).toBe('research');
  }));

  it('keeps the flow and says so when a Persona stays busy past the wait', () => isolated(async () => {
    const jim = await personaOnCore('Jim', 'research', 'jim');
    await saveShared(jim.template, 'research-v2', 'Research v2');
    jest.mocked(releasePersonaFlow).mockRejectedValueOnce(new PersonaDomainBusyError(jim.personaId));

    const outcome = await deleteFlowAndMoveUses('research', {
      choices: { [`persona:${jim.personaId}:core`]: { replaceWith: 'research-v2' } },
    }, null);

    expect(outcome).toMatchObject({ status: 'refused', busy: true });
    if (outcome.status === 'refused') expect(outcome.error).toContain('Persona "Jim" is working right now');
    expect(await flowService.getFlow('research')).not.toBeNull();
  }));

  it('refuses a Persona-owned replacement before changing anything', () => isolated(async () => {
    const jim = await personaOnCore('Jim', 'research', 'jim');
    const ownedCopy = (await getPersona(jim.personaId))!.composition!.behaviors!
      .find((item) => item.binding?.mode === 'persona_copy')!;
    const ownedId = ownedCopy.binding!.mode === 'persona_copy' ? ownedCopy.binding!.personaFlowRef : '';

    const outcome = await deleteFlowAndMoveUses('research', {
      choices: { [`persona:${jim.personaId}:core`]: { replaceWith: ownedId } },
    }, null);

    expect(outcome).toMatchObject({ status: 'refused' });
    expect((await getPersona(jim.personaId))!.composition?.coreFlowRef).toBe('research');
    expect(await flowService.getFlow('research')).not.toBeNull();
  }));
});
