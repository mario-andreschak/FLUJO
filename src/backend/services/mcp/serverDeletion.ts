import { mcpService } from '@/backend/services/mcp';
import { loadServerConfigs } from '@/backend/services/mcp/config';
import { flowService } from '@/backend/services/flow';
import { rewriteSavedFlow } from '@/backend/services/flow/flowRewrite';
import { personaUsesApp, releasePersonaApp } from '@/backend/services/enduringAgents/personaAppGrants';
import {
  getPersonaDeletionTombstone,
  listPersonaAppGrants,
  listPersonas,
} from '@/backend/services/enduringAgents/store';
import { withAutomationStarter } from '@/backend/services/accounts/automationStarter';
import { recordChange, type SharedEditor } from '@/backend/services/sharedItems/guard';
import { loadSharedItem } from '@/backend/services/sharedItems/load';
import type { Flow } from '@/shared/types/flow';
import type { MCPServerConfig } from '@/shared/types/mcp';
import { planAnswersEvery, type DeletePlan, type UseChoice } from '@/shared/types/deletePlan';
import {
  MCP_SERVER_IN_USE_CODE,
  type McpServerAutomationRole,
  type McpServerDeleteSummary,
  type McpServerUsage,
  type McpServerUse,
} from '@/shared/types/mcp/serverUsage';
import {
  isPersonaControlledPlannedExecution,
  type PlannedExecution,
} from '@/shared/types/plannedExecution';
import { resolveAutoNodeLabel } from '@/shared/utils/nodeLabel';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/services/mcp/serverDeletion');

/**
 * Deleting a Connected App (MCP server) that flows, Personas or automations
 * still use (#1389). Every place gets the person's answer first: another app,
 * or giving the app up (a flow step is left without an app, a Persona loses
 * the app, an automation is turned off). The app itself is deleted last, so a
 * stop part-way leaves the app in place with some places already switched,
 * and the next delete only asks about what is left. Nothing ever points at an
 * app that is gone.
 *
 * This is the only way FLUJO deletes an app a person picked;
 * `mcpService.deleteServerConfig` is the raw removal underneath.
 */

export type McpServerDeleteOutcome =
  | { status: 'deleted'; summary: McpServerDeleteSummary }
  | { status: 'not-found' }
  | { status: 'in-use'; usage: McpServerUsage; changed: boolean }
  | { status: 'refused'; error: string };

const MCP_NODE_LABEL = 'MCP Node';

async function schedulerService() {
  return (await import('@/backend/services/scheduler')).getSchedulerService();
}

async function readConfigs(): Promise<MCPServerConfig[] | null> {
  const configs = await loadServerConfigs();
  return Array.isArray(configs) ? configs : null;
}

function boundSteps(flow: Pick<Flow, 'nodes'>, serverName: string): number {
  return flow.nodes.filter((node) => node.data?.properties?.boundServer === serverName).length;
}

/**
 * How a switched-on automation uses `serverName`. A switched-off automation
 * calls nothing, and its editor asks for another app when its app is gone.
 */
function automationRole(execution: PlannedExecution, serverName: string): McpServerAutomationRole | null {
  if (!execution.enabled || execution.personaRetired || execution.personaArchived) return null;
  const trigger = execution.trigger;
  if (trigger.type === 'mcp-poll' && trigger.serverName === serverName) return 'polls';
  if (trigger.type === 'mcp-event' && trigger.serverName === serverName) return 'listens';
  return null;
}

const flowKey = (flowId: string) => `flow:${flowId}`;
const personaKey = (personaId: string) => `persona:${personaId}:app`;
const automationKey = (executionId: string, role: McpServerAutomationRole) => `automation:${executionId}:${role}`;

