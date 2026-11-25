import { randomBytes } from 'node:crypto';
import { ZodError } from 'zod';
import {
  ACCOUNTS_SCHEMA_VERSION, ACCOUNT_TOKEN_SCOPES, INSTALLATION_ROLES, USER_NAME_PATTERN, WORKSPACE_NAME_PATTERN,
  type AccountApiToken, type AccountTokenScope, type AccountUser, type AccountsFile, type InstallationRole,
} from '@/shared/types/accounts';
import { createLogger } from '@/utils/logger';
import type { OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { mayManageAccounts, mayTransferWorkspace } from './access';
import { hashPassword, passwordProblem } from './passwords';
import { appendAudit, loadAccountsState, mutateAccounts } from './store';
import { endAllSessions, endSessionsForUser } from './sessions';
import { DEFAULT_TOKEN_LIFETIME_MS, issueAccountToken, ownerTokensFor } from './tokens';

const log = createLogger('backend/services/accounts/admin');

/**
 * What admins (and the server command line) can change about accounts (#574):
 * turning multi-user mode on and off, people, workspace owners and API tokens.
 * Every change is one atomic write of `accounts.json` plus one audit line.
 */

export class AccountInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AccountInputError';
    this.status = status;
  }
}

/** A person as the admin page shows them: never the password hash. */
export interface PublicUser {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly role: InstallationRole;
  readonly hostAccess: boolean;
  readonly disabled: boolean;
  readonly createdAt: number;
}

export function publicUser(user: AccountUser): PublicUser {
  return {
    id: user.id, name: user.name, displayName: user.displayName, role: user.role,
    hostAccess: user.role === 'admin' || user.hostAccess, disabled: user.disabled, createdAt: user.createdAt,
  };
}

/** A token as its person sees it: never the digest. */
export interface PublicToken {
  readonly id: string;
  readonly label?: string;
  readonly scopes: readonly AccountTokenScope[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly workspaceId?: string;
}

export function publicToken(token: AccountApiToken): PublicToken {
  return {
    id: token.id, ...(token.label ? { label: token.label } : {}), scopes: token.scopes, issuedAt: token.issuedAt,
    expiresAt: token.expiresAt, revokedAt: token.revokedAt, ...(token.workspaceId ? { workspaceId: token.workspaceId } : {}),
  };
}

function newUserId(): string {
  return `u_${randomBytes(12).toString('base64url')}`;
}

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!USER_NAME_PATTERN.test(name)) {
    throw new AccountInputError('Use a sign-in name of 1 to 64 lower-case letters, digits, dots, dashes or underscores, starting with a letter or digit.');
  }
  return name;
}

function cleanDisplayName(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > 100) throw new AccountInputError('Use a display name of at most 100 characters.');
  return text || fallback;
}

function checkPassword(password: unknown, names: readonly string[]): string {
  const problem = passwordProblem(typeof password === 'string' ? password : '', names);
  if (problem) throw new AccountInputError(problem);
  return password as string;
}

/** Turn a schema refusal (for example "no active admin left") into a plain answer. */
async function write(change: (current: AccountsFile | null) => AccountsFile | Promise<AccountsFile>,
  expectedRevision?: number): Promise<AccountsFile> {
  try {
    return await mutateAccounts(change, expectedRevision === undefined ? {} : { expectedRevision });
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0]?.message ?? 'The change is not valid.';
      throw new AccountInputError(/active admin/.test(issue)
        ? 'There must always be at least one active admin.' : issue);
    }
    throw error;
  }
}

async function enabledAccounts(): Promise<AccountsFile> {
  const state = await loadAccountsState();
  if (state.mode !== 'on') throw new AccountInputError('Multi-user mode is off.', 409);
  return state.accounts;
}

export interface EnableInput {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
}

export interface EnableContext {
  /** Every workspace that exists now; each one without an owner goes to the first admin. */
  readonly workspaces: readonly string[];
  /** Owner policy tokens to copy to the first admin, so scripts keep working. */
  readonly ownerPolicy?: OwnerPolicy | null;
  readonly actorUserId?: string | null;
  readonly now?: number;
}

