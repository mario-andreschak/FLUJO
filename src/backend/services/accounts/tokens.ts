import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ACCOUNT_TOKEN_SCOPES, accountApiTokenSchema,
  type AccountApiToken, type AccountPrincipal, type AccountTokenScope, type AccountsFile,
} from '@/shared/types/accounts';
import type { OwnerPolicy } from '@/backend/services/security/ownerCredentials';
import { tokenDigest } from './sessions';

/**
 * Personal API tokens for scripts, `/v1` and MCP clients (#574). Same format
 * and scope names as owner tokens (`flo_v1_…`), sent only as
 * `Authorization: Bearer`. Only the SHA-256 digest is stored; the token is
 * shown once. A token never gives more than its person may do.
 */

/** New tokens expire after one year unless a shorter time is chosen. */
export const DEFAULT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

const BEARER = /^Bearer[ \t]+(flo_v1_[A-Za-z0-9_-]{43})[ \t]*$/i;

export function hasBearerToken(request: Request): boolean {
  return BEARER.test(request.headers.get('authorization') ?? '');
}

/** The person behind a request's API token, or `null` (unknown, revoked or expired token). */
export function resolveTokenPrincipal(request: Request, accounts: AccountsFile, now = Date.now()): AccountPrincipal | null {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (!match) return null;
  const provided = Buffer.from(tokenDigest(match[1]), 'hex');
  const token = accounts.apiTokens.find(candidate => timingSafeEqual(provided, Buffer.from(candidate.digest, 'hex')));
  if (!token || token.revokedAt !== null || token.issuedAt > now || token.expiresAt <= now) return null;
  return Object.freeze({
    kind: 'api-token', userId: token.userId, tokenId: token.id, scopes: Object.freeze([...token.scopes]),
    ...(token.workspaceId === undefined ? {} : { workspaceId: token.workspaceId }),
  });
}

export interface TokenRequest {
  readonly userId: string;
  readonly scopes: readonly AccountTokenScope[];
  readonly label?: string;
  readonly expiresAt?: number;
  readonly workspaceId?: string;
}

/** Make a new token. The plain token is returned once; store only `record`. */
export function issueAccountToken(request: TokenRequest, now = Date.now()): { token: string; record: AccountApiToken } {
  const token = `flo_v1_${randomBytes(32).toString('base64url')}`;
  const scopes = ACCOUNT_TOKEN_SCOPES.filter(scope => request.scopes.includes(scope));
  const record = accountApiTokenSchema.parse({
    id: randomBytes(16).toString('hex'),
    userId: request.userId,
    ...(request.label ? { label: request.label } : {}),
    digest: tokenDigest(token),
    scopes,
    issuedAt: now,
    expiresAt: Math.min(request.expiresAt ?? now + DEFAULT_TOKEN_LIFETIME_MS, now + DEFAULT_TOKEN_LIFETIME_MS),
    revokedAt: null,
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
  });
  return { token, record };
}

/**
 * Owner policy tokens, copied to the first admin when multi-user mode is
 * turned on, so scripts and MCP clients keep working. Same id, digest, scopes,
 * times and workspace limit.
 */
export function ownerTokensFor(policy: OwnerPolicy, userId: string): AccountApiToken[] {
  return policy.credentials.map(credential => accountApiTokenSchema.parse({
    id: credential.id, userId, label: 'Copied owner token', digest: credential.digest,
    scopes: [...credential.scopes], issuedAt: credential.issuedAt, expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    ...(credential.workspaceId === undefined ? {} : { workspaceId: credential.workspaceId }),
  }));
}
