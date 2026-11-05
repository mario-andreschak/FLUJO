/**
 * Named access: scopes, role presets and the rules a credential must satisfy.
 *
 * Pure data with no Node imports, so the Settings page and the server read the
 * same definitions. Scopes stay exact: there is no wildcard and no implied scope.
 * A role is only a convenient name for a scope list; the list is what is enforced.
 */

/** The scopes that existed before named access. A schema 1 policy holds only these. */
export const LEGACY_OWNER_SCOPES = [
  'openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice',
] as const;

/** Narrow scopes used only by a schema 2 policy (named access switched on). */
export const NAMED_ACCESS_SCOPES = [
  'session:login', 'health:read', 'update:manage', 'flows:read', 'flows:write', 'models:read',
  'runs:read', 'runs:all', 'runs:manage', 'approvals:respond', 'access:manage', 'audit:read',
] as const;

export const OWNER_SCOPES = [...LEGACY_OWNER_SCOPES, ...NAMED_ACCESS_SCOPES] as const;
export type OwnerScope = typeof OWNER_SCOPES[number];

export const ACCESS_ROLES = ['admin', 'builder', 'operator', 'viewer', 'health', 'maintainer'] as const;
export type AccessRole = typeof ACCESS_ROLES[number];
export type AccessRoleOrCustom = AccessRole | 'custom';

export const ACCESS_ROLE_SCOPES: Readonly<Record<AccessRole, readonly OwnerScope[]>> = {
  /** Everything, including secrets, MCP setup and managing people. */
  admin: ['control:admin', 'secrets:read', 'mcp:access', 'openai:read', 'openai:execute',
    'session:login', 'access:manage', 'audit:read'],
  /** Edits and tests flows. Sees only the runs it started. No secrets, no MCP setup. */
  builder: ['flows:read', 'flows:write', 'models:read', 'openai:read', 'openai:execute',
    'runs:read', 'runs:manage', 'approvals:respond', 'session:login'],
  /** Runs flows and answers approvals. Sees only the runs it started. */
  operator: ['openai:read', 'openai:execute', 'runs:read', 'runs:manage', 'approvals:respond', 'session:login'],
  /** Reads flows and every run. Changes nothing. */
  viewer: ['flows:read', 'models:read', 'runs:read', 'runs:all', 'session:login'],
  /** Read-only health for a central operator. No conversation content, no browser login. */
  health: ['health:read'],
  /** Read-only health plus starting an update. */
  maintainer: ['health:read', 'update:manage'],
};

/**
 * A flow limit is only honest for scopes that stay inside a named flow. Reading or
 * editing flow definitions, seeing everybody's runs, and administration all reach
 * past one flow, so combining them with a limit is refused rather than half kept.
 */
export const FLOW_LIMITABLE_SCOPES: readonly OwnerScope[] = [
  'openai:read', 'openai:execute', 'runs:read', 'runs:manage', 'approvals:respond', 'session:login',
];

/** These reach the whole installation, so binding them to one workspace would be a false promise. */
export const INSTALLATION_WIDE_SCOPES: readonly OwnerScope[] = [
  'control:admin', 'secrets:read', 'mcp:access', 'update:manage',
];

/** A caller may pass this header (or `user` on /v1/chat/completions) to name its end user. */
export const ACCESS_END_USER_HEADER = 'x-flujo-end-user';
export const END_USER_REF_MAX_LENGTH = 128;
const END_USER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;

export type EndUserRefResult = { ok: true; value?: string } | { ok: false };

/** Absent is fine. Anything else must be a short plain reference, never free text. */
export function parseEndUserRef(value: unknown): EndUserRefResult {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'string' || value.length === 0 || value.length > END_USER_REF_MAX_LENGTH
    || !END_USER_REF_PATTERN.test(value)) return { ok: false };
  return { ok: true, value };
}

export function hasAdminPair(scopes: readonly string[]): boolean {
  return scopes.includes('control:admin') && scopes.includes('secrets:read');
}

/** Sees every person's conversations, runs and approvals. */
export function seesEveryRun(scopes: readonly string[]): boolean {
  return hasAdminPair(scopes) || scopes.includes('runs:all');
}

export interface NamedCredentialFields {
  readonly scopes: readonly OwnerScope[];
  readonly workspaceId?: string;
  readonly flowIds?: readonly string[];
  readonly role?: AccessRoleOrCustom;
}

/** Returns the reason a credential is not allowed, or null. Keeps a role honest at the source. */
export function namedCredentialProblem(credential: NamedCredentialFields): string | null {
  const { scopes, workspaceId, flowIds, role } = credential;
  if (role && role !== 'custom') {
    const preset = ACCESS_ROLE_SCOPES[role];
    if (preset.length !== scopes.length || preset.some(scope => !scopes.includes(scope))) {
      return 'The scopes do not match the named role. Use the custom role for a custom list.';
    }
  }
  if (workspaceId !== undefined && scopes.some(scope => INSTALLATION_WIDE_SCOPES.includes(scope))) {
    return 'Administration, secrets, MCP access and updates reach the whole installation and cannot be limited to one workspace.';
  }
  if (flowIds !== undefined) {
    if (workspaceId === undefined) return 'A flow limit needs a workspace, because flow ids are only unique inside one.';
    if (scopes.some(scope => !FLOW_LIMITABLE_SCOPES.includes(scope))) {
      return 'A flow limit can only be combined with running flows, reading own runs and answering own approvals.';
    }
  }
  if (scopes.includes('avatar:voice') && workspaceId === undefined) {
    return 'Voice access needs a workspace.';
  }
  return null;
}
