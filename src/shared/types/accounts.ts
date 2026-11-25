import { z } from 'zod';

/**
 * Multi-user accounts: the stored data format and the shared vocabulary (#573).
 *
 * The design lives in `docs/architecture/multi-user-plan.md` and the security
 * contracts (sign-in, sessions, API tokens, encryption keys) in
 * `docs/architecture/multi-user-contracts.md`. Multi-user mode is opt-in: none
 * of this is read while `<data>/accounts/accounts.json` is missing or says
 * `"enabled": false`.
 *
 * Everything here is pure data. Reading and writing the files is the job of
 * `src/backend/services/accounts/store.ts` (#574); the access rules are in
 * `src/backend/services/accounts/access.ts`.
 */

// ---------------------------------------------------------------------------
// Files under <data>/accounts/
// ---------------------------------------------------------------------------

export const ACCOUNTS_SCHEMA_VERSION = 1 as const;
/** Sits beside `workspaces/`, never inside it, so workspace backups and exports never include it. */
export const ACCOUNTS_DIRECTORY = 'accounts';
/** Mode switch, users, teams, workspace owners and API token digests. One atomic write changes them together. */
export const ACCOUNTS_FILE = 'accounts.json';
/** Last good copy of {@link ACCOUNTS_FILE}; read when the main file is broken. */
export const ACCOUNTS_BACKUP_FILE = 'accounts.json.bak';
/** Signed-in browser sessions (token digests only). Kept apart because it changes on every sign-in. */
export const SESSIONS_FILE = 'sessions.json';
/** One JSON object per line: sign-in, account, team and ownership changes. Never secrets. */
export const AUDIT_FILE = 'audit.jsonl';
/** When the audit file passes this size it moves to `audit.1.jsonl` (replacing the older one). Writing never fails because of size. */
export const AUDIT_ROTATE_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Roles, actions and route kinds
// ---------------------------------------------------------------------------

/** Role of a person in the whole installation. */
export const INSTALLATION_ROLES = ['admin', 'member'] as const;
export type InstallationRole = typeof INSTALLATION_ROLES[number];
/** A new person is a member without host access until an admin decides otherwise. */
export const DEFAULT_INSTALLATION_ROLE: InstallationRole = 'member';

/**
 * Role of a person inside one team (Tier 1, #575).
 *
 * - `owner`: everything in the team's workspaces, and manages the team.
 * - `member`: reads, edits and runs everything in the team's workspaces (the
 *   "editor" role); cannot reveal secrets or manage the workspace itself.
 * - `viewer`: only looks. Cannot change, run or reveal anything.
 */
export const TEAM_ROLES = ['owner', 'member', 'viewer'] as const;
export type TeamRole = typeof TEAM_ROLES[number];

/** Only `member` gives access. `invited` has not accepted yet; `removed` is kept for the record. */
export const TEAM_MEMBER_STATES = ['invited', 'member', 'removed'] as const;
export type TeamMemberState = typeof TEAM_MEMBER_STATES[number];

/**
 * What a person wants to do with a workspace.
 *
 * - `read`: look at flows, models, chats, runs and settings (secrets stay masked).
 * - `edit`: create, change or delete things inside the workspace.
 * - `run`: start chats, flows, schedules and tools. Background work asks for this.
 * - `admin`: manage the workspace itself: its encryption password, revealing
 *   stored secrets in plain text, credential transfer, whole-workspace backup and
 *   restore, renaming or deleting it, and changing its owner.
 */
export const WORKSPACE_ACTIONS = ['read', 'edit', 'run', 'admin'] as const;
export type WorkspaceAction = typeof WORKSPACE_ACTIONS[number];

/**
 * Every HTTP route has exactly one kind (see `routeCapabilities.ts`).
 *
 * - `workspace`: reads or changes data inside the selected workspace. Needs
 *   access to that workspace.
 * - `host`: runs programs, or reads or changes files on the server machine
 *   outside workspace data. Needs host access (and access to the selected
 *   workspace when it selects one).
 * - `admin`: reads or changes settings of the whole installation. Admins only.
 * - `account`: about the signed-in person themself: sign in, sign out, the list
 *   of their own workspaces. Sign-in itself works without a session.
 * - `protocol`: called by another program that brings its own proof (OAuth
 *   state, webhook signature, worker bearer, instance challenge). Not tied to a
 *   browser session; the route keeps its own check.
 */
