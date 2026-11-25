import { randomBytes } from 'node:crypto';
import {
  TEAM_ROLES,
  type AccountTeam, type AccountUser, type AccountsFile, type TeamMemberState, type TeamRole,
} from '@/shared/types/accounts';
import { mayManageAccounts, mayManageTeam } from './access';
import { AccountInputError } from './admin';
import { appendAudit, loadAccountsState, mutateAccounts } from './store';

/**
 * Teams (Tier 1, #575). An admin creates a team; the admin and the team's
 * owners add, invite and remove people and change their role. A team owns
 * whole workspaces; every active member can use them (see `access.ts`).
 *
 * Removing someone or changing their role raises the team's `generation`, so
 * edit leases taken under the old roles end. Access itself needs no bump: every
 * request reads the current membership, and open live-update streams recheck it
 * every second.
 *
 * Everything here needs multi-user mode to be on.
 */

/** A team member as the page shows them: names only, never a password hash. */
export interface PublicTeamMember {
  readonly userId: string;
  readonly name: string;
  readonly displayName: string;
  readonly role: TeamRole;
  readonly state: TeamMemberState;
}

export interface PublicTeam {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** The asking person's place in the team, or `null` (an admin who is not in it). */
  readonly myRole: TeamRole | null;
  readonly myState: TeamMemberState | null;
  /** Whether the asking person may add, remove and change members. */
  readonly mayManage: boolean;
  /** Current and invited members. Removed people are kept in the file for the record but not listed. */
  readonly members: readonly PublicTeamMember[];
  /** The workspaces this team owns. */
  readonly workspaces: readonly string[];
}

/** A person someone may add to a team. */
export interface TeamCandidate {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

function newTeamId(): string {
  return `t_${randomBytes(12).toString('base64url')}`;
}

function cleanTeamName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 100) throw new AccountInputError('Use a team name of 1 to 100 characters.');
  return name;
}

function cleanRole(value: unknown, fallback: TeamRole): TeamRole {
  if (value === undefined) return fallback;
  if (!TEAM_ROLES.includes(value as TeamRole)) throw new AccountInputError('Choose owner, member or viewer.');
  return value as TeamRole;
}

async function enabledAccounts(): Promise<AccountsFile> {
  const state = await loadAccountsState();
  if (state.mode !== 'on') throw new AccountInputError('Multi-user mode is off.', 409);
  return state.accounts;
}

function teamOf(accounts: AccountsFile, teamId: unknown): AccountTeam {
  const team = typeof teamId === 'string' ? accounts.teams.find(candidate => candidate.id === teamId) : undefined;
  if (!team) throw new AccountInputError('No such team.', 404);
  return team;
}

/** Same answer for "no such team" and "not your team", so ids cannot be probed. */
function manageableTeam(accounts: AccountsFile, actor: AccountUser, teamId: unknown): AccountTeam {
  const team = teamOf(accounts, teamId);
  if (!mayManageTeam(accounts, actor, team.id)) {
    const visible = team.members.some(member => member.userId === actor.id && member.state !== 'removed');
    if (!visible) throw new AccountInputError('No such team.', 404);
    throw new AccountInputError('Only an owner of this team or an admin can change it.', 403);
  }
  return team;
}

function teamWorkspaces(accounts: AccountsFile, teamId: string): string[] {
  return Object.entries(accounts.workspaces)
    .filter(([, owner]) => owner.ownerType === 'team' && owner.ownerId === teamId)
    .map(([workspace]) => workspace)
    .sort((a, b) => a.localeCompare(b));
}

export function publicTeam(accounts: AccountsFile, team: AccountTeam, viewer: AccountUser): PublicTeam {
  const mine = team.members.find(member => member.userId === viewer.id && member.state !== 'removed');
  const members = team.members
    .filter(member => member.state !== 'removed')
    .map(member => {
      const person = accounts.users.find(user => user.id === member.userId);
      return {
        userId: member.userId,
        name: person?.name ?? 'unknown',
        displayName: person?.displayName ?? 'Someone who no longer exists',
        role: member.role,
        state: member.state,
      };
    });
  return {
    id: team.id,
    name: team.name,
    createdAt: team.createdAt,
    myRole: mine?.role ?? null,
    myState: mine?.state ?? null,
    mayManage: mayManageTeam(accounts, viewer, team.id),
    members,
    workspaces: teamWorkspaces(accounts, team.id),
  };
}

