import fs from 'node:fs';
import path from 'node:path';
import {
  ACCESS_DENIAL_STATUS, REVEAL_SECRETS_ACTION, WORKSPACE_GRANT_ACTIONS,
  activeUser, decideBackgroundAccess, decideRouteAccess, decideWorkspaceAccess, hasHostAccess,
  listAccessibleWorkspaces, mayCreateWorkspaceFor, mayManageAccounts, mayManageTeam, mayTransferWorkspace,
  workspaceActionForMethod, workspaceActions,
  type AccessDecision, type RouteAccessRequest,
} from '@/backend/services/accounts/access';
import { WORKSPACE_ACTIONS, type AccountPrincipal, type AccountsFile, type WorkspaceAction } from '@/shared/types/accounts';
import { NOW, accountsFixture, ids, people, session, token } from './fixtures';

const accounts = accountsFixture();
const userOf = (id: string) => accounts.users.find(user => user.id === id)!;

function outcome(decision: AccessDecision): string {
  return decision.allowed ? `allow:${decision.grant}` : `deny:${decision.denial}`;
}

function workspace(principal: AccountPrincipal | null, name: string, action: WorkspaceAction, file: AccountsFile | null = accounts) {
  return outcome(decideWorkspaceAccess(file, principal, name, action, NOW));
}

function route(principal: AccountPrincipal | null, request: Partial<RouteAccessRequest> & Pick<RouteAccessRequest, 'kind'>,
  file: AccountsFile | null = accounts) {
  return outcome(decideRouteAccess(file, principal, { workspace: null, workspaceAction: 'read', ...request }, NOW));
}

describe('multi-user access rules: mode off keeps single-user behaviour', () => {
  const off = accountsFixture({ enabled: false });

  it.each([
    ['no accounts file', null],
    ['accounts file turned off', off],
  ] as const)('allows everything with %s', (_label, file) => {
    for (const action of WORKSPACE_ACTIONS) expect(workspace(null, 'anna-ws', action, file)).toBe('allow:multi-user-off');
    for (const kind of ['workspace', 'host', 'admin', 'account', 'protocol', undefined] as const) {
      expect(route(null, { kind, workspace: 'loose-ws', workspaceAction: 'admin' }, file)).toBe('allow:multi-user-off');
    }
    expect(listAccessibleWorkspaces(file, null, ['a', 'b'], NOW)).toBe('multi-user-off');
    expect(outcome(decideBackgroundAccess(file, 'loose-ws', { kind: 'background' }, NOW))).toBe('allow:multi-user-off');
  });

  it('keeps the access rules pure: no file, clock, network or request access', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/backend/services/accounts/access.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]);
    expect(imports).toEqual(['@/shared/types/accounts']);
    expect(source).not.toMatch(/Date\.now|process\.|require\(/);
  });
});