export const ROUTE_KINDS = ['workspace', 'host', 'admin', 'account', 'protocol'] as const;
export type RouteKind = typeof ROUTE_KINDS[number];

/**
 * Scopes of a personal API token. The same names as the single-owner policy
 * (`OWNER_SCOPES` in `ownerCredentials.ts`), so owner tokens copy over to the
 * first admin unchanged when multi-user mode is turned on. A token never gives
 * more than its person may do; scopes only narrow it.
 */
export const ACCOUNT_TOKEN_SCOPES = [
  'openai:read', 'openai:execute', 'mcp:access', 'control:admin', 'secrets:read', 'avatar:voice',
] as const;
export type AccountTokenScope = typeof ACCOUNT_TOKEN_SCOPES[number];

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

export const USER_ID_PATTERN = /^u_[A-Za-z0-9_-]{16,64}$/;
export const TEAM_ID_PATTERN = /^t_[A-Za-z0-9_-]{16,64}$/;
/** Same rule as owner credential ids, so copied owner tokens keep their id. */
export const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Sign-in name: lower case, no spaces. Unique ignoring case. */
export const USER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Same rule as `WORKSPACE_NAME_PATTERN` in `src/utils/workspace.ts`. */
export const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** SHA-256 of a token, lower-case hex. The token itself is never stored. */
export const TOKEN_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
/** Personal API token. Same format as owner tokens, so copied ones keep working. */
export const API_TOKEN_PATTERN = /^flo_v1_[A-Za-z0-9_-]{43}$/;
/** Browser session token (the cookie value). Distinct prefix from owner sessions (`flo_s1_`). */
export const SESSION_TOKEN_PATTERN = /^flo_a1_[A-Za-z0-9_-]{43}$/;

/**
 * scrypt settings for new password hashes (OWASP Password Storage Cheat Sheet,
 * NIST SP 800-63B-4). N = 2^logN. Needs about 128 MiB per hash, so callers pass
 * `maxmem` of at least {@link SCRYPT_MAXMEM_BYTES}.
 */
