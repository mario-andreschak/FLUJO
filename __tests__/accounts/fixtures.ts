import { randomBytes } from 'node:crypto';
import {
  accountsFileSchema,
  type AccountPrincipal, type AccountsFile, type AccountTokenScope,
} from '@/shared/types/accounts';

export const NOW = 1_800_000_000_000;

export function passwordHash(): string {
  return `scrypt-v1$17$8$1$${randomBytes(16).toString('base64url')}$${randomBytes(32).toString('base64url')}`;
}

export function digest(): string {
  return randomBytes(32).toString('hex');
}

export const ids = {
  admin: 'u_admin00000000000000',
  anna: 'u_anna000000000000000',
  ben: 'u_ben0000000000000000',
  cleo: 'u_cleo00000000000000',
  dora: 'u_dora00000000000000',
  sales: 't_sales0000000000000',
  empty: 't_empty0000000000000',
} as const;

const user = (id: string, name: string, extra: Partial<AccountsFile['users'][number]> = {}) => ({
  id, name, displayName: name, passwordHash: passwordHash(), role: 'member' as const,
  hostAccess: false, disabled: false, generation: 1, createdAt: NOW - 1000, ...extra,
});

/**
 * Two people with personal workspaces, a team with an owner, a member, an
 * invited person and a removed person, a disabled person, and an unassigned
 * workspace.
 *
 * - admin: installation admin, owns `admin-ws`
 * - anna: member, owns `anna-ws`; owner of team Sales
 * - ben: member, owns `ben-ws`; member of team Sales; has host access
 * - cleo: member; invited to Sales (not accepted)
 * - dora: disabled; was removed from Sales; owns `dora-ws`
 * - `sales-ws` belongs to team Sales; `empty-ws` to a team with no active member
 * - `loose-ws` has no owner record
 */
export function accountsFixture(overrides: Partial<AccountsFile> = {}): AccountsFile {
  return accountsFileSchema.parse({
    schemaVersion: 1,
    enabled: true,
    revision: 3,
    users: [
      user(ids.admin, 'admin', { role: 'admin', hostAccess: false }),
      user(ids.anna, 'anna', { generation: 2 }),
      user(ids.ben, 'ben', { hostAccess: true }),
      user(ids.cleo, 'cleo'),
      user(ids.dora, 'dora', { disabled: true, generation: 4 }),
    ],
    teams: [
      { id: ids.sales, name: 'Sales', generation: 2, createdAt: NOW - 500, members: [
        { userId: ids.anna, role: 'owner', state: 'member' },
        { userId: ids.ben, role: 'member', state: 'member' },
        { userId: ids.cleo, role: 'member', state: 'invited' },
        { userId: ids.dora, role: 'member', state: 'removed' },
      ] },
      { id: ids.empty, name: 'Empty', generation: 1, createdAt: NOW - 500, members: [
        { userId: ids.dora, role: 'owner', state: 'member' },
      ] },
    ],
    workspaces: {
      'admin-ws': { ownerType: 'user', ownerId: ids.admin, assignedAt: NOW - 100 },
      'anna-ws': { ownerType: 'user', ownerId: ids.anna, assignedAt: NOW - 100 },
      'ben-ws': { ownerType: 'user', ownerId: ids.ben, assignedAt: NOW - 100 },
      'dora-ws': { ownerType: 'user', ownerId: ids.dora, assignedAt: NOW - 100 },
      'sales-ws': { ownerType: 'team', ownerId: ids.sales, assignedAt: NOW - 100 },
      'empty-ws': { ownerType: 'team', ownerId: ids.empty, assignedAt: NOW - 100 },
    },
    apiTokens: [
      { id: 'tok-anna', userId: ids.anna, digest: digest(), scopes: ['openai:execute', 'control:admin'],
        issuedAt: NOW - 100, expiresAt: NOW + 100_000, revokedAt: null },
      { id: 'tok-anna-voice', userId: ids.anna, digest: digest(), scopes: ['avatar:voice'],
        issuedAt: NOW - 100, expiresAt: NOW + 100_000, revokedAt: null, workspaceId: 'anna-ws' },
      { id: 'tok-ben-revoked', userId: ids.ben, digest: digest(), scopes: ['control:admin'],
        issuedAt: NOW - 100, expiresAt: NOW + 100_000, revokedAt: NOW - 50 },
      { id: 'tok-ben-expired', userId: ids.ben, digest: digest(), scopes: ['control:admin'],
        issuedAt: NOW - 100, expiresAt: NOW - 1, revokedAt: null },
      { id: 'tok-admin', userId: ids.admin, digest: digest(), scopes: ['control:admin', 'secrets:read'],
        issuedAt: NOW - 100, expiresAt: NOW + 100_000, revokedAt: null },
    ],
    ...overrides,
  });
}

export function session(userId: string, generation = 1): AccountPrincipal {
  return { kind: 'session', userId, sessionId: `s_${userId}_session`, generation };
}

export function token(userId: string, tokenId: string, scopes: AccountTokenScope[], workspaceId?: string): AccountPrincipal {
  return { kind: 'api-token', userId, tokenId, scopes, ...(workspaceId ? { workspaceId } : {}) };
}

/** Sessions with each fixture person's current generation. */
export const people = {
  admin: session(ids.admin, 1),
  anna: session(ids.anna, 2),
  ben: session(ids.ben, 1),
  cleo: session(ids.cleo, 1),
  dora: session(ids.dora, 4),
} as const;