/** Every place that uses `serverName`, or `null` when no such app is configured. */
export async function findMcpServerUsage(serverName: string): Promise<McpServerUsage | null> {
  const configs = await readConfigs();
  if (!configs) throw new Error('Connected Apps could not be read right now. Try again in a moment.');
  if (!configs.some((config) => config.name === serverName)) return null;
  const uses: McpServerUse[] = [];

  const personaNames = new Map<string, string>();
  for (const persona of await listPersonas()) {
    if (await getPersonaDeletionTombstone(persona.id)) continue;
    personaNames.set(persona.id, persona.name);
    if (personaUsesApp(persona, await listPersonaAppGrants(persona.id), serverName)) {
      uses.push({
        key: personaKey(persona.id),
        place: { kind: 'persona-app', personaId: persona.id, personaName: persona.name },
        canRemove: true,
      });
    }
  }

  for (const flow of await flowService.loadFlows()) {
    const steps = boundSteps(flow, serverName);
    if (steps === 0) continue;
    const personaName = flow.personaOwnership ? personaNames.get(flow.personaOwnership.personaId) : undefined;
    uses.push({
      key: flowKey(flow.id),
      place: { kind: 'flow', flowId: flow.id, flowName: flow.name || flow.id, steps, ...(personaName ? { personaName } : {}) },
      canRemove: true,
    });
  }

  for (const execution of await (await schedulerService()).listConfigs()) {
    const role = automationRole(execution, serverName);
    if (!role) continue;
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
    });
  }

  return { serverName, uses };
}

/** Whether carrying out this delete changes Personas, which their own pages allow only from this computer. */
export function mcpServerDeleteTouchesPersonas(usage: McpServerUsage): { personas: boolean; personaAutomations: boolean } {
  return {
    personas: usage.uses.some((use) => use.place.kind === 'persona-app'
      || (use.place.kind === 'flow' && Boolean(use.place.personaName))),
    personaAutomations: usage.uses.some((use) => use.place.kind === 'automation' && use.place.personaControlled),
  };
}

function placeName(use: McpServerUse): string {
  switch (use.place.kind) {
    case 'flow':
      return `flow "${use.place.flowName}"`;
    case 'persona-app':
      return `Persona "${use.place.personaName}"`;
    case 'automation':
      return `automation "${use.place.automationName}"`;
  }
}

function inUseMessage(usage: McpServerUsage): string {
  const names = [...new Set(usage.uses.map(placeName))];
  return `Connected App "${usage.serverName}" is still used by ${names.join(', ')}. Choose another app for each place, or take the app away from it, and delete again.`;
}

export function mcpServerInUseBody(usage: McpServerUsage, changed = false) {
  return {
    error: changed
      ? 'Something changed while you were choosing. Check the choices again.'
      : inUseMessage(usage),
    code: MCP_SERVER_IN_USE_CODE,
    usage,
    ...(changed ? { changed: true } : {}),
  };
}

function checkReplacements(usage: McpServerUsage, plan: DeletePlan, configs: readonly MCPServerConfig[]): string | null {
  for (const use of usage.uses) {
    const choice = plan.choices[use.key];
    if (!('replaceWith' in choice)) continue;
    const target = choice.replaceWith;
    if (target === usage.serverName) return 'Choose a different app than the one you are deleting.';
    const config = configs.find((candidate) => candidate.name === target);
    if (!config) return `The app chosen for ${placeName(use)} no longer exists. Choose another one.`;
    if (use.place.kind === 'persona-app' && config.disabled === true) {
      return `"${target}" is turned off. Choose an app that is on for ${placeName(use)}.`;
    }
  }
  return null;
}

/** Point every step that uses `serverName` at `replacement`, or leave it without an app. */
export function rewriteBoundSteps(flow: Flow, serverName: string, replacement: string | null): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const current = node.data?.properties;
      if (!current || current.boundServer !== serverName) return node;
      const isMcpStep = (node.data?.type ?? node.type) === 'mcp';
      const properties: Record<string, unknown> = { ...current };
      if (replacement) {
        properties.boundServer = replacement;
      } else {
        delete properties.boundServer;
        if (isMcpStep) {
          delete properties.enabledTools;
          delete properties.toolParameterPresets;
        }
      }
      const label = isMcpStep
        ? resolveAutoNodeLabel({
            currentLabel: node.data?.label,
            nameIsCustom: current.nameIsCustom === true,
            defaultLabel: MCP_NODE_LABEL,
            previousAutoLabel: serverName,
            nextAutoLabel: replacement ?? MCP_NODE_LABEL,
          })
        : node.data?.label;
      return { ...node, data: { ...node.data, label, properties } };
    }),
  };
}

function automationPatch(execution: PlannedExecution, choice: UseChoice): Partial<PlannedExecution> {
  if (!('replaceWith' in choice)) return { enabled: false };
  const trigger = execution.trigger;
  return trigger.type === 'mcp-poll' || trigger.type === 'mcp-event'
    ? { trigger: { ...trigger, serverName: choice.replaceWith } }
    : {};
}