export const SCRYPT_PARAMETERS = Object.freeze({ logN: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
export const SCRYPT_MAXMEM_BYTES = 256 * 1024 * 1024;
/**
 * `scrypt-v1$<logN>$<r>$<p>$<salt base64url>$<hash base64url>`. Older or weaker
 * settings still verify; the next successful sign-in stores a new hash with
 * {@link SCRYPT_PARAMETERS}.
 */
export const PASSWORD_HASH_PATTERN = /^scrypt-v1\$(1[4-9]|2[0-2])\$([1-9][0-9]?)\$([1-9][0-9]?)\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
export const PASSWORD_MIN_LENGTH = 15;
/** Upper bound keeps one hash cheap enough; NIST asks to allow at least 64. */
export const PASSWORD_MAX_LENGTH = 256;

/** Browser sessions end after this time, at logout, password change or when the person is disabled. */
export const ACCOUNT_SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
/** Cookie over HTTPS. `__Host-` makes the browser refuse it without Secure, Path=/ and no Domain. */
export const ACCOUNT_SESSION_COOKIE_HTTPS = '__Host-flujo-session';
/** Cookie over plain HTTP on this computer or a local network. */
export const ACCOUNT_SESSION_COOKIE_HTTP = 'flujo-session';

/** Wait after a failed sign-in: doubles per failure for that name, never more than the maximum. Clears on success or restart. */
export const SIGN_IN_DELAY_FIRST_MS = 1000;
export const SIGN_IN_DELAY_MAX_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const userId = z.string().regex(USER_ID_PATTERN);
const teamId = z.string().regex(TEAM_ID_PATTERN);
const displayName = z.string().trim().min(1).max(100);
export const workspaceNameSchema = z.string().regex(WORKSPACE_NAME_PATTERN)
  .refine(value => !WINDOWS_RESERVED_NAME.test(value), 'Reserved workspace name');

/**
 * A person. Never deleted, only disabled, so ownership and the audit trail keep
 * pointing at someone. `generation` goes up when the password changes or the
 * person is disabled; sessions made under an older generation stop working.
 */
export const accountUserSchema = z.object({
  id: userId,
  name: z.string().regex(USER_NAME_PATTERN),
  displayName,
  passwordHash: z.string().regex(PASSWORD_HASH_PATTERN),
  role: z.enum(INSTALLATION_ROLES),
  /** Admins always have host access; for members an admin may turn it on. */
  hostAccess: z.boolean(),
  disabled: z.boolean(),
  generation,
  createdAt: timestamp,
}).strict();
export type AccountUser = z.infer<typeof accountUserSchema>;

export const teamMemberSchema = z.object({
  userId,
  role: z.enum(TEAM_ROLES),
  state: z.enum(TEAM_MEMBER_STATES),
}).strict();
export type TeamMember = z.infer<typeof teamMemberSchema>;

/**
 * A team (Tier 1, #575). `generation` goes up when a member is removed or a
 * member's role changes, which cuts off that team's edit leases.
 */
export const accountTeamSchema = z.object({
  id: teamId,
  name: displayName,
  generation,
  members: z.array(teamMemberSchema).max(10_000),
  createdAt: timestamp,
}).strict().superRefine((team, context) => {
  if (new Set(team.members.map(member => member.userId)).size !== team.members.length) {
    context.addIssue({ code: 'custom', message: 'A person is listed twice in one team' });
  }
});
export type AccountTeam = z.infer<typeof accountTeamSchema>;

/** Who owns a workspace. A workspace without a record is "unassigned": admins only. */
export const workspaceOwnerSchema = z.discriminatedUnion('ownerType', [
  z.object({ ownerType: z.literal('user'), ownerId: userId, assignedAt: timestamp }).strict(),
  z.object({ ownerType: z.literal('team'), ownerId: teamId, assignedAt: timestamp }).strict(),
]);
export type WorkspaceOwner = z.infer<typeof workspaceOwnerSchema>;

/**
 * A personal API token for scripts, `/v1` and MCP clients. Only the SHA-256
 * digest is stored. Same fields as an owner credential plus the person it
 * belongs to, so owner tokens copy over unchanged.
 */
export const accountApiTokenSchema = z.object({
  id: z.string().regex(TOKEN_ID_PATTERN),
  userId,
  label: z.string().trim().min(1).max(100).optional(),
  digest: z.string().regex(TOKEN_DIGEST_PATTERN),
  scopes: z.array(z.enum(ACCOUNT_TOKEN_SCOPES)).min(1).max(ACCOUNT_TOKEN_SCOPES.length)
    .refine(value => new Set(value).size === value.length, 'Duplicate scope'),
  issuedAt: timestamp,
  expiresAt: timestamp,
  revokedAt: timestamp.nullable(),
  /** Limits the token to one workspace (for example a paired voice device). */
  workspaceId: workspaceNameSchema.optional(),
}).strict().refine(value => value.expiresAt > value.issuedAt, 'A token must expire after it was issued');
export type AccountApiToken = z.infer<typeof accountApiTokenSchema>;

/**
 * `<data>/accounts/accounts.json`.
 *
 * `revision` goes up by one on every write; the store refuses a write based on
 * an older revision (compare-and-swap inside its write queue), so two admin
 * pages cannot overwrite each other silently.
 */
export const accountsFileSchema = z.object({
  schemaVersion: z.literal(ACCOUNTS_SCHEMA_VERSION),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  users: z.array(accountUserSchema).max(10_000),
  teams: z.array(accountTeamSchema).max(10_000),
  workspaces: z.record(workspaceNameSchema, workspaceOwnerSchema),
  apiTokens: z.array(accountApiTokenSchema).max(100_000),
}).strict().superRefine((file, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message });
  const userIds = new Set(file.users.map(user => user.id));
  const teamIds = new Set(file.teams.map(team => team.id));
  if (userIds.size !== file.users.length) issue('Duplicate user id');
  if (new Set(file.users.map(user => user.name.toLowerCase())).size !== file.users.length) issue('Duplicate user name');
  if (teamIds.size !== file.teams.length) issue('Duplicate team id');
  if (new Set(file.teams.map(team => team.name.toLowerCase())).size !== file.teams.length) issue('Duplicate team name');
  if (new Set(file.apiTokens.map(token => token.id)).size !== file.apiTokens.length) issue('Duplicate token id');
  if (new Set(file.apiTokens.map(token => token.digest)).size !== file.apiTokens.length) issue('Duplicate token digest');
  for (const team of file.teams) {
    if (team.members.some(member => !userIds.has(member.userId))) issue(`Team ${team.id} lists an unknown person`);
  }
  for (const token of file.apiTokens) {
    if (!userIds.has(token.userId)) issue(`Token ${token.id} belongs to an unknown person`);
  }
  const workspaceNames = Object.keys(file.workspaces);
  if (new Set(workspaceNames.map(name => name.toLowerCase())).size !== workspaceNames.length) {
    issue('Two workspace owner records differ only by upper and lower case');
  }
  for (const [workspace, owner] of Object.entries(file.workspaces)) {
    const known = owner.ownerType === 'user' ? userIds.has(owner.ownerId) : teamIds.has(owner.ownerId);
    if (!known) issue(`Workspace ${workspace} has an unknown owner`);
  }
  // Nobody could manage the installation any more. Recovery is the server CLI.
  if (file.enabled && !file.users.some(user => user.role === 'admin' && !user.disabled)) {
    issue('Multi-user mode needs at least one active admin');
  }
});
export type AccountsFile = z.infer<typeof accountsFileSchema>;

