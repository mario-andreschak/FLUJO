import {
  WORKSPACE_ACTIONS, isMultiUserEnabled,
  type AccountPrincipal, type AccountTokenScope, type AccountUser, type AccountsFile, type BackgroundActor,
  type RouteKind, type WorkspaceAction, type WorkspaceOwner,
} from '@/shared/types/accounts';

/**
 * Access rules for multi-user mode (#573). Pure functions: they read only the
 * arguments, never files, clocks or request data. The caller (#574) passes
 * the parsed `accounts.json` (or `null` when the file does not exist), the
 * principal it resolved from the session cookie or API token, and `now`.
 *
 * With multi-user mode off (no file, or `"enabled": false`) every decision is
 * "allowed", so a single-user install behaves exactly as before.
 *
 * Unknown and forbidden workspaces get the same answer (`not-found`, HTTP 404),
 * so guessing workspace names reveals nothing.
 */

export type AccessGrant =
  /** Multi-user mode is off: today's single-user behaviour. */
  | 'multi-user-off'
  /** Admins may use every workspace and every route. */
  | 'installation-admin'
  /** The person owns this workspace. */
  | 'personal-owner'
  /** The person is an owner of the team that owns this workspace. */
  | 'team-owner'
  /** The person is a member (editor) of the team that owns this workspace. */
  | 'team-member'
  /** The person is a viewer in the team that owns this workspace: read only (#575). */
  | 'team-viewer'
  /** Any signed-in person (account routes such as the own workspace list). */
  | 'signed-in'
  /** A host route that selects no workspace, for a person with host access. */
  | 'host-access'
  /** The route checks its caller itself (sign-in, OAuth callbacks, webhooks, workers). */
  | 'own-check';

export type AccessDenial =
  /** No principal, or it is no longer valid (disabled person, old session, revoked or expired token). */
  | 'sign-in-required'
  /** The workspace does not exist or this person may not see it. Same answer for both. */
  | 'not-found'
  /** The person can see the workspace but this action needs the workspace `admin` action. */
  | 'workspace-admin-required'
  /** The person is a viewer in the team that owns this workspace: they may look, not change or run (#575). */
  | 'view-only'
  /** The route runs programs or touches files on the server machine. */
  | 'host-access-required'
  /** The route changes the whole installation. */
  | 'admin-required'
  /** The API token lacks a scope this route needs, or is limited to one workspace. */
  | 'token-scope-missing'
  /** Background work: the workspace has no active owner, so it waits until one is assigned or re-enabled. */
  | 'owner-inactive'
  /** Background work: the person who set it up lost access, so it stops after its current step. */
  | 'starter-lost-access';

export const ACCESS_DENIAL_STATUS: Readonly<Record<AccessDenial, 401 | 403 | 404>> = Object.freeze({
  'sign-in-required': 401,
  'not-found': 404,
  'workspace-admin-required': 403,
  'view-only': 403,
  'host-access-required': 403,
  'admin-required': 403,
  'token-scope-missing': 403,
  'owner-inactive': 403,
  'starter-lost-access': 403,
});

export type AccessDecision =
  | { readonly allowed: true; readonly grant: AccessGrant }
  | { readonly allowed: false; readonly denial: AccessDenial; readonly status: 401 | 403 | 404 };

const ALL_ACTIONS: readonly WorkspaceAction[] = Object.freeze([...WORKSPACE_ACTIONS]);
const MEMBER_ACTIONS: readonly WorkspaceAction[] = Object.freeze(['read', 'edit', 'run']);
const VIEWER_ACTIONS: readonly WorkspaceAction[] = Object.freeze(['read']);

/** The ways a person can reach a workspace. */
export type WorkspaceGrant = 'installation-admin' | 'personal-owner' | 'team-owner' | 'team-member' | 'team-viewer';

/**
 * What each kind of access may do in a workspace. Team members can use
 * everything in the workspace, including its secrets in runs, but they cannot
 * see secrets in plain text, change the workspace password, back it up,
 * restore it, transfer credentials, rename or delete it. Team viewers only
 * look: they cannot change or run anything (#575).
 */
