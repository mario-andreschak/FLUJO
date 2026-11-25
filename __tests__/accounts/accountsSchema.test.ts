import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ACCOUNT_SESSION_MAX_AGE_MS, ACCOUNT_TOKEN_SCOPES, API_TOKEN_PATTERN, PASSWORD_HASH_PATTERN, SCRYPT_MAXMEM_BYTES,
  SCRYPT_PARAMETERS, SESSION_TOKEN_PATTERN, WORKSPACE_NAME_PATTERN,
  accountApiTokenSchema, accountsFileSchema, auditEventSchema, isMultiUserEnabled, sessionsFileSchema,
} from '@/shared/types/accounts';
import { OWNER_SCOPES, issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { WORKSPACE_NAME_PATTERN as STORAGE_WORKSPACE_NAME_PATTERN } from '@/utils/workspace';
import { NOW, accountsFixture, digest, ids } from './fixtures';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }) => Promise<Buffer>;

function problems(value: unknown): string[] {
  const result = accountsFileSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
}

describe('accounts.json format', () => {
  it('accepts the documented shape', () => {
    expect(problems(accountsFixture())).toEqual([]);
  });

  it('needs an active admin while the mode is on, but not while it is off', () => {
    const file = accountsFixture();
    const noAdmin = { ...file, users: file.users.map(user => user.role === 'admin' ? { ...user, disabled: true } : user) };
    expect(problems(noAdmin)).toContain('Multi-user mode needs at least one active admin');
    expect(problems({ ...noAdmin, enabled: false })).toEqual([]);
  });

  it('rejects duplicate people, teams and tokens', () => {
    const file = accountsFixture();
    expect(problems({ ...file, users: [...file.users, { ...file.users[1], id: 'u_another00000000000', name: 'anna' }] }))
      .toContain('Duplicate user name');
    expect(problems({ ...file, teams: [...file.teams, { ...file.teams[0], id: 't_another00000000000', name: 'sales' }] }))
      .toContain('Duplicate team name');
    expect(problems({ ...file, apiTokens: [...file.apiTokens, { ...file.apiTokens[0], id: 'tok-copy' }] }))
      .toContain('Duplicate token digest');
    const team = { ...file.teams[0], members: [...file.teams[0].members, { userId: ids.anna, role: 'member', state: 'member' }] };
    expect(problems({ ...file, teams: [team, file.teams[1]] })).toContain('A person is listed twice in one team');
  });

  it('rejects references to people and teams that do not exist', () => {
    const file = accountsFixture();
    const ghost = 'u_ghost0000000000000';
    expect(problems({ ...file, apiTokens: [{ ...file.apiTokens[0], userId: ghost }] }))
      .toContain('Token tok-anna belongs to an unknown person');
    expect(problems({ ...file, workspaces: { x: { ownerType: 'team', ownerId: 't_ghost0000000000000', assignedAt: NOW } } }))
      .toContain('Workspace x has an unknown owner');
    const team = { ...file.teams[0], members: [{ userId: ghost, role: 'owner', state: 'member' }] };
    expect(problems({ ...file, teams: [team] })).toContain(`Team ${team.id} lists an unknown person`);
  });

  it('accepts only valid workspace names, and no two that differ only by case', () => {
    const file = accountsFixture();
    const owner = { ownerType: 'user', ownerId: ids.anna, assignedAt: NOW };
    expect(problems({ ...file, workspaces: { 'anna-ws': owner, 'Anna-WS': owner } }))
      .toContain('Two workspace owner records differ only by upper and lower case');
    expect(problems({ ...file, workspaces: { con: owner } })).not.toEqual([]);
    expect(problems({ ...file, workspaces: { '../x': owner } })).not.toEqual([]);
    expect(WORKSPACE_NAME_PATTERN.source).toBe(STORAGE_WORKSPACE_NAME_PATTERN.source);
  });

  it('rejects unknown fields instead of keeping them silently', () => {
    const file = accountsFixture();
    expect(problems({ ...file, extra: true })).not.toEqual([]);
    expect(problems({ ...file, users: [{ ...file.users[0], password: 'plain text' }, ...file.users.slice(1)] })).not.toEqual([]);
  });

  it('reports the mode only for a file that turns it on', () => {
    expect(isMultiUserEnabled(null)).toBe(false);
    expect(isMultiUserEnabled(undefined)).toBe(false);
    expect(isMultiUserEnabled({ enabled: false })).toBe(false);
    expect(isMultiUserEnabled({ enabled: true })).toBe(true);
  });
});

