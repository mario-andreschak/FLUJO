import { flowService } from '@/backend/services/flow';
import { rewriteSavedFlow } from '@/backend/services/flow/flowRewrite';
import {
  PersonaDomainBusyError,
  PersonaDomainConflictError,
  PersonaDomainNotFoundError,
} from '@/backend/services/enduringAgents/domainMutation';
import {
  personaFlowPlaces,
  personaRoleSlots,
  personaUsesFlow,
  releasePersonaFlow,
  type PersonaFlowAnswers,
} from '@/backend/services/enduringAgents/personaFlowRelease';
import { getPersonaDeletionTombstone, listPersonas } from '@/backend/services/enduringAgents/store';
import { withAutomationStarter } from '@/backend/services/accounts/automationStarter';
import { recordChange, type SharedEditor } from '@/backend/services/sharedItems/guard';
import type { Flow } from '@/shared/types/flow';
import { planAnswersEvery } from '@/shared/types/deletePlan';
import {
  FLOW_IN_USE_CODE,
  type FlowAutomationRole,
  type FlowDeletePlan,
  type FlowDeleteSummary,
  type FlowUsage,
  type FlowUse,
  type FlowUseChoice,
} from '@/shared/types/flow/flowUsage';
import {
  isPersonaControlledPlannedExecution,
  type PlannedExecution,
} from '@/shared/types/plannedExecution';
import { subflowStepTargets } from '@/utils/shared/whereUsed';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/flow/flowDeletion');

/**
 * Deleting a flow that other things still use (#1389). Every place that uses
 * the flow (Persona parts, automations, other flows' subflow steps) gets the
 * person's answer first: another flow, or giving the flow up. The flow itself
 * is deleted last. A crash part-way therefore leaves the flow in place with
 * some places already switched, which is a state the person asked for; the
 * next delete simply finds fewer places. Nothing ever points at a deleted flow.
 *
 * This is the only way FLUJO deletes a flow a person picked;
 * `flowService.deleteFlow` is the raw file removal underneath.
 */

export type FlowDeleteOutcome =
  | { status: 'deleted'; summary: FlowDeleteSummary }
  | { status: 'not-found' }
  | { status: 'in-use'; usage: FlowUsage; changed: boolean }
  | { status: 'refused'; error: string; busy?: boolean };

async function schedulerService() {
  return (await import('@/backend/services/scheduler')).getSchedulerService();
}

/**
 * How a switched-on automation uses `flowId`. A switched-off automation never
 * starts the flow, and its editor already asks for another flow when its flow
 * is gone, so it is not a place to ask about.
 */
function automationRoles(execution: PlannedExecution, flowId: string): FlowAutomationRole[] {
  if (!execution.enabled || execution.personaRetired || execution.personaArchived) return [];
  const roles: FlowAutomationRole[] = [];
  if (!isPersonaControlledPlannedExecution(execution) && execution.flowId === flowId) roles.push('runs');
  const trigger = execution.trigger;
  const legacyGate = trigger.type === 'mcp-poll' && trigger.evaluate.mode === 'flow-gate' ? trigger.evaluate : null;
  if ((execution.aiGate?.mode === 'flow-gate' && execution.aiGate.flowId === flowId) || legacyGate?.flowId === flowId) {
    roles.push('checks');
  }
  if (trigger.type === 'flow-event' && trigger.source.flowId === flowId) roles.push('waits-for');
  return roles;
}

const personaCoreKey = (personaId: string) => `persona:${personaId}:core`;
const personaBehaviorKey = (personaId: string, ref: string) => `persona:${personaId}:behavior:${ref}`;
const automationKey = (executionId: string, role: FlowAutomationRole) => `automation:${executionId}:${role}`;
const subflowKey = (parentFlowId: string) => `flow:${parentFlowId}`;

