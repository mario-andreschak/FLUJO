/**
 * Removing a package whose flows or Connected Apps are still used outside the
 * package (#1389). Places inside the package leave with it; every other place
 * gets the person's answer first, exactly as when deleting one flow or app.
 */
import { readDeletePlan, type DeletePlan } from '@/shared/types/deletePlan';
import type { FlowUsage } from '@/shared/types/flow/flowUsage';
import type { McpServerUsage } from '@/shared/types/mcp/serverUsage';

export const PACKAGE_IN_USE_CODE = 'PACKAGE_IN_USE';

export interface PackageUsage {
  packageName: string;
  /** The package's flows that something outside the package still uses, with only those places. */
  flows: FlowUsage[];
  /** The package's Connected Apps that something outside the package still uses, with only those places. */
  servers: McpServerUsage[];
  /** What leaves with the package, so it cannot be chosen to take over a place. */
  leaving: { flowIds: string[]; serverNames: string[] };
}

export interface PackageUninstallPlan {
  /** By flow id: one answer for each place outside the package. */
  flows: Record<string, DeletePlan>;
  /** By app name: one answer for each place outside the package. */
  servers: Record<string, DeletePlan>;
}

/** 409 answer while places outside the package still use what it would remove. */
export interface PackageInUseResponse {
  error: string;
  code: typeof PACKAGE_IN_USE_CODE;
  usage: PackageUsage;
  /** The places changed since the plan was made; the person should look again. */
  changed?: boolean;
}

const MAX_ENTRIES = 500;

function readPlans(value: unknown): Record<string, DeletePlan> | 'invalid' {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ENTRIES) return 'invalid';
  const plans: Record<string, DeletePlan> = {};
  for (const [id, plan] of entries) {
    const read = readDeletePlan(plan);
    if (read === 'invalid' || id.length > 600) return 'invalid';
    plans[id] = read;
  }
  return plans;
}

/** Read `{ plan: { flows, servers } }` from an untrusted request body; `null` when no plan was sent. */
export function parsePackageUninstallPlan(body: unknown): PackageUninstallPlan | null | 'invalid' {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const plan = (body as { plan?: unknown }).plan;
  if (plan === undefined || plan === null) return null;
  if (typeof plan !== 'object' || Array.isArray(plan)) return 'invalid';
  const flows = readPlans((plan as { flows?: unknown }).flows);
  const servers = readPlans((plan as { servers?: unknown }).servers);
  if (flows === 'invalid' || servers === 'invalid') return 'invalid';
  return { flows, servers };
}
