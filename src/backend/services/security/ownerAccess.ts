import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import {
  authenticateOwnerBearer, ownerHasScopes, ownerPolicySchema, type OwnerScope,
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
  if (pathname === '/mcp-flows' || pathname.startsWith('/mcp-flows/')
      || pathname === '/mcp-proxy' || pathname.startsWith('/mcp-proxy/')) {
    return ['mcp:access', 'control:admin', 'secrets:read'];
  }
  // Config, exports, approvals, process/FS operations and unknown new endpoints
  // remain conservative until individual handler capabilities are classified.
  return ['control:admin', 'secrets:read'];
}

function readOwnerPolicy(filename: string) {
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

/** Re-read durable revocation on every request; never rely on proxy globals. */
export function assertOwnerRequest(request: Request): Response | null {
  const configured = process.env.FLUJO_OWNER_AUTH_FILE;
  // Explicitly configured-but-empty is an error, not anonymous fallback.
  if (configured === undefined) return null;
  let policy;
  try {
    policy = readOwnerPolicy(configured.trim());
  } catch {
    return Response.json({ error: 'Owner authentication is unavailable.', code: 'OWNER_AUTH_UNAVAILABLE' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (isOwnerProtocolException(request)) return null;
  const principal = authenticateOwnerBearer(request, policy);
  if (!principal) return Response.json({ error: 'Unauthorized' }, {
    status: 401, headers: { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' },
  });
  if (!ownerHasScopes(principal, requiredOwnerScopes(request))) return Response.json({ error: 'Forbidden' }, {
    status: 403, headers: { 'Cache-Control': 'no-store' },
  });
  return null;
}