/** Every place that uses `flowId`, or `null` when the flow does not exist. */
export async function findFlowUsage(flowId: string): Promise<FlowUsage | null> {
  const flow = await flowService.getFlow(flowId);
  if (!flow) return null;
  const uses: FlowUse[] = [];
  const copySources: FlowUsage['copySources'] = [];

  for (const persona of await listPersonas()) {
    const quick = personaFlowPlaces(persona, flowId, new Set());
    if (!personaUsesFlow(quick) || await getPersonaDeletionTombstone(persona.id)) continue;
    const slots = await personaRoleSlots(persona);
    const places = personaFlowPlaces(persona, flowId, slots.requiredSlotKeys, slots.slotKeyByRef);
    const personaName = persona.name;
    if (places.core) {
      uses.push({
        key: personaCoreKey(persona.id),
        place: { kind: 'persona-core', personaId: persona.id, personaName },
        canRemove: true,
        removePauses: persona.lifecycleState !== 'disabled',
        ...(places.core.suggestedFlowId ? { suggestedFlowId: places.core.suggestedFlowId } : {}),
      });
    }
    for (const behavior of places.behaviors) {
      uses.push({
        key: personaBehaviorKey(persona.id, behavior.ref),
        place: {
          kind: 'persona-behavior',
          personaId: persona.id,
          personaName,
          behaviorRef: behavior.ref,
          behaviorName: behavior.name,
          ...(behavior.slotKey ? { slotKey: behavior.slotKey } : {}),
        },
        canRemove: !behavior.required,
        removePauses: false,
        ...(behavior.suggestedFlowId ? { suggestedFlowId: behavior.suggestedFlowId } : {}),
      });
    }
    if (places.copySource && !places.core && places.behaviors.length === 0) {
      copySources.push({ personaId: persona.id, personaName });
    }
  }

  for (const execution of await (await schedulerService()).listConfigs()) {
    for (const role of automationRoles(execution, flowId)) {
      uses.push({
        key: automationKey(execution.id, role),
        place: {
          kind: 'automation',
          executionId: execution.id,
          automationName: execution.name,
          role,
          personaControlled: isPersonaControlledPlannedExecution(execution),
        },
        canRemove: true,
        removePauses: false,
      });
    }
  }

  for (const parent of await flowService.loadFlows()) {
    if (parent.id === flowId) continue;
    if (parent.nodes.some((node) => subflowStepTargets(node).includes(flowId))) {
      uses.push({
        key: subflowKey(parent.id),
        place: { kind: 'subflow', flowId: parent.id, flowName: parent.name || parent.id },
        canRemove: true,
        removePauses: false,
      });
    }
  }

  return { flowId, flowName: flow.name || flowId, uses, copySources };
}

/** Whether carrying out this delete changes Personas, which their own pages allow only from this computer. */
export function flowDeleteTouchesPersonas(usage: FlowUsage): { personas: boolean; personaAutomations: boolean } {
  return {
    personas: usage.copySources.length > 0 || usage.uses.some((use) => use.place.kind.startsWith('persona-')),
    personaAutomations: usage.uses.some((use) => use.place.kind === 'automation' && use.place.personaControlled),
  };
}

function ownerLabel(use: FlowUse): string {
  switch (use.place.kind) {
    case 'persona-core':
    case 'persona-behavior':
      return `Persona "${use.place.personaName}"`;
    case 'automation':
      return `automation "${use.place.automationName}"`;
    case 'subflow':
      return `flow "${use.place.flowName}"`;
  }
}

function placeName(use: FlowUse): string {
  return use.place.kind === 'persona-behavior'
    ? `"${use.place.behaviorName}" of ${ownerLabel(use)}`
    : ownerLabel(use);
}

function inUseMessage(usage: FlowUsage): string {
  const names = [...new Set(usage.uses.map(ownerLabel))];
  return `Flow "${usage.flowName}" is still used by ${names.join(', ')}. Choose another flow for each place, or take the flow away from it, and delete again.`;
}

export function flowInUseBody(usage: FlowUsage, changed = false) {
  return {
    error: changed
      ? 'Something changed while you were choosing. Check the choices again.'
      : inUseMessage(usage),
    code: FLOW_IN_USE_CODE,
    usage,
    ...(changed ? { changed: true } : {}),
  };
}