/**
 * Turn multi-user mode on. The first time, this creates the first admin, gives
 * them every existing workspace and copies the owner policy tokens. When
 * people already exist (the mode was on before), it only switches it on again
 * and the name and password are not needed.
 */
export async function enableMultiUser(input: EnableInput, context: EnableContext):
  Promise<{ accounts: AccountsFile; createdAdmin: AccountUser | null }> {
  const now = context.now ?? Date.now();
  const before = await loadAccountsState();
  if (before.mode === 'on') return { accounts: before.accounts, createdAdmin: null };
  const reuse = before.accounts?.users.some(user => user.role === 'admin' && !user.disabled) === true;
  let admin: AccountUser | null = null;
  if (!reuse) {
    const name = cleanName(input.name);
    const displayName = cleanDisplayName(input.displayName, name);
    const passwordHash = await hashPassword(checkPassword(input.password, [name, displayName]));
    admin = {
      id: newUserId(), name, displayName, passwordHash, role: 'admin', hostAccess: true, disabled: false,
      generation: 1, createdAt: now,
    };
  }
  const next = await write(current => {
    const file: AccountsFile = current ?? {
      schemaVersion: ACCOUNTS_SCHEMA_VERSION, enabled: true, revision: 0, users: [], teams: [], workspaces: {}, apiTokens: [],
    };
    file.enabled = true;
    if (admin) {
      if (file.users.some(user => user.name === admin!.name)) throw new AccountInputError('That sign-in name is already taken.', 409);
      file.users.push(admin);
      const firstAdmin = admin;
      for (const workspace of context.workspaces) {
        if (WORKSPACE_NAME_PATTERN.test(workspace) && !Object.prototype.hasOwnProperty.call(file.workspaces, workspace)) {
          file.workspaces[workspace] = { ownerType: 'user', ownerId: firstAdmin.id, assignedAt: now };
        }
      }
      const known = new Set(file.apiTokens.flatMap(token => [token.id, token.digest]));
      for (const token of context.ownerPolicy ? ownerTokensFor(context.ownerPolicy, firstAdmin.id) : []) {
        if (!known.has(token.id) && !known.has(token.digest)) file.apiTokens.push(token);
      }
    }
    return file;
  });
  const actor = context.actorUserId ?? null;
  if (admin) await appendAudit({ action: 'user-added', actorUserId: actor, target: { type: 'user', id: admin.id }, detail: { role: 'admin' } });
  await appendAudit({ action: 'mode-enabled', actorUserId: actor ?? admin?.id ?? null, target: { type: 'installation', id: 'accounts' } });
  log.info('Multi-user mode was turned on.');
  return { accounts: next, createdAdmin: admin };
}

/** Turn multi-user mode off. Nothing moves; everyone is signed out; the records stay for next time. */
export async function disableMultiUser(actorUserId: string | null): Promise<void> {
  const state = await loadAccountsState();
  if (state.mode !== 'on') return;
  await write(current => ({ ...current!, enabled: false }));
  await endAllSessions();
  await appendAudit({ action: 'mode-disabled', actorUserId, target: { type: 'installation', id: 'accounts' } });
  log.info('Multi-user mode was turned off; FLUJO is a single-user installation again.');
}

export interface AddUserInput {
  readonly name?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
  readonly role?: unknown;
  readonly hostAccess?: unknown;
}

