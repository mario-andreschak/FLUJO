/**
 * Shared MCP constants — framework-agnostic and dependency-light so they can be
 * imported from both the browser (e.g. flowValidation.ts) and the Node.js backend
 * (e.g. registry.ts) without pulling in server-only modules.
 */

export type MCPHostPathCapability = {
  /** Environment variables that form the non-bypassable outer root ceiling. */
  environmentRootVariables: string[];
  /** This package enforces FLUJO's protected-path policy before root checks. */
  protectedPaths: boolean;
  /** Files reached through this package are eligible for before/after snapshots. */
  snapshots: boolean;
};

export type MCPPackageCapabilities = {
  hostPathAccess?: MCPHostPathCapability;
  mcpApps?: boolean;
  resources?: boolean;
  flujoControlPlane?: boolean;
};

/**
 * Read and validate security-sensitive package capabilities. Invalid declarations
 * fail closed: callers receive no privileged capability rather than best-effort
 * coercion of malformed persisted data.
 */
export function packageCapabilitiesOf(value: unknown): MCPPackageCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as { packageCapabilities?: unknown }).packageCapabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Record<string, unknown>;
  const result: MCPPackageCapabilities = {};

  if (candidate.hostPathAccess !== undefined) {
    const host = candidate.hostPathAccess;
    if (!host || typeof host !== 'object' || Array.isArray(host)) return undefined;
    const record = host as Record<string, unknown>;
    if (
      !Array.isArray(record.environmentRootVariables) ||
      !record.environmentRootVariables.every((entry) => typeof entry === 'string' && entry.length > 0) ||
      typeof record.protectedPaths !== 'boolean' ||
      typeof record.snapshots !== 'boolean'
    ) return undefined;
    result.hostPathAccess = {
      environmentRootVariables: [...record.environmentRootVariables] as string[],
      protectedPaths: record.protectedPaths,
      snapshots: record.snapshots,
    };
  }

  for (const key of ['mcpApps', 'resources', 'flujoControlPlane'] as const) {
    if (candidate[key] !== undefined) {
      if (typeof candidate[key] !== 'boolean') return undefined;
      result[key] = candidate[key] as boolean;
    }
  }
  return result;
}

export function hostPathCapabilityOf(value: unknown): MCPHostPathCapability | undefined {
  return packageCapabilitiesOf(value)?.hostPathAccess;
}