async function checkReplacements(usage: FlowUsage, plan: FlowDeletePlan): Promise<string | null> {
  for (const use of usage.uses) {
    const choice = plan.choices[use.key];
    if (!('replaceWith' in choice)) continue;
    const target = choice.replaceWith;
    if (target === usage.flowId) return 'Choose a different flow than the one you are deleting.';
    const flow = await flowService.getFlow(target);
    if (!flow) return `The flow chosen for ${placeName(use)} no longer exists. Choose another one.`;
    if (use.place.kind.startsWith('persona-') && flow.personaOwnership) {
      return `"${flow.name}" belongs to a Persona. Choose a shared flow for ${placeName(use)}.`;
    }
    if (use.place.kind === 'subflow' && target === use.place.flowId) {
      return `"${flow.name}" cannot call itself. Choose another flow for it.`;
    }
  }
  return null;
}

function automationPatch(
  execution: PlannedExecution,
  flowId: string,
  answers: Map<FlowAutomationRole, FlowUseChoice>,
): Partial<PlannedExecution> {
  const patch: Partial<PlannedExecution> = {};
  for (const [role, choice] of answers) {
    if (!('replaceWith' in choice)) {
      patch.enabled = false;
      continue;
    }
    const target = choice.replaceWith;
    if (role === 'runs') patch.flowId = target;
    if (role === 'checks') {
      if (execution.aiGate?.mode === 'flow-gate' && execution.aiGate.flowId === flowId) {
        patch.aiGate = { ...execution.aiGate, flowId: target };
      }
      const trigger = patch.trigger ?? execution.trigger;
      if (trigger.type === 'mcp-poll' && trigger.evaluate.mode === 'flow-gate' && trigger.evaluate.flowId === flowId) {
        patch.trigger = { ...trigger, evaluate: { ...trigger.evaluate, flowId: target } };
      }
    }
    if (role === 'waits-for') {
      const trigger = patch.trigger ?? execution.trigger;
      if (trigger.type === 'flow-event') {
        patch.trigger = { ...trigger, source: { ...trigger.source, flowId: target } };
      }
    }
  }
  return patch;
}

function rewriteSubflowSteps(parent: Flow, flowId: string, choice: FlowUseChoice): Flow {
  const replacement = 'replaceWith' in choice ? choice.replaceWith : undefined;
  return {
    ...parent,
    nodes: parent.nodes.map((node) => {
      if (!subflowStepTargets(node).includes(flowId)) return node;
      const properties = { ...(node.data?.properties ?? {}) };
      if (properties.subflowId === flowId) {
        if (replacement) properties.subflowId = replacement;
        else delete properties.subflowId;
      }
      if (Array.isArray(properties.parallelSubflowIds)) {
        const ids = (properties.parallelSubflowIds as unknown[]).flatMap((id) => (
          id !== flowId ? [id] : replacement ? [replacement] : []
        ));
        properties.parallelSubflowIds = [...new Set(ids)];
      }
      return { ...node, data: { ...node.data, properties } };
    }),
  };
}

function notDeleted(reason: string): string {
  return `${reason} The flow was not deleted. Places that were already switched stay switched.`;
}

/** One Persona record write each; stops at the first Persona that cannot change now. */
async function releasePersonas(
  flowId: string,
  personaAnswers: Map<string, { name: string; answers: PersonaFlowAnswers }>,
  summary: FlowDeleteSummary,
): Promise<FlowDeleteOutcome | null> {
  for (const [personaId, { name, answers }] of personaAnswers) {
    try {
      const released = await releasePersonaFlow(personaId, flowId, answers);
      if (released.changed && !summary.personas.includes(name)) summary.personas.push(name);
      if (released.paused) summary.pausedPersonas.push(name);
    } catch (error) {
      if (error instanceof PersonaDomainConflictError && error.code === 'FLOW_USE_CHANGED') {
        const fresh = await findFlowUsage(flowId);
        return fresh ? { status: 'in-use', usage: fresh, changed: true } : { status: 'not-found' };
      }
      if (error instanceof PersonaDomainBusyError) {
        return { status: 'refused', busy: true, error: notDeleted(`Persona "${name}" is working right now. Try again when it finishes.`) };
      }
      if (error instanceof PersonaDomainConflictError) return { status: 'refused', error: notDeleted(error.message) };
      if (error instanceof PersonaDomainNotFoundError) continue;
      throw error;
    }
  }
  return null;
}

/**
 * Carry out the person's choices, then delete the flow. Without a plan the flow
 * is deleted only when nothing needs a choice; otherwise the answer lists the
 * places so the page can ask.
 */
