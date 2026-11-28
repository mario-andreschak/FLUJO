import { findFlowUsage } from '@/backend/services/flow/flowDeletion';
import { findMcpServerUsage } from '@/backend/services/mcp/serverDeletion';
import { planAnswersEvery, type DeletePlan, type UseChoice } from '@/shared/types/deletePlan';
import type { FlowUse, FlowUsage } from '@/shared/types/flow/flowUsage';
import type { McpServerUse, McpServerUsage } from '@/shared/types/mcp/serverUsage';
import type { PackageUninstallPlan, PackageUsage } from '@/shared/types/package/uninstall';

/**
 * Which places a package uninstall must ask about (#1389). Flows, Connected
 * Apps and automations the package created leave with it, so places inside
 * them are let go without a question; every place outside the package needs
 * the person's answer, as when deleting one flow or app.
 */

export interface PackageLeaving {
  flowIds: readonly string[];
  serverNames: readonly string[];
  executionIds: readonly string[];
}

function insideFlowUse(use: FlowUse, leaving: PackageLeaving): boolean {
  if (use.place.kind === 'subflow') return leaving.flowIds.includes(use.place.flowId);
  if (use.place.kind === 'automation') return leaving.executionIds.includes(use.place.executionId);
  return false;
}

function insideServerUse(use: McpServerUse, leaving: PackageLeaving): boolean {
  if (use.place.kind === 'flow') return leaving.flowIds.includes(use.place.flowId);
  if (use.place.kind === 'automation') return leaving.executionIds.includes(use.place.executionId);
  return false;
}

/** The package's flows and apps that something outside the package uses, with only those places. */
export async function findPackageUsage(packageName: string, leaving: PackageLeaving): Promise<PackageUsage> {
  const flows: FlowUsage[] = [];
  for (const flowId of leaving.flowIds) {
    const usage = await findFlowUsage(flowId);
    const outside = usage?.uses.filter((use) => !insideFlowUse(use, leaving)) ?? [];
    if (usage && outside.length > 0) flows.push({ ...usage, uses: outside });
  }
  const servers: McpServerUsage[] = [];
  for (const serverName of leaving.serverNames) {
    const usage = await findMcpServerUsage(serverName);
    const outside = usage?.uses.filter((use) => !insideServerUse(use, leaving)) ?? [];
    if (usage && outside.length > 0) servers.push({ ...usage, uses: outside });
  }
  return {
    packageName,
    flows,
    servers,
    leaving: { flowIds: [...leaving.flowIds], serverNames: [...leaving.serverNames] },
  };
}

export function packageUsageIsEmpty(usage: PackageUsage): boolean {
  return usage.flows.length === 0 && usage.servers.length === 0;
}

/** Whether carrying out the answers changes an automation that runs a Persona. */
export function packageUsageTouchesPersonaAutomations(usage: PackageUsage): boolean {
  return [...usage.flows.flatMap((flow) => flow.uses), ...usage.servers.flatMap((server) => server.uses)]
    .some((use) => use.place.kind === 'automation' && use.place.personaControlled);
}

/**
 * `'unanswered'` when a place outside the package has no fitting answer, a
 * plain reason when an answer hands a place to something that leaves too, or
 * `null` when the plan can be carried out.
 */
export function checkPackagePlan(usage: PackageUsage, plan: PackageUninstallPlan): 'unanswered' | string | null {
  for (const flow of usage.flows) {
    const answers = plan.flows[flow.flowId];
    if (!answers || !planAnswersEvery(flow.uses, answers)) return 'unanswered';
    for (const use of flow.uses) {
      const choice = answers.choices[use.key];
      if ('replaceWith' in choice && usage.leaving.flowIds.includes(choice.replaceWith)) {
        return `The flow chosen instead of "${flow.flowName}" is removed with the package too. Choose a flow that stays.`;
      }
    }
  }
  for (const server of usage.servers) {
    const answers = plan.servers[server.serverName];
    if (!answers || !planAnswersEvery(server.uses, answers)) return 'unanswered';
    for (const use of server.uses) {
      const choice = answers.choices[use.key];
      if ('replaceWith' in choice && usage.leaving.serverNames.includes(choice.replaceWith)) {
        return `The app chosen instead of "${server.serverName}" is removed with the package too. Choose an app that stays.`;
      }
    }
  }
  return null;
}

function fullPlan<U extends { key: string }>(
  uses: readonly U[],
  inside: (use: U) => boolean,
  answers: DeletePlan | undefined,
): DeletePlan | null {
  if (uses.length === 0) return null;
  const letGo: UseChoice = { remove: true };
  return {
    choices: Object.fromEntries(uses.flatMap((use) => {
      const choice = inside(use) ? letGo : answers?.choices[use.key];
      return choice ? [[use.key, choice]] : [];
    })),
  };
}

/** The whole plan for one package flow: the person's answers outside the package, "let go" inside it. */
export function packageFlowPlan(usage: FlowUsage, leaving: PackageLeaving, plan: PackageUninstallPlan | null): DeletePlan | null {
  return fullPlan(usage.uses, (use) => insideFlowUse(use, leaving), plan?.flows[usage.flowId]);
}

/** The whole plan for one package app: the person's answers outside the package, "let go" inside it. */
export function packageServerPlan(usage: McpServerUsage, leaving: PackageLeaving, plan: PackageUninstallPlan | null): DeletePlan | null {
  return fullPlan(usage.uses, (use) => insideServerUse(use, leaving), plan?.servers[usage.serverName]);
}