/** The teams a person sees: admins see every team; others the teams they are in or invited to. */
export function teamsFor(accounts: AccountsFile, viewer: AccountUser): PublicTeam[] {
  return accounts.teams
    .filter(team => mayManageAccounts(viewer)
      || team.members.some(member => member.userId === viewer.id && member.state !== 'removed'))
    .map(team => publicTeam(accounts, team, viewer))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * People a team manager may add: every active person. Only people who manage
 * at least one team see this list, and only names, never anything else.
 */
export function teamCandidates(accounts: AccountsFile, viewer: AccountUser): TeamCandidate[] {
  const managesAny = mayManageAccounts(viewer) || accounts.teams.some(team => mayManageTeam(accounts, viewer, team.id));
  if (!managesAny) return [];
  return accounts.users
    .filter(user => !user.disabled)
    .map(user => ({ id: user.id, name: user.name, displayName: user.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function write(change: (current: AccountsFile) => AccountsFile): Promise<AccountsFile> {
  return mutateAccounts(current => {
    if (!current?.enabled) throw new AccountInputError('Multi-user mode is off.', 409);
    return change(current);
  });
}

export interface CreateTeamInput {
  readonly name?: unknown;
  /** The first owner. Defaults to nobody; an admin can manage the team anyway. */
  readonly ownerUserId?: unknown;
}

/** Make a team. Admins only. */
export async function createTeam(input: CreateTeamInput, actor: AccountUser, now = Date.now()): Promise<PublicTeam> {
  const accounts = await enabledAccounts();
  if (!mayManageAccounts(actor)) throw new AccountInputError('Only an admin can make a team.', 403);
  const name = cleanTeamName(input.name);
  if (accounts.teams.some(team => team.name.toLowerCase() === name.toLowerCase())) {
    throw new AccountInputError('A team with that name already exists.', 409);
  }
  const ownerId = typeof input.ownerUserId === 'string' && input.ownerUserId ? input.ownerUserId : null;
  if (ownerId && !accounts.users.some(user => user.id === ownerId && !user.disabled)) {
    throw new AccountInputError('No such person.', 404);
  }
  const team: AccountTeam = {
    id: newTeamId(), name, generation: 1, createdAt: now,
    members: ownerId ? [{ userId: ownerId, role: 'owner', state: 'member' }] : [],
  };
  const next = await write(current => {
    if (current.teams.some(existing => existing.name.toLowerCase() === name.toLowerCase())) {
      throw new AccountInputError('A team with that name already exists.', 409);
    }
    return { ...current, teams: [...current.teams, team] };
  });
  await appendAudit({ action: 'team-created', actorUserId: actor.id, target: { type: 'team', id: team.id } });
  if (ownerId) {
    await appendAudit({ action: 'member-added', actorUserId: actor.id, target: { type: 'team', id: team.id },
      detail: { userId: ownerId, role: 'owner', state: 'member' } });
  }
  return publicTeam(next, next.teams.find(candidate => candidate.id === team.id)!, actor);
}

/** Rename a team. Team owners and admins. */
export async function renameTeam(teamId: unknown, name: unknown, actor: AccountUser): Promise<PublicTeam> {
  const accounts = await enabledAccounts();
  const team = manageableTeam(accounts, actor, teamId);
  const clean = cleanTeamName(name);
  const next = await write(current => {
    if (current.teams.some(other => other.id !== team.id && other.name.toLowerCase() === clean.toLowerCase())) {
      throw new AccountInputError('A team with that name already exists.', 409);
    }
    return { ...current, teams: current.teams.map(other => other.id === team.id ? { ...other, name: clean } : other) };
  });
  await appendAudit({ action: 'team-changed', actorUserId: actor.id, target: { type: 'team', id: team.id } });
  return publicTeam(next, next.teams.find(candidate => candidate.id === team.id)!, actor);
}

/** Delete a team. Admins only, and only once it owns no workspace (they would become unreachable). */
export async function deleteTeam(teamId: unknown, actor: AccountUser): Promise<void> {
  const accounts = await enabledAccounts();
  if (!mayManageAccounts(actor)) throw new AccountInputError('Only an admin can delete a team.', 403);
  const team = teamOf(accounts, teamId);
  await write(current => {
    const owned = teamWorkspaces(current, team.id);
    if (owned.length > 0) {
      throw new AccountInputError(`This team still owns ${owned.join(', ')}. Give those workspaces to someone else first.`, 409);
    }
    return { ...current, teams: current.teams.filter(other => other.id !== team.id) };
  });
  await appendAudit({ action: 'team-deleted', actorUserId: actor.id, target: { type: 'team', id: team.id } });
}

export interface MemberChange {
  readonly userId?: unknown;
  /** `owner`, `member` (can edit and run) or `viewer` (can only look). */
  readonly role?: unknown;
  /** `true` asks the person to accept first; otherwise they join at once. */
  readonly invite?: unknown;
  /** `true` takes the person out of the team. */
  readonly remove?: unknown;
}

/**
 * Add, invite, change or remove one person in a team. Team owners and admins.
 * Removing someone or changing their role raises the team generation.
 */
export async function changeMember(teamId: unknown, change: MemberChange, actor: AccountUser): Promise<PublicTeam> {
  const accounts = await enabledAccounts();
  const team = manageableTeam(accounts, actor, teamId);
  const userId = typeof change.userId === 'string' ? change.userId : '';
  const person = accounts.users.find(user => user.id === userId);
  if (!person) throw new AccountInputError('No such person.', 404);
  const audits: Array<Parameters<typeof appendAudit>[0]> = [];
  const next = await write(current => {
    const teams = current.teams.map(candidate => {
      if (candidate.id !== team.id) return candidate;
      const existing = candidate.members.find(member => member.userId === userId);
      const members = candidate.members.filter(member => member.userId !== userId);
      let generation = candidate.generation;
      if (change.remove === true) {
        if (!existing || existing.state === 'removed') return candidate;
        members.push({ ...existing, state: 'removed' });
        generation += 1;
        audits.push({ action: 'member-removed', actorUserId: actor.id, target: { type: 'team', id: team.id }, detail: { userId } });
      } else if (!existing || existing.state === 'removed') {
        if (person.disabled) throw new AccountInputError('That person is turned off. Turn them on first.', 409);
        const role = cleanRole(change.role, 'member');
        const state: TeamMemberState = change.invite === true ? 'invited' : 'member';
        members.push({ userId, role, state });
        audits.push({ action: 'member-added', actorUserId: actor.id, target: { type: 'team', id: team.id }, detail: { userId, role, state } });
      } else {
        const role = cleanRole(change.role, existing.role);
        if (role === existing.role) return candidate;
        members.push({ ...existing, role });
        generation += 1;
        audits.push({ action: 'member-changed', actorUserId: actor.id, target: { type: 'team', id: team.id }, detail: { userId, role } });
      }
      return { ...candidate, generation, members: sortMembers(members, candidate) };
    });
    return { ...current, teams };
  });
  for (const audit of audits) await appendAudit(audit);
  return publicTeam(next, next.teams.find(candidate => candidate.id === team.id)!, actor);
}

/** Keep the file's member order stable: people stay where they were, new people go last. */
function sortMembers(members: AccountTeam['members'], before: AccountTeam): AccountTeam['members'] {
  const order = new Map(before.members.map((member, index) => [member.userId, index]));
  return [...members].sort((a, b) => (order.get(a.userId) ?? Infinity) - (order.get(b.userId) ?? Infinity));
}

/** The invited person accepts or declines. Nobody else can answer for them. */
export async function answerInvite(teamId: unknown, accept: boolean, person: AccountUser): Promise<PublicTeam | null> {
  const accounts = await enabledAccounts();
  const team = teamOf(accounts, teamId);
  const invite = team.members.find(member => member.userId === person.id && member.state === 'invited');
  if (!invite) throw new AccountInputError('No such invitation.', 404);
  const next = await write(current => ({
    ...current,
    teams: current.teams.map(candidate => candidate.id !== team.id ? candidate : {
      ...candidate,
      members: candidate.members.map(member => member.userId === person.id && member.state === 'invited'
        ? { ...member, state: accept ? 'member' as const : 'removed' as const }
        : member),
    }),
  }));
  await appendAudit({ action: 'member-changed', actorUserId: person.id, target: { type: 'team', id: team.id },
    detail: { userId: person.id, state: accept ? 'member' : 'declined' } });
  return accept ? publicTeam(next, next.teams.find(candidate => candidate.id === team.id)!, person) : null;
}