describe('multi-user access rules: workspaces by role', () => {
  // [person, workspace, expected for read, edit, run, admin]
  it.each([
    ['admin', 'admin-ws', 'allow:installation-admin', 'allow:installation-admin'],
    ['admin', 'anna-ws', 'allow:installation-admin', 'allow:installation-admin'],
    ['admin', 'loose-ws', 'allow:installation-admin', 'allow:installation-admin'],
    ['admin', 'dora-ws', 'allow:installation-admin', 'allow:installation-admin'],
    ['anna', 'anna-ws', 'allow:personal-owner', 'allow:personal-owner'],
    ['anna', 'sales-ws', 'allow:team-owner', 'allow:team-owner'],
    ['anna', 'ben-ws', 'deny:not-found', 'deny:not-found'],
    ['anna', 'admin-ws', 'deny:not-found', 'deny:not-found'],
    ['anna', 'loose-ws', 'deny:not-found', 'deny:not-found'],
    ['anna', 'empty-ws', 'deny:not-found', 'deny:not-found'],
    ['anna', 'no-such-workspace', 'deny:not-found', 'deny:not-found'],
    ['ben', 'ben-ws', 'allow:personal-owner', 'allow:personal-owner'],
    ['ben', 'sales-ws', 'allow:team-member', 'deny:workspace-admin-required'],
    ['ben', 'anna-ws', 'deny:not-found', 'deny:not-found'],
    ['cleo', 'sales-ws', 'deny:not-found', 'deny:not-found'],
    ['cleo', 'loose-ws', 'deny:not-found', 'deny:not-found'],
    ['dora', 'dora-ws', 'deny:sign-in-required', 'deny:sign-in-required'],
    ['dora', 'sales-ws', 'deny:sign-in-required', 'deny:sign-in-required'],
  ] as const)('%s in %s', (person, name, everyday, admin) => {
    const principal = people[person];
    expect(workspace(principal, name, 'read')).toBe(everyday);
    expect(workspace(principal, name, 'edit')).toBe(everyday);
    expect(workspace(principal, name, 'run')).toBe(everyday);
    expect(workspace(principal, name, 'admin')).toBe(admin);
  });

  it('gives unknown and forbidden workspaces the same 404, and a denied admin action a 403', () => {
    const unknown = decideWorkspaceAccess(accounts, people.anna, 'no-such-workspace', 'read', NOW);
    const forbidden = decideWorkspaceAccess(accounts, people.anna, 'ben-ws', 'read', NOW);
    expect(unknown).toEqual(forbidden);
    expect(forbidden).toEqual({ allowed: false, denial: 'not-found', status: 404 });
    expect(decideWorkspaceAccess(accounts, people.ben, 'sales-ws', 'admin', NOW))
      .toEqual({ allowed: false, denial: 'workspace-admin-required', status: 403 });
  });

  it('keeps secrets hidden from team members and shown to owners', () => {
    expect(REVEAL_SECRETS_ACTION).toBe('admin');
    expect(workspace(people.ben, 'sales-ws', REVEAL_SECRETS_ACTION)).toBe('deny:workspace-admin-required');
    expect(workspace(people.anna, 'sales-ws', REVEAL_SECRETS_ACTION)).toBe('allow:team-owner');
    expect(WORKSPACE_GRANT_ACTIONS['team-member']).toEqual(['read', 'edit', 'run']);
  });

  it('matches workspace names exactly', () => {
    expect(workspace(people.anna, 'ANNA-ws', 'read')).toBe('deny:not-found');
    expect(workspace(people.anna, 'constructor', 'read')).toBe('deny:not-found');
    expect(workspace(people.anna, '__proto__', 'read')).toBe('deny:not-found');
  });

  it('cuts access when the person is removed from the team or disabled', () => {
    const removed = accountsFixture();
    removed.teams[0].members[1].state = 'removed';
    expect(workspace(people.ben, 'sales-ws', 'read', removed)).toBe('deny:not-found');
    const disabled = accountsFixture();
    disabled.users[2].disabled = true;
    expect(workspace(people.ben, 'ben-ws', 'read', disabled)).toBe('deny:sign-in-required');
  });

  it('accepts the invited person once they joined', () => {
    const joined = accountsFixture();
    joined.teams[0].members[2].state = 'member';
    expect(workspace(people.cleo, 'sales-ws', 'edit', joined)).toBe('allow:team-member');
  });
});

describe('multi-user access rules: who counts as signed in', () => {
  it.each([
    ['no principal', null, 'deny:sign-in-required'],
    ['unknown person', session('u_nobody000000000000', 1), 'deny:sign-in-required'],
    ['session from an older generation (password changed)', session(ids.anna, 1), 'deny:sign-in-required'],
    ['current session', people.anna, 'allow:personal-owner'],
    ['valid API token', token(ids.anna, 'tok-anna', ['openai:execute', 'control:admin']), 'allow:personal-owner'],
    ['revoked API token', token(ids.ben, 'tok-ben-revoked', ['control:admin']), 'deny:sign-in-required'],
    ['expired API token', token(ids.ben, 'tok-ben-expired', ['control:admin']), 'deny:sign-in-required'],
    ['API token claimed by another person', token(ids.ben, 'tok-anna', ['control:admin']), 'deny:sign-in-required'],
    ['unknown API token', token(ids.anna, 'tok-missing', ['control:admin']), 'deny:sign-in-required'],
    ['API token with a different workspace limit than stored', token(ids.anna, 'tok-anna-voice', ['avatar:voice'], 'sales-ws'), 'deny:sign-in-required'],
  ] as const)('%s', (_label, principal, expected) => {
    expect(workspace(principal, 'anna-ws', 'read')).toBe(expected);
  });

  it('does not count a token before it was issued or with a broken clock', () => {
    const principal = token(ids.anna, 'tok-anna', ['control:admin']);
    expect(activeUser(accounts, principal, NOW - 1000)).toBeNull();
    expect(activeUser(accounts, principal, Number.NaN)).toBeNull();
    expect(activeUser(accounts, principal, NOW)?.id).toBe(ids.anna);
  });

  it('limits a workspace-bound token to its workspace', () => {
    const voice = token(ids.anna, 'tok-anna-voice', ['avatar:voice'], 'anna-ws');
    expect(workspace(voice, 'anna-ws', 'run')).toBe('allow:personal-owner');
    expect(workspace(voice, 'sales-ws', 'read')).toBe('deny:not-found');
  });
});