export async function deleteFlowAndMoveUses(
  flowId: string,
  plan: FlowDeletePlan | null,
  editor: SharedEditor | null,
): Promise<FlowDeleteOutcome> {
  const usage = await findFlowUsage(flowId);
  if (!usage) return { status: 'not-found' };
  if (usage.uses.length > 0 && !plan) return { status: 'in-use', usage, changed: false };
  const effectivePlan: FlowDeletePlan = plan ?? { choices: {} };
  if (!planAnswersEvery(usage.uses, effectivePlan)) return { status: 'in-use', usage, changed: true };
  const replacementError = await checkReplacements(usage, effectivePlan);
  if (replacementError) return { status: 'refused', error: replacementError };

  const summary: FlowDeleteSummary = { personas: [], pausedPersonas: [], automations: [], turnedOffAutomations: [], flows: [] };

  const personaAnswers = new Map<string, { name: string; answers: PersonaFlowAnswers }>();
  for (const source of usage.copySources) {
    personaAnswers.set(source.personaId, { name: source.personaName, answers: { behaviors: {} } });
  }
  for (const use of usage.uses) {
    if (use.place.kind !== 'persona-core' && use.place.kind !== 'persona-behavior') continue;
    const entry = personaAnswers.get(use.place.personaId)
      ?? { name: use.place.personaName, answers: { behaviors: {} } };
    if (use.place.kind === 'persona-core') entry.answers.core = effectivePlan.choices[use.key];
    else entry.answers.behaviors[use.place.behaviorRef] = effectivePlan.choices[use.key];
    personaAnswers.set(use.place.personaId, entry);
  }
  const personasStopped = await releasePersonas(flowId, personaAnswers, summary);
  if (personasStopped) return personasStopped;

  const automationAnswers = new Map<string, Map<FlowAutomationRole, FlowUseChoice>>();
  for (const use of usage.uses) {
    if (use.place.kind !== 'automation') continue;
    const answers = automationAnswers.get(use.place.executionId) ?? new Map();
    answers.set(use.place.role, effectivePlan.choices[use.key]);
    automationAnswers.set(use.place.executionId, answers);
  }
  if (automationAnswers.size > 0) {
    const scheduler = await schedulerService();
    for (const [executionId, answers] of automationAnswers) {
      const execution = await scheduler.get(executionId);
      if (!execution) continue;
      const patch = automationPatch(execution, flowId, answers);
      const result = await scheduler.update(executionId, withAutomationStarter(patch));
      if (result.error) {
        return { status: 'refused', error: notDeleted(`Could not change automation "${execution.name}": ${result.error}.`) };
      }
      summary.automations.push(execution.name);
      if (patch.enabled === false && execution.enabled) summary.turnedOffAutomations.push(execution.name);
    }
  }

  for (const use of usage.uses) {
    if (use.place.kind !== 'subflow') continue;
    const choice = effectivePlan.choices[use.key];
    const error = await rewriteSavedFlow(
      use.place.flowId,
      (parent) => parent.nodes.some((node) => subflowStepTargets(node).includes(flowId)),
      (parent) => rewriteSubflowSteps(parent, flowId, choice),
      editor,
    );
    if (error) return { status: 'refused', error: notDeleted(error) };
    summary.flows.push(use.place.flowName);
  }

  // Someone may have started using the flow while the places above changed.
  const remaining = await findFlowUsage(flowId);
  if (!remaining) return { status: 'not-found' };
  if (remaining.uses.length > 0) return { status: 'in-use', usage: remaining, changed: true };
  const lateCopies = await releasePersonas(flowId, new Map(remaining.copySources.map((source) => (
    [source.personaId, { name: source.personaName, answers: { behaviors: {} } }]
  ))), summary);
  if (lateCopies) return lateCopies;

  const before = await flowService.getFlow(flowId);
  const result = await flowService.deleteFlow(flowId);
  if (!result.success) {
    return { status: 'refused', error: notDeleted(result.error || 'Failed to delete flow.') };
  }
  await recordChange(editor, { kind: 'flow', itemId: flowId, action: 'deleted', before, after: null });
  log.info('Flow deleted after moving the places that used it', {
    flowId,
    personas: summary.personas.length,
    automations: summary.automations.length,
    flows: summary.flows.length,
  });
  return { status: 'deleted', summary };
}