function notDeleted(reason: string): string {
  return `${reason} The app was not deleted. Places that were already switched stay switched.`;
}

async function removeServerConfig(serverName: string): Promise<{ success: boolean; error?: string }> {
  try {
    return await mcpService.deleteServerConfig(serverName);
  } catch (error) {
    // The config may have been removed before the follow-up cleanup failed.
    const configs = await readConfigs();
    if (configs && !configs.some((config) => config.name === serverName)) return { success: true };
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Carry out the person's choices, then delete the app. Without a plan the app
 * is deleted only when nothing uses it; otherwise the answer lists the places
 * so the page can ask.
 */
export async function deleteMcpServerAndMoveUses(
  serverName: string,
  plan: DeletePlan | null,
  editor: SharedEditor | null,
): Promise<McpServerDeleteOutcome> {
  const configs = await readConfigs();
  if (!configs) return { status: 'refused', error: 'Connected Apps could not be read right now. Nothing was deleted. Try again in a moment.' };
  const usage = await findMcpServerUsage(serverName);
  if (!usage) return { status: 'not-found' };
  if (usage.uses.length > 0 && !plan) return { status: 'in-use', usage, changed: false };
  const effectivePlan: DeletePlan = plan ?? { choices: {} };
  if (!planAnswersEvery(usage.uses, effectivePlan)) return { status: 'in-use', usage, changed: true };
  const replacementError = checkReplacements(usage, effectivePlan, configs);
  if (replacementError) return { status: 'refused', error: replacementError };

  const summary: McpServerDeleteSummary = { flows: [], personas: [], automations: [], turnedOffAutomations: [] };

  for (const use of usage.uses) {
    if (use.place.kind !== 'flow') continue;
    const choice = effectivePlan.choices[use.key];
    const replacement = 'replaceWith' in choice ? choice.replaceWith : null;
    const error = await rewriteSavedFlow(
      use.place.flowId,
      (flow) => boundSteps(flow, serverName) > 0,
      (flow) => rewriteBoundSteps(flow, serverName, replacement),
      editor,
    );
    if (error) return { status: 'refused', error: notDeleted(error) };
    summary.flows.push(use.place.flowName);
  }

  for (const use of usage.uses) {
    if (use.place.kind !== 'persona-app') continue;
    try {
      const released = await releasePersonaApp(use.place.personaId, serverName, effectivePlan.choices[use.key]);
      if (released.changed) summary.personas.push(use.place.personaName);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'refused', error: notDeleted(`Could not change Persona "${use.place.personaName}": ${reason}`) };
    }
  }

  const automationUses = usage.uses.filter((use) => use.place.kind === 'automation');
  if (automationUses.length > 0) {
    const scheduler = await schedulerService();
    for (const use of automationUses) {
      if (use.place.kind !== 'automation') continue;
      const execution = await scheduler.get(use.place.executionId);
      if (!execution || !automationRole(execution, serverName)) continue;
      const patch = automationPatch(execution, effectivePlan.choices[use.key]);
      const result = await scheduler.update(execution.id, withAutomationStarter(patch));
      if (result.error) {
        return { status: 'refused', error: notDeleted(`Could not change automation "${execution.name}": ${result.error}.`) };
      }
      summary.automations.push(execution.name);
      if (patch.enabled === false) summary.turnedOffAutomations.push(execution.name);
    }
  }

  // Someone may have started using the app while the places above changed.
  const remaining = await findMcpServerUsage(serverName);
  if (!remaining) return { status: 'not-found' };
  if (remaining.uses.length > 0) return { status: 'in-use', usage: remaining, changed: true };

  const before = editor ? await loadSharedItem('mcp-server', serverName) : null;
  const result = await removeServerConfig(serverName);
  if (!result.success) {
    return { status: 'refused', error: notDeleted(result.error || 'Failed to delete the app.') };
  }
  await recordChange(editor, { kind: 'mcp-server', itemId: serverName, action: 'deleted', before, after: null });
  log.info('Connected App deleted after moving the places that used it', {
    serverName,
    flows: summary.flows.length,
    personas: summary.personas.length,
    automations: summary.automations.length,
  });
  return { status: 'deleted', summary };
}