/** One signed-in browser session. The cookie holds the token; only its digest is stored. */
export const accountSessionSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  digest: z.string().regex(TOKEN_DIGEST_PATTERN),
  userId,
  /** The person's generation at sign-in. A different current generation ends the session. */
  userGeneration: generation,
  issuedAt: timestamp,
  expiresAt: timestamp,
}).strict().refine(value => value.expiresAt > value.issuedAt
  && value.expiresAt - value.issuedAt <= ACCOUNT_SESSION_MAX_AGE_MS, 'Session lifetime is out of range');
export type AccountSession = z.infer<typeof accountSessionSchema>;

/** `<data>/accounts/sessions.json`. Expired sessions are dropped on the next write. */
export const sessionsFileSchema = z.object({
  schemaVersion: z.literal(ACCOUNTS_SCHEMA_VERSION),
  sessions: z.array(accountSessionSchema).max(100_000),
}).strict().superRefine((file, context) => {
  if (new Set(file.sessions.map(session => session.digest)).size !== file.sessions.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate session digest' });
  }
});
export type SessionsFile = z.infer<typeof sessionsFileSchema>;

export const AUDIT_ACTIONS = [
  'mode-enabled', 'mode-disabled',
  'sign-in', 'sign-in-failed', 'sign-out',
  'user-added', 'user-changed', 'user-disabled', 'user-enabled', 'password-changed',
  'token-issued', 'token-revoked',
  'team-created', 'team-changed', 'team-deleted', 'member-added', 'member-changed', 'member-removed',
  'workspace-owner-changed',
  /** Something was copied from one workspace into another (#575). Never with the secret values. */
  'item-copied',
] as const;
export type AuditAction = typeof AUDIT_ACTIONS[number];

/** One line of `audit.jsonl`. Details are short facts, never passwords, tokens or secrets. */
export const auditEventSchema = z.object({
  at: timestamp,
  action: z.enum(AUDIT_ACTIONS),
  /** Who did it; `null` for the server command line or FLUJO itself. */
  actorUserId: userId.nullable(),
  target: z.object({
    type: z.enum(['installation', 'user', 'team', 'workspace', 'token', 'session']),
    id: z.string().min(1).max(128),
  }).strict().optional(),
  detail: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
}).strict();
export type AuditEvent = z.infer<typeof auditEventSchema>;

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * A signed-in person, resolved once per request from the session cookie or an
 * API token and carried next to the workspace in AsyncLocalStorage (#574). It
 * is never built from anything the browser claims (query, header, body).
 */
export type AccountPrincipal =
  | {
    readonly kind: 'session';
    readonly userId: string;
    readonly sessionId: string;
    /** The person's generation when the session was made. */
    readonly generation: number;
  }
  | {
    readonly kind: 'api-token';
    readonly userId: string;
    readonly tokenId: string;
    readonly scopes: readonly AccountTokenScope[];
    /** Set when the token is limited to one workspace. */
    readonly workspaceId?: string;
  };

/**
 * Scheduled runs, triggers, personas and waves have no signed-in person. They
 * act with the authority of the workspace owner and remember who started them
 * for the audit trail.
 */
export interface BackgroundActor {
  readonly kind: 'background';
  /** The person who set the work up, when known. */
  readonly startedBy?: string;
}

/** True only for a parsed file that turns multi-user mode on. A missing file means off. */
export function isMultiUserEnabled(file: Pick<AccountsFile, 'enabled'> | null | undefined): boolean {
  return file?.enabled === true;
}
