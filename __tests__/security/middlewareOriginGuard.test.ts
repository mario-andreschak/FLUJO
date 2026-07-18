/**
 * Middleware-level tests for the fail-closed origin guard (#142).
 *
 * `src/middleware.ts` runs `isLocalRequest` against every `/api/:path*` request
 * and returns 403 by default. These tests exercise the middleware directly (no
 * route handlers) and prove:
 *   - previously-forgotten / newly-covered sensitive routes are blocked
 *     cross-origin (the #131/#139/#141 history + the #142 gaps),
 *   - localhost same-origin and native (no-Origin) requests still pass,
 *   - the explicit public allow-list (webhooks / oauth) stays reachable from a
 *     non-local origin.
 */

import { NextRequest } from 'next/server';
import { middleware, config } from '@/middleware';

/** Build a NextRequest with the given host/origin/method headers. */
const makeRequest = (
  url: string,
  { host, origin, method = 'GET' }: { host?: string; origin?: string; method?: string } = {}
): NextRequest => {
  const headers: Record<string, string> = {};
  if (host) headers.host = host;
  if (origin) headers.origin = origin;
  return new NextRequest(url, { method, headers });
};

// Routes that must be fail-closed: the #142 gaps + a representative sample of
// the routes the #131/#139/#141 rounds each forgot.
const GUARDED_PATHS = [
  '/api/encryption/secure', // #142 gap (secrets)
  '/api/local-models/pull', // #142 gap (arbitrary model download DoS)
  '/api/local-models/capability', // #142 gap (spawns hardware probes)
  '/api/local-models/suggest', // #142 gap
  '/api/update', // #139
  '/api/git', // #131
  '/api/env', // #141 (returns decrypted secrets)
  '/api/mcp/servers', // #141
  // A route that never had an inline guard at all — proves fail-closed default.
  '/api/storage',
];

describe('middleware origin guard: blocks non-local requests', () => {
  it.each(GUARDED_PATHS)('403s a cross-origin (evil Origin) request to %s', (p) => {
    const res = middleware(
      makeRequest(`http://localhost:4200${p}`, { host: 'localhost:4200', origin: 'http://evil.com' })
    );
    expect(res.status).toBe(403);
  });

  it.each(GUARDED_PATHS)('403s a non-local Host request to %s', (p) => {
    const res = middleware(makeRequest(`http://evil.com${p}`, { host: 'evil.com' }));
    expect(res.status).toBe(403);
  });
});

describe('middleware origin guard: allows legitimate local requests', () => {
  it.each(GUARDED_PATHS)('lets a localhost same-origin request to %s pass (not 403)', (p) => {
    const res = middleware(
      makeRequest(`http://localhost:4200${p}`, { host: 'localhost:4200', origin: 'http://localhost:4200' })
    );
    expect(res.status).not.toBe(403);
  });

  it.each(GUARDED_PATHS)('lets a native (no-Origin) localhost request to %s pass (not 403)', (p) => {
    const res = middleware(makeRequest(`http://localhost:4200${p}`, { host: 'localhost:4200' }));
    expect(res.status).not.toBe(403);
  });

  it('accepts 127.0.0.1 and [::1] hosts', () => {
    expect(middleware(makeRequest('http://127.0.0.1:4200/api/storage', { host: '127.0.0.1:4200' })).status).not.toBe(403);
    expect(middleware(makeRequest('http://[::1]:4200/api/storage', { host: '[::1]:4200' })).status).not.toBe(403);
  });
});

describe('middleware origin guard: public allow-list stays reachable', () => {
  const PUBLIC_PATHS = [
    '/api/webhooks/abc123',
    '/api/oauth/callback',
    '/api/oauth/initiate',
    '/api/oauth/reset',
  ];

  it.each(PUBLIC_PATHS)('lets a non-local Origin reach %s (not 403)', (p) => {
    const res = middleware(makeRequest(`http://evil.com${p}`, { host: 'evil.com', origin: 'http://evil.com' }));
    expect(res.status).not.toBe(403);
  });

  it('does not open a sibling of an exact allow-list entry', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/api/oauth/callback-evil', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('middleware origin guard: OPTIONS preflight passes', () => {
  it('lets a cross-origin OPTIONS preflight through for a guarded route', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/api/git', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
        method: 'OPTIONS',
      })
    );
    expect(res.status).not.toBe(403);
  });
});

describe('middleware matcher scope', () => {
  it('is scoped to /api/:path*', () => {
    expect(config.matcher).toContain('/api/:path*');
  });
});