export async function addUser(input: AddUserInput, actorUserId: string | null, now = Date.now()): Promise<PublicUser> {
  await enabledAccounts();
  const name = cleanName(input.name);
  const displayName = cleanDisplayName(input.displayName, name);
  const role: InstallationRole = INSTALLATION_ROLES.includes(input.role as InstallationRole) ? input.role as InstallationRole : 'member';
  const passwordHash = await hashPassword(checkPassword(input.password, [name, displayName]));
  const user: AccountUser = {
    id: newUserId(), name, displayName, passwordHash, role, hostAccess: role === 'admin' || input.hostAccess === true,
    disabled: false, generation: 1, createdAt: now,
  };
  await write(current => {
    if (current!.users.some(existing => existing.name === name)) throw new AccountInputError('That sign-in name is already taken.', 409);
    return { ...current!, users: [...current!.users, user] };
  });
  await appendAudit({ action: 'user-added', actorUserId, target: { type: 'user', id: user.id }, detail: { role } });
  return publicUser(user);
}

export interface UserChange {
  readonly disabled?: unknown;
  readonly role?: unknown;
  readonly hostAccess?: unknown;
  readonly displayName?: unknown;
  readonly password?: unknown;
}

/**
 * Change one person. Disabling or a new password raises their generation,
 * which ends their sessions at once; enabling again lets them sign in anew.
 */
export async function changeUser(userId: string, change: UserChange, actorUserId: string | null,
  expectedRevision?: number): Promise<PublicUser> {
  const accounts = await enabledAccounts();
  const existing = accounts.users.find(user => user.id === userId);
  if (!existing) throw new AccountInputError('No such person.', 404);
  const passwordHash = change.password === undefined ? undefined
    : await hashPassword(checkPassword(change.password, [existing.name, existing.displayName]));
  let updated: AccountUser | undefined;
  const audits: Array<Parameters<typeof appendAudit>[0]> = [];
  await write(current => {
    const users = current!.users.map(user => {
      if (user.id !== userId) return user;
      const next = { ...user };
      if (typeof change.disabled === 'boolean' && change.disabled !== user.disabled) {
        next.disabled = change.disabled;
        if (change.disabled) next.generation += 1;
        audits.push({ action: change.disabled ? 'user-disabled' : 'user-enabled', actorUserId, target: { type: 'user', id: userId } });
      }
      if (INSTALLATION_ROLES.includes(change.role as InstallationRole) && change.role !== user.role) {
        next.role = change.role as InstallationRole;
        audits.push({ action: 'user-changed', actorUserId, target: { type: 'user', id: userId }, detail: { role: next.role } });
      }
      if (typeof change.hostAccess === 'boolean' && change.hostAccess !== user.hostAccess) {
        next.hostAccess = change.hostAccess;
        audits.push({ action: 'user-changed', actorUserId, target: { type: 'user', id: userId }, detail: { hostAccess: next.hostAccess } });
      }
      if (change.displayName !== undefined) next.displayName = cleanDisplayName(change.displayName, user.displayName);
      if (passwordHash) {
        next.passwordHash = passwordHash;
        next.generation += 1;
        audits.push({ action: 'password-changed', actorUserId, target: { type: 'user', id: userId } });
      }
      updated = next;
      return next;
    });
    return { ...current!, users };
  }, expectedRevision);
  if (updated && (updated.disabled || passwordHash)) await endSessionsForUser(userId);
  for (const audit of audits) await appendAudit(audit);
  return publicUser(updated!);
}

/** Store a new hash for a person after a successful sign-in with older hash settings. */
export async function upgradePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await write(current => ({
    ...current!,
    users: current!.users.map(user => user.id === userId ? { ...user, passwordHash } : user),
  }));
}

/**
 * Give a workspace to a person. `actor` must be allowed to (admins may assign
 * any workspace, including unassigned ones). `null` as the actor is the
 * server command line.
 */
export async function assignWorkspace(workspace: string, ownerUserId: string, actor: AccountUser | null,
  now = Date.now()): Promise<void> {
  const accounts = await enabledAccounts();
  if (!WORKSPACE_NAME_PATTERN.test(workspace)) throw new AccountInputError('Unknown workspace.', 404);
  if (!accounts.users.some(user => user.id === ownerUserId)) throw new AccountInputError('No such person.', 404);
  if (actor && !mayTransferWorkspace(accounts, actor, workspace, { ownerType: 'user', ownerId: ownerUserId })) {
    throw new AccountInputError('Unknown workspace.', 404);
  }
  await write(current => ({
    ...current!,
    workspaces: { ...current!.workspaces, [workspace]: { ownerType: 'user', ownerId: ownerUserId, assignedAt: now } },
  }));
  await appendAudit({ action: 'workspace-owner-changed', actorUserId: actor?.id ?? null, target: { type: 'workspace', id: workspace }, detail: { ownerId: ownerUserId } });
}