describe('multi-user access rules: routes by kind', () => {
  it('lets protocol routes do their own checks', () => {
    expect(route(null, { kind: 'protocol' })).toBe('allow:own-check');
  });

  it('opens account routes to signed-in people, and sign-in itself to everyone', () => {
    expect(route(null, { kind: 'account' })).toBe('deny:sign-in-required');
    expect(route(null, { kind: 'account', signedOutAllowed: true })).toBe('allow:own-check');
    expect(route(people.ben, { kind: 'account' })).toBe('allow:signed-in');
    expect(route(token(ids.anna, 'tok-anna-voice', ['avatar:voice'], 'anna-ws'), { kind: 'account' }))
      .toBe('deny:token-scope-missing');
  });

  it('keeps admin routes and unclassified routes for admins', () => {
    for (const kind of ['admin', undefined] as const) {
      expect(route(people.admin, { kind })).toBe('allow:installation-admin');
      expect(route(people.anna, { kind })).toBe('deny:admin-required');
      expect(route(null, { kind })).toBe('deny:sign-in-required');
    }
    expect(decideRouteAccess(accounts, people.anna, { kind: 'admin', workspace: null, workspaceAction: 'read' }, NOW))
      .toEqual({ allowed: false, denial: 'admin-required', status: 403 });
  });

  it('checks the workspace before host access, so guessing reveals nothing', () => {
    expect(route(people.ben, { kind: 'host', workspace: 'ben-ws', workspaceAction: 'edit' })).toBe('allow:personal-owner');
    expect(route(people.anna, { kind: 'host', workspace: 'anna-ws', workspaceAction: 'edit' })).toBe('deny:host-access-required');
    expect(route(people.anna, { kind: 'host', workspace: 'ben-ws', workspaceAction: 'edit' })).toBe('deny:not-found');
    expect(route(people.ben, { kind: 'host', workspace: 'sales-ws', workspaceAction: 'edit' })).toBe('allow:team-member');
    expect(route(people.admin, { kind: 'host', workspace: 'anna-ws', workspaceAction: 'edit' })).toBe('allow:installation-admin');
    expect(route(people.ben, { kind: 'host' })).toBe('allow:host-access');
    expect(route(people.admin, { kind: 'host' })).toBe('allow:host-access');
    expect(route(people.anna, { kind: 'host' })).toBe('deny:host-access-required');
  });

  it('applies the workspace action from the route', () => {
    expect(route(people.ben, { kind: 'workspace', workspace: 'sales-ws', workspaceAction: 'edit' })).toBe('allow:team-member');
    expect(route(people.ben, { kind: 'workspace', workspace: 'sales-ws', workspaceAction: 'admin' })).toBe('deny:workspace-admin-required');
    expect(route(people.ben, { kind: 'workspace', workspace: null })).toBe('deny:not-found');
  });

  it('narrows API tokens by scope; sessions carry every scope', () => {
    const scoped = token(ids.anna, 'tok-anna', ['openai:execute', 'control:admin']);
    const request = { kind: 'workspace' as const, workspace: 'anna-ws', requiredScopes: ['control:admin', 'secrets:read'] as const };
    expect(route(scoped, request)).toBe('deny:token-scope-missing');
    expect(route(scoped, { ...request, requiredScopes: ['openai:execute'] })).toBe('allow:personal-owner');
    expect(route(people.anna, request)).toBe('allow:personal-owner');
  });

  it('never lets a token reach past its person', () => {
    const adminToken = token(ids.admin, 'tok-admin', ['control:admin', 'secrets:read']);
    expect(route(adminToken, { kind: 'admin' })).toBe('allow:installation-admin');
    const annaToken = token(ids.anna, 'tok-anna', ['openai:execute', 'control:admin']);
    expect(route(annaToken, { kind: 'admin', requiredScopes: ['control:admin'] })).toBe('deny:admin-required');
    expect(route(annaToken, { kind: 'workspace', workspace: 'ben-ws', requiredScopes: ['control:admin'] })).toBe('deny:not-found');
  });

  it('keeps a workspace-bound token off installation and account routes', () => {
    const voice = token(ids.anna, 'tok-anna-voice', ['avatar:voice'], 'anna-ws');
    expect(route(voice, { kind: 'admin' })).toBe('deny:token-scope-missing');
    expect(route(voice, { kind: 'host' })).toBe('deny:token-scope-missing');
    expect(route(voice, { kind: 'workspace', workspace: 'anna-ws', requiredScopes: ['avatar:voice'] })).toBe('allow:personal-owner');
  });

  it('maps every denial to one HTTP status', () => {
    expect(ACCESS_DENIAL_STATUS).toEqual({
      'sign-in-required': 401, 'not-found': 404, 'workspace-admin-required': 403, 'view-only': 403, 'host-access-required': 403,
      'admin-required': 403, 'token-scope-missing': 403, 'owner-inactive': 403, 'starter-lost-access': 403,
    });
  });
});

