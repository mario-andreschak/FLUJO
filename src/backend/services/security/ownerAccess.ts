import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  authenticateOwnerBearer, ownerHasScopes, ownerPolicySchema, type OwnerScope, type OwnerPolicy, type OwnerPrincipal,
} from './ownerCredentials';

export const MAX_OWNER_POLICY_BYTES = 64 * 1024;

/** These handlers already enforce the dedicated snapshot bearer, independently. */
const SNAPSHOT_METHODS: Readonly<Record<string, string>> = {
  '/api/snapshot/abort': 'POST', '/api/snapshot/begin': 'POST',
  '/api/snapshot/download': 'GET', '/api/snapshot/finalize': 'POST',
  '/api/snapshot/info': 'GET', '/api/snapshot/status': 'GET',
};

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
}

/** Protocol exceptions are narrower than the historical Origin allowlist. */
export function isOwnerProtocolException(request: Request): boolean {
  const pathname = normalizePath(new URL(request.url).pathname);
  return (pathname === '/api/oauth/callback' && ['GET', 'POST'].includes(request.method))
    || (pathname === '/api/registry/oauth/callback' && request.method === 'GET')
    || (request.method === 'POST' && /^\/api\/webhooks\/[^/]+$/.test(pathname))
    || SNAPSHOT_METHODS[pathname] === request.method;
}

export function requiredOwnerScopes(request: Request): readonly OwnerScope[] {
  const pathname = normalizePath(new URL(request.url).pathname);
  if (pathname === '/v1/models' && request.method === 'GET') return ['openai:read'];
  if (pathname === '/v1/chat/completions' && ['GET', 'POST'].includes(request.method)) return ['openai:execute'];
  if (/^\/api\/avatar\/remote\/native-(?:turn|input|observe|played|reset|result|result-receipt)$/.test(pathname)
      && request.method === 'POST') return ['avatar:voice'];
  if (pathname === '/api/avatar/remote/availability' && request.method === 'GET') return ['avatar:voice'];
  if (pathname === '/mcp-flows' || pathname.startsWith('/mcp-flows/')
      || pathname === '/mcp-proxy' || pathname.startsWith('/mcp-proxy/')) {
    return ['mcp:access', 'control:admin', 'secrets:read'];
  }
  // Config, exports, approvals, process/FS operations and unknown new endpoints
  // remain conservative until individual handler capabilities are classified.
  return ['control:admin', 'secrets:read'];
}

function readOwnerPolicy(filename: string): OwnerPolicy {
  if (!path.isAbsolute(filename)) throw new Error('Invalid owner policy path');
  const fd = openSync(filename, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_POLICY_BYTES
        || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Invalid owner policy file');
    }
    const bytes = Buffer.alloc(MAX_OWNER_POLICY_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_OWNER_POLICY_BYTES) throw new Error('Owner policy too large');
    return ownerPolicySchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
  } finally {
    closeSync(fd);
  }
}

export interface AuthenticatedOwnerPrincipal extends OwnerPrincipal {
  readonly policyRevision: string;
  readonly expiresAt: number;
}

export interface OwnerRequestAuthorization {
  readonly principal: AuthenticatedOwnerPrincipal;
  /** Re-read durable policy before each effect and during streams; no bearer retained. */
  recheck(now?: number): Response | null;
}

export type OwnerRequestResolution =
  | { readonly ok: true; readonly authorization: OwnerRequestAuthorization }
  | { readonly ok: false; readonly response: Response };

function unavailable(): Response {
  return Response.json({ error: 'Owner authentication is unavailable.', code: 'OWNER_AUTH_UNAVAILABLE' }, {
    status: 503, headers: { 'Cache-Control': 'no-store' },
  });
}

function unauthorized(): Response {
  return Response.json({ error: 'Unauthorized' }, {
    status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
  });
}

function forbidden(): Response {
  return Response.json({ error: 'Forbidden' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}

function revision(policy: OwnerPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

function authorize(request: Request, policy: OwnerPolicy, filename: string,
  scopes: readonly OwnerScope[], requireWorkspace: boolean, now: number): OwnerRequestResolution {
  const authenticated = authenticateOwnerBearer(request, policy, now);
  if (!authenticated) return { ok: false, response: unauthorized() };
  if (!ownerHasScopes(authenticated, scopes) || (requireWorkspace && !authenticated.workspaceId)) {
    return { ok: false, response: forbidden() };
  }
  const record = policy.credentials.find(value => value.id === authenticated.credentialId)!;
  const credentialDigest = record.digest;
  const principal: AuthenticatedOwnerPrincipal = Object.freeze({ ...authenticated,
    policyRevision: revision(policy), expiresAt: record.expiresAt });
  const authorization: OwnerRequestAuthorization = Object.freeze({ principal, recheck: (at = Date.now()) => {
    // A policy path/configuration switch revokes existing witnesses as well.
    const configured = process.env.FLUJO_OWNER_AUTH_FILE;
    if (configured === undefined || configured.trim() !== filename) return unavailable();
    let current: OwnerPolicy;
    try { current = readOwnerPolicy(filename); } catch { return unavailable(); }
    if (!Number.isSafeInteger(at) || at < 0 || current.ownerId !== principal.ownerId
        || revision(current) !== principal.policyRevision) return unauthorized();
    const active = current.credentials.find(value => value.id === principal.credentialId);
    if (!active || active.digest !== credentialDigest || active.revokedAt !== null
        || active.issuedAt > at || active.expiresAt <= at
        || active.workspaceId !== principal.workspaceId) return unauthorized();
    return ownerHasScopes(principal, scopes) ? null : forbidden();
  } });
  return { ok: true, authorization };
}

/**
 * Strict handler seam: absent policy denies, protocol exceptions do not apply,
 * identity/workspace come only from the private policy, never request claims.
 * Call before reading a body or selecting storage. The handler must additionally
 * validate workspace existence, allowed Origin, and its own provider/effect fences.
 */
export function resolveOwnerRequest(request: Request, scopes: readonly OwnerScope[] = requiredOwnerScopes(request),
  options: { requireWorkspace?: boolean; now?: number } = {}): OwnerRequestResolution {
  const configured = process.env.FLUJO_OWNER_AUTH_FILE;
  if (configured === undefined) return { ok: false, response: unavailable() };
  const filename = configured.trim();
  let policy: OwnerPolicy;
  try { policy = readOwnerPolicy(filename); } catch { return { ok: false, response: unavailable() }; }
  return authorize(request, policy, filename, [...scopes], options.requireWorkspace === true || scopes.includes('avatar:voice'),
    options.now ?? Date.now());
}

/** Re-read durable revocation on every request; never rely on proxy globals. */
export function assertOwnerRequest(request: Request): Response | null {
  const configured = process.env.FLUJO_OWNER_AUTH_FILE;
  // Explicitly configured-but-empty is an error, not anonymous fallback.
  if (configured === undefined) return null;
  let policy;
  try {
    policy = readOwnerPolicy(configured.trim());
  } catch {
    return unavailable();
  }
  if (isOwnerProtocolException(request)) return null;
  const scopes = requiredOwnerScopes(request);
  const result = authorize(request, policy, configured.trim(), scopes, scopes.includes('avatar:voice'), Date.now());
  return result.ok ? null : result.response;
}