/** A new workspace belongs to the person who created it. No-op while the mode is off. */
export async function recordWorkspaceCreated(workspace: string, creatorUserId: string | null, now = Date.now()): Promise<void> {
  const state = await loadAccountsState();
  if (state.mode !== 'on' || !creatorUserId) return;
  await write(current => ({
    ...current!,
    workspaces: { ...current!.workspaces, [workspace]: { ownerType: 'user', ownerId: creatorUserId, assignedAt: now } },
  }));
  await appendAudit({ action: 'workspace-owner-changed', actorUserId: creatorUserId, target: { type: 'workspace', id: workspace }, detail: { created: true } });
}

/** Keep the owner record with a renamed workspace, and drop it for a deleted one. No-op while the mode is off. */
export async function recordWorkspaceRenamed(from: string, to: string | null): Promise<void> {
  const state = await loadAccountsState();
  if (state.mode === 'off' && !state.accounts) return;
  const accounts = state.accounts;
  if (!accounts || !Object.prototype.hasOwnProperty.call(accounts.workspaces, from)) return;
  await write(current => {
    const workspaces = { ...current!.workspaces };
    const owner = workspaces[from];
    delete workspaces[from];
    if (owner && to) workspaces[to] = owner;
    return { ...current!, workspaces };
  });
}

export function mayAdminister(user: AccountUser | null): boolean {
  return user !== null && mayManageAccounts(user);
}

export interface TokenInput {
  readonly label?: unknown;
  readonly scopes?: unknown;
  readonly expiresInDays?: unknown;
}

/** Make a personal API token. The plain token is returned once. */
export async function createToken(userId: string, input: TokenInput, now = Date.now()): Promise<{ token: string; record: PublicToken }> {
  await enabledAccounts();
  const scopes = Array.isArray(input.scopes)
    ? ACCOUNT_TOKEN_SCOPES.filter(scope => (input.scopes as unknown[]).includes(scope))
    : ['openai:read', 'openai:execute', 'mcp:access'] as AccountTokenScope[];
  if (scopes.length === 0) throw new AccountInputError('Choose at least one permission for the token.');
  const days = typeof input.expiresInDays === 'number' && Number.isFinite(input.expiresInDays) ? input.expiresInDays : 365;
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 100) : undefined;
  const { token, record } = issueAccountToken({
    userId, scopes, ...(label ? { label } : {}),
    expiresAt: now + Math.max(1, Math.min(days * 24 * 60 * 60 * 1000, DEFAULT_TOKEN_LIFETIME_MS)),
  }, now);
  await write(current => ({ ...current!, apiTokens: [...current!.apiTokens, record] }));
  await appendAudit({ action: 'token-issued', actorUserId: userId, target: { type: 'token', id: record.id } });
  return { token, record: publicToken(record) };
}

/** Revoke a token. People revoke their own; admins any. */
export async function revokeToken(tokenId: string, actor: AccountUser, now = Date.now()): Promise<void> {
  const accounts = await enabledAccounts();
  const token = accounts.apiTokens.find(candidate => candidate.id === tokenId);
  if (!token || (token.userId !== actor.id && !mayManageAccounts(actor))) throw new AccountInputError('No such token.', 404);
  if (token.revokedAt !== null) return;
  await write(current => ({
    ...current!,
    apiTokens: current!.apiTokens.map(candidate => candidate.id === tokenId ? { ...candidate, revokedAt: now } : candidate),
  }));
  await appendAudit({ action: 'token-revoked', actorUserId: actor.id, target: { type: 'token', id: tokenId } });
}