describe('multi-user access rules: workspace list', () => {
  const names = ['admin-ws', 'anna-ws', 'ben-ws', 'dora-ws', 'empty-ws', 'loose-ws', 'sales-ws'];
  const list = (principal: AccountPrincipal | null) => {
    const entries = listAccessibleWorkspaces(accounts, principal, names, NOW);
    return typeof entries === 'string' ? entries : entries.map(entry => `${entry.workspace}:${entry.grant}${entry.assigned ? '' : ':unassigned'}`);
  };

  it('shows each person only their own and their teams\' workspaces', () => {
    expect(list(people.anna)).toEqual(['anna-ws:personal-owner', 'sales-ws:team-owner']);
    expect(list(people.ben)).toEqual(['ben-ws:personal-owner', 'sales-ws:team-member']);
    expect(list(people.cleo)).toEqual([]);
    expect(list(people.dora)).toBe('sign-in-required');
    expect(list(null)).toBe('sign-in-required');
    expect(list(token(ids.anna, 'tok-anna-voice', ['avatar:voice'], 'anna-ws'))).toEqual(['anna-ws:personal-owner']);
  });

  it('shows admins every workspace and marks the unassigned ones', () => {
    expect(list(people.admin)).toEqual([
      'admin-ws:personal-owner', 'anna-ws:installation-admin', 'ben-ws:installation-admin', 'dora-ws:installation-admin',
      'empty-ws:installation-admin', 'loose-ws:installation-admin:unassigned', 'sales-ws:installation-admin',
    ]);
  });
});

describe('multi-user access rules: background work', () => {
  const background = (name: string, startedBy?: string, file: AccountsFile = accounts) =>
    outcome(decideBackgroundAccess(file, name, { kind: 'background', ...(startedBy ? { startedBy } : {}) }, NOW));

  it.each([
    ['anna-ws', undefined, 'allow:personal-owner'],
    ['anna-ws', ids.anna, 'allow:personal-owner'],
    ['anna-ws', ids.admin, 'allow:personal-owner'],
    ['anna-ws', ids.ben, 'deny:starter-lost-access'],
    ['dora-ws', undefined, 'deny:owner-inactive'],
    ['loose-ws', undefined, 'deny:owner-inactive'],
    ['sales-ws', undefined, 'allow:team-owner'],
    ['sales-ws', ids.ben, 'allow:team-owner'],
    ['sales-ws', ids.cleo, 'deny:starter-lost-access'],
    ['sales-ws', ids.dora, 'deny:starter-lost-access'],
    ['sales-ws', 'u_nobody000000000000', 'deny:starter-lost-access'],
    ['empty-ws', undefined, 'deny:owner-inactive'],
  ] as const)('%s started by %s', (name, startedBy, expected) => {
    expect(background(name, startedBy)).toBe(expected);
  });

  it('resumes by itself once the owner is enabled again', () => {
    const enabled = accountsFixture();
    enabled.users[4].disabled = false;
    expect(background('dora-ws', undefined, enabled)).toBe('allow:personal-owner');
    expect(background('empty-ws', undefined, enabled)).toBe('allow:team-owner');
  });

  it('pauses on a broken clock instead of guessing', () => {
    expect(outcome(decideBackgroundAccess(accounts, 'anna-ws', { kind: 'background' }, Number.NaN))).toBe('deny:owner-inactive');
  });
});