describe('API tokens', () => {
  it('uses the owner policy scope names, so owner tokens can move to the first admin', () => {
    expect([...ACCOUNT_TOKEN_SCOPES]).toEqual([...OWNER_SCOPES]);
  });

  it('accepts an owner credential copied as an account token without changes', () => {
    for (const options of [{}, { workspaceId: 'anna-ws' }]) {
      const scopes = 'workspaceId' in options ? ['avatar:voice'] as const : ['openai:execute', 'control:admin'] as const;
      const { token, record } = issueOwnerCredential(scopes, NOW + 1000, NOW, options);
      expect(token).toMatch(API_TOKEN_PATTERN);
      expect(accountApiTokenSchema.parse({ ...record, userId: ids.admin })).toEqual({ ...record, userId: ids.admin });
    }
  });

  it('rejects a token that expires before it was issued', () => {
    expect(accountApiTokenSchema.safeParse({ id: 't1', userId: ids.anna, digest: digest(), scopes: ['openai:read'],
      issuedAt: NOW, expiresAt: NOW, revokedAt: null }).success).toBe(false);
  });
});

describe('passwords', () => {
  const encode = (logN: number, r: number, p: number, salt: Buffer, hash: Buffer) =>
    `scrypt-v1$${logN}$${r}$${p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;

  it('stores real scrypt output in the documented format', async () => {
    const salt = randomBytes(SCRYPT_PARAMETERS.saltBytes);
    const hash = await scryptAsync('correct horse battery staple', salt, SCRYPT_PARAMETERS.keyBytes, { N: 2 ** 14, r: 8, p: 1 });
    expect(encode(14, 8, 1, salt, hash)).toMatch(PASSWORD_HASH_PATTERN);
    expect(encode(13, 8, 1, salt, hash)).not.toMatch(PASSWORD_HASH_PATTERN);
  });

  it('needs the raised memory limit for the chosen strength', async () => {
    expect(SCRYPT_PARAMETERS).toEqual({ logN: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const salt = randomBytes(SCRYPT_PARAMETERS.saltBytes);
    const options = { N: 2 ** SCRYPT_PARAMETERS.logN, r: SCRYPT_PARAMETERS.r, p: SCRYPT_PARAMETERS.p };
    await expect(scryptAsync('x'.repeat(15), salt, 32, options)).rejects.toThrow();
    const hash = await scryptAsync('x'.repeat(15), salt, 32, { ...options, maxmem: SCRYPT_MAXMEM_BYTES });
    expect(encode(17, 8, 1, salt, hash)).toMatch(PASSWORD_HASH_PATTERN);
  });
});

describe('sessions.json and audit.jsonl', () => {
  const sessionRecord = { id: 'sess_0000000000000001', digest: digest(), userId: ids.anna, userGeneration: 2,
    issuedAt: NOW, expiresAt: NOW + ACCOUNT_SESSION_MAX_AGE_MS };

  it('keeps sessions at most eight hours long and stores only digests', () => {
    expect(sessionsFileSchema.safeParse({ schemaVersion: 1, sessions: [sessionRecord] }).success).toBe(true);
    expect(sessionsFileSchema.safeParse({ schemaVersion: 1, sessions: [{ ...sessionRecord, expiresAt: NOW + ACCOUNT_SESSION_MAX_AGE_MS + 1 }] }).success).toBe(false);
    expect(sessionsFileSchema.safeParse({ schemaVersion: 1, sessions: [{ ...sessionRecord, token: 'flo_a1_x' }] }).success).toBe(false);
    expect(`flo_a1_${randomBytes(32).toString('base64url')}`).toMatch(SESSION_TOKEN_PATTERN);
  });

  it('accepts short audit facts and rejects anything else', () => {
    const event = { at: NOW, action: 'sign-in', actorUserId: ids.anna, target: { type: 'session', id: 'sess_1' } };
    expect(auditEventSchema.safeParse(event).success).toBe(true);
    expect(auditEventSchema.safeParse({ ...event, actorUserId: null, action: 'mode-enabled' }).success).toBe(true);
    expect(auditEventSchema.safeParse({ ...event, password: 'x' }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...event, detail: { note: 'x'.repeat(201) } }).success).toBe(false);
    expect(auditEventSchema.safeParse({ ...event, action: 'something-else' }).success).toBe(false);
  });
});