export const WORKSPACE_GRANT_ACTIONS: Readonly<Record<WorkspaceGrant, readonly WorkspaceAction[]>> = Object.freeze({
  'installation-admin': ALL_ACTIONS,
  'personal-owner': ALL_ACTIONS,
  'team-owner': ALL_ACTIONS,
  'team-member': MEMBER_ACTIONS,
  'team-viewer': VIEWER_ACTIONS,
});

/** Showing a stored secret in plain text (for example `/api/env?includeSecrets=true`). */
export const REVEAL_SECRETS_ACTION: WorkspaceAction = 'admin';

const allow = (grant: AccessGrant): AccessDecision => ({ allowed: true, grant });
const deny = (denial: AccessDenial): AccessDecision => ({
  allowed: false, denial, status: ACCESS_DENIAL_STATUS[denial],
});

/** GET, HEAD and OPTIONS read; every other method edits. Route overrides live in `routeCapabilities.ts`. */
export function workspaceActionForMethod(method: string): WorkspaceAction {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'read' : 'edit';
}

/** Admins always have host access; members only when an admin turned it on. */
export function hasHostAccess(user: Pick<AccountUser, 'role' | 'hostAccess' | 'disabled'>): boolean {
  return !user.disabled && (user.role === 'admin' || user.hostAccess);
}

/**
 * The person behind a principal, or `null` when the principal no longer counts:
 * unknown or disabled person, a session from an older generation (password
 * changed, person disabled and enabled again), or a revoked, expired or
 * reassigned API token.
 */
export function activeUser(accounts: AccountsFile, principal: AccountPrincipal | null | undefined,
  now: number): AccountUser | null {
  if (!principal || !Number.isSafeInteger(now) || now < 0) return null;
  const user = accounts.users.find(candidate => candidate.id === principal.userId);
  if (!user || user.disabled) return null;
  if (principal.kind === 'session') return principal.generation === user.generation ? user : null;
  const token = accounts.apiTokens.find(candidate => candidate.id === principal.tokenId);
  if (!token || token.userId !== user.id || token.revokedAt !== null
      || token.issuedAt > now || token.expiresAt <= now
      || token.workspaceId !== principal.workspaceId) return null;
  return user;
}

function teamGrant(accounts: AccountsFile, user: AccountUser, teamId: string): 'team-owner' | 'team-member' | 'team-viewer' | null {
  const team = accounts.teams.find(candidate => candidate.id === teamId);
  const membership = team?.members.find(member => member.userId === user.id && member.state === 'member');
  if (!membership) return null;
  if (membership.role === 'owner') return 'team-owner';
  return membership.role === 'viewer' ? 'team-viewer' : 'team-member';
}

/**
 * How a person may use a workspace, ignoring token limits. `null` means no
 * access. A workspace without an owner record ("unassigned") is for admins only.
 * Workspace names are compared exactly; the caller passes the name as it is on
 * disk.
 */
export function workspaceGrant(accounts: AccountsFile, user: AccountUser, workspace: string): WorkspaceGrant | null {
  if (user.disabled) return null;
  if (user.role === 'admin') return 'installation-admin';
  const owner: WorkspaceOwner | undefined = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace)
    ? accounts.workspaces[workspace] : undefined;
  if (!owner) return null;
  if (owner.ownerType === 'user') return owner.ownerId === user.id ? 'personal-owner' : null;
  return teamGrant(accounts, user, owner.ownerId);
}

/** The actions a person may take in a workspace (empty when none). */
export function workspaceActions(accounts: AccountsFile, user: AccountUser, workspace: string): readonly WorkspaceAction[] {
  const grant = workspaceGrant(accounts, user, workspace);
  return grant ? WORKSPACE_GRANT_ACTIONS[grant] : [];
}

function tokenScopesAllow(principal: AccountPrincipal, required: readonly AccountTokenScope[]): boolean {
  return principal.kind === 'session' || required.every(scope => principal.scopes.includes(scope));
}

function decideForUser(accounts: AccountsFile, principal: AccountPrincipal, user: AccountUser,
  workspace: string, action: WorkspaceAction): AccessDecision {
  if (principal.kind === 'api-token' && principal.workspaceId !== undefined && principal.workspaceId !== workspace) {
    return deny('not-found');
  }
  const grant = workspaceGrant(accounts, user, workspace);
  if (!grant) return deny('not-found');
  if (WORKSPACE_GRANT_ACTIONS[grant].includes(action)) return allow(grant);
  return deny(action !== 'admin' && grant === 'team-viewer' ? 'view-only' : 'workspace-admin-required');
}