describe('multi-user access rules: managing people, teams and owners', () => {
  it('lets only admins manage accounts and gives admins host access', () => {
    expect(mayManageAccounts(userOf(ids.admin))).toBe(true);
    expect(mayManageAccounts(userOf(ids.anna))).toBe(false);
    expect(hasHostAccess(userOf(ids.admin))).toBe(true);
    expect(hasHostAccess(userOf(ids.ben))).toBe(true);
    expect(hasHostAccess(userOf(ids.anna))).toBe(false);
    expect(hasHostAccess({ ...userOf(ids.admin), disabled: true })).toBe(false);
  });

  it('lets admins and team owners manage a team', () => {
    expect(mayManageTeam(accounts, userOf(ids.admin), ids.sales)).toBe(true);
    expect(mayManageTeam(accounts, userOf(ids.anna), ids.sales)).toBe(true);
    expect(mayManageTeam(accounts, userOf(ids.ben), ids.sales)).toBe(false);
    expect(mayManageTeam(accounts, userOf(ids.cleo), ids.sales)).toBe(false);
  });

  it('lets people create their own workspaces and team owners create team workspaces', () => {
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.anna), { ownerType: 'user', ownerId: ids.anna })).toBe(true);
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.anna), { ownerType: 'user', ownerId: ids.ben })).toBe(false);
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.admin), { ownerType: 'user', ownerId: ids.ben })).toBe(true);
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.anna), { ownerType: 'team', ownerId: ids.sales })).toBe(true);
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.ben), { ownerType: 'team', ownerId: ids.sales })).toBe(false);
    expect(mayCreateWorkspaceFor(accounts, userOf(ids.admin), { ownerType: 'team', ownerId: 't_nosuchteam00000000' })).toBe(false);
  });

  it('lets an owner move a workspace into a team they own, and admins assign unassigned ones', () => {
    expect(mayTransferWorkspace(accounts, userOf(ids.anna), 'anna-ws', { ownerType: 'team', ownerId: ids.sales })).toBe(true);
    expect(mayTransferWorkspace(accounts, userOf(ids.ben), 'ben-ws', { ownerType: 'team', ownerId: ids.sales })).toBe(false);
    expect(mayTransferWorkspace(accounts, userOf(ids.ben), 'sales-ws', { ownerType: 'user', ownerId: ids.ben })).toBe(false);
    expect(mayTransferWorkspace(accounts, userOf(ids.admin), 'loose-ws', { ownerType: 'user', ownerId: ids.ben })).toBe(true);
    expect(mayTransferWorkspace(accounts, userOf(ids.admin), 'loose-ws', { ownerType: 'user', ownerId: 'u_nobody000000000000' })).toBe(false);
  });

  it('lists the workspace actions of each grant', () => {
    expect(workspaceActions(accounts, userOf(ids.ben), 'sales-ws')).toEqual(['read', 'edit', 'run']);
    expect(workspaceActions(accounts, userOf(ids.anna), 'sales-ws')).toEqual(['read', 'edit', 'run', 'admin']);
    expect(workspaceActions(accounts, userOf(ids.cleo), 'sales-ws')).toEqual([]);
  });

  it('reads with GET, HEAD and OPTIONS and edits with everything else', () => {
    expect(['GET', 'head', 'OPTIONS'].map(workspaceActionForMethod)).toEqual(['read', 'read', 'read']);
    expect(['POST', 'PUT', 'PATCH', 'DELETE'].map(workspaceActionForMethod)).toEqual(['edit', 'edit', 'edit', 'edit']);
  });
});