/** May this principal take this action in this workspace? */
export function decideWorkspaceAccess(accounts: AccountsFile | null, principal: AccountPrincipal | null | undefined,
  workspace: string, action: WorkspaceAction, now: number): AccessDecision {
  if (!accounts || !isMultiUserEnabled(accounts)) return allow('multi-user-off');
  const user = activeUser(accounts, principal, now);
  if (!user || !principal) return deny('sign-in-required');
  return decideForUser(accounts, principal, user, workspace, action);
}

export interface RouteAccessRequest {
  /** From `routeCapabilityFor`; `undefined` for a route that is not classified (treated as `admin`). */
  readonly kind: RouteKind | undefined;
  /** The selected workspace, for `workspace` and `host` routes. */
  readonly workspace: string | null;
  /** From `routeCapabilityFor`: {@link workspaceActionForMethod}, raised to `admin` for workspace-admin routes. */
  readonly workspaceAction: WorkspaceAction;
  /** Account routes that must work while signed out (the sign-in routes themselves). */
  readonly signedOutAllowed?: boolean;
  /** Scopes an API token needs for this request (today's `requiredOwnerScopes`). Sessions have all scopes. */
  readonly requiredScopes?: readonly AccountTokenScope[];
}

/**
 * May this principal call this route? Order matters: the workspace is checked
 * before host access, so a person without access to a workspace learns only
 * "not found", never "you lack host access there".
 */
export function decideRouteAccess(accounts: AccountsFile | null, principal: AccountPrincipal | null | undefined,
  route: RouteAccessRequest, now: number): AccessDecision {
  if (!accounts || !isMultiUserEnabled(accounts)) return allow('multi-user-off');
  const kind: RouteKind = route.kind ?? 'admin';
  if (kind === 'protocol') return allow('own-check');
  const user = activeUser(accounts, principal, now);
  if (!user || !principal) return kind === 'account' && route.signedOutAllowed ? allow('own-check') : deny('sign-in-required');
  if (!tokenScopesAllow(principal, route.requiredScopes ?? [])) return deny('token-scope-missing');
  const limitedToken = principal.kind === 'api-token' && principal.workspaceId !== undefined;
  switch (kind) {
    case 'account':
      return limitedToken ? deny('token-scope-missing') : allow('signed-in');
    case 'admin':
      if (limitedToken) return deny('token-scope-missing');
      return user.role === 'admin' ? allow('installation-admin') : deny('admin-required');
    case 'workspace':
    case 'host': {
      if (route.workspace === null) {
        if (limitedToken) return deny('token-scope-missing');
        if (kind === 'workspace') return deny('not-found');
        return hasHostAccess(user) ? allow('host-access') : deny('host-access-required');
      }
      const decision = decideForUser(accounts, principal, user, route.workspace, route.workspaceAction);
      if (!decision.allowed || kind === 'workspace') return decision;
      return hasHostAccess(user) ? decision : deny('host-access-required');
    }
  }
}

export interface WorkspaceListEntry {
  readonly workspace: string;
  readonly grant: WorkspaceGrant;
  /** Whether the workspace has an owner record. Unassigned ones show on the admin page. */
  readonly assigned: boolean;
}

/**
 * The workspaces a principal may see, in the given order. Admins get every
 * workspace with grant `installation-admin` for the ones they do not own
 * themselves, so the page can group them separately. Mode off: every workspace.
 */
export function listAccessibleWorkspaces(accounts: AccountsFile | null, principal: AccountPrincipal | null | undefined,
  workspaces: readonly string[], now: number): readonly WorkspaceListEntry[] | 'multi-user-off' | 'sign-in-required' {
  if (!accounts || !isMultiUserEnabled(accounts)) return 'multi-user-off';
  const user = activeUser(accounts, principal, now);
  if (!user || !principal) return 'sign-in-required';
  const entries: WorkspaceListEntry[] = [];
  for (const workspace of workspaces) {
    if (principal.kind === 'api-token' && principal.workspaceId !== undefined && principal.workspaceId !== workspace) continue;
    const owner = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace) ? accounts.workspaces[workspace] : undefined;
    const ownGrant = owner && (owner.ownerType === 'user'
      ? (owner.ownerId === user.id ? 'personal-owner' as const : null)
      : teamGrant(accounts, user, owner.ownerId));
    const grant = ownGrant ?? workspaceGrant(accounts, user, workspace);
    if (grant) entries.push({ workspace, grant, assigned: owner !== undefined });
  }
  return entries;
}

function activeMember(accounts: AccountsFile, userId: string): boolean {
  return accounts.users.some(user => user.id === userId && !user.disabled);
}

/**
 * May background work (schedules, triggers, personas, waves) run in this
 * workspace now? It acts for the workspace owner: the grant is
 * `personal-owner` for a personal workspace and `team-owner` (acting for the
 * team) for a team workspace. A denial is a pause, not a failure: the caller
 * retries on its next tick and the work resumes by itself once an owner is
 * active again or the workspace is assigned.
 */
export function decideBackgroundAccess(accounts: AccountsFile | null, workspace: string, actor: BackgroundActor,
  now: number): AccessDecision {
  if (!accounts || !isMultiUserEnabled(accounts)) return allow('multi-user-off');
  if (!Number.isSafeInteger(now) || now < 0) return deny('owner-inactive');
  const owner = Object.prototype.hasOwnProperty.call(accounts.workspaces, workspace) ? accounts.workspaces[workspace] : undefined;
  if (!owner) return deny('owner-inactive');
  let grant: AccessGrant;
  if (owner.ownerType === 'user') {
    if (!activeMember(accounts, owner.ownerId)) return deny('owner-inactive');
    grant = 'personal-owner';
  } else {
    // A team acts while someone who may run things in it is active; viewers alone do not count.
    const team = accounts.teams.find(candidate => candidate.id === owner.ownerId);
    if (!team || !team.members.some(member => member.state === 'member' && member.role !== 'viewer'
      && activeMember(accounts, member.userId))) {
      return deny('owner-inactive');
    }
    grant = 'team-owner';
  }
  if (actor.startedBy !== undefined) {
    const starter = accounts.users.find(user => user.id === actor.startedBy);
    if (!starter || !workspaceActions(accounts, starter, workspace).includes('run')) return deny('starter-lost-access');
  }
  return allow(grant);
}

/** Adding, disabling and changing people, and turning the mode off, are admin work. */
export function mayManageAccounts(user: AccountUser): boolean {
  return !user.disabled && user.role === 'admin';
}

/** Admins and the team's owners manage its members (Tier 1, #575). */
export function mayManageTeam(accounts: AccountsFile, user: AccountUser, teamId: string): boolean {
  if (user.disabled) return false;
  return user.role === 'admin' || teamGrant(accounts, user, teamId) === 'team-owner';
}

/**
 * May this person create a workspace owned by `owner`? Everyone may create
 * their own; team workspaces need a team owner or an admin.
 */
export function mayCreateWorkspaceFor(accounts: AccountsFile, user: AccountUser,
  owner: Pick<WorkspaceOwner, 'ownerType' | 'ownerId'>): boolean {
  if (user.disabled) return false;
  if (owner.ownerType === 'user') return owner.ownerId === user.id || user.role === 'admin';
  return accounts.teams.some(team => team.id === owner.ownerId) && mayManageTeam(accounts, user, owner.ownerId);
}

/**
 * May this person give a workspace to a new owner? They need the workspace
 * `admin` action and must be allowed to create a workspace for the new owner.
 * Admins may assign unassigned workspaces to anyone.
 */
export function mayTransferWorkspace(accounts: AccountsFile, user: AccountUser, workspace: string,
  next: Pick<WorkspaceOwner, 'ownerType' | 'ownerId'>): boolean {
  if (!workspaceActions(accounts, user, workspace).includes('admin')) return false;
  if (user.role === 'admin') {
    return next.ownerType === 'user'
      ? accounts.users.some(candidate => candidate.id === next.ownerId)
      : accounts.teams.some(team => team.id === next.ownerId);
  }
  return mayCreateWorkspaceFor(accounts, user, next);
}
