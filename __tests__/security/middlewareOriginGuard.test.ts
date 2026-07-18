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

// The internal /v1/chat/conversations/** control-plane (#143). Not part of the
// OpenAI spec; each of these has a dangerous local side effect (respond/approve
// = RCE, list = ID enumeration, PATCH = flip requireApproval, DELETE, debug/*,
// edit-state, breakpoints). They must be fail-closed like /api.
const V1_GUARDED_PATHS = [
  '/v1/chat/conversations',
  '/v1/chat/conversations/abc123/respond',
  '/v1/chat/conversations/abc123',
  '/v1/chat/conversations/abc123/cancel',
  '/v1/chat/conversations/abc123/debug/continue',
  '/v1/chat/conversations/abc123/debug/step',
  '/v1/chat/conversations/abc123/edit-state',
  '/v1/chat/conversations/abc123/breakpoints',
];

describe('middleware origin guard: blocks non-local /v1 conversations control-plane (#143)', () => {
  it.each(V1_GUARDED_PATHS)('403s a cross-origin (evil Origin) POST to %s', (p) => {
    const res = middleware(
      makeRequest(`http://localhost:4200${p}`, { host: 'localhost:4200', origin: 'http://evil.com', method: 'POST' })
    );
    expect(res.status).toBe(403);
  });

  it.each(V1_GUARDED_PATHS)('403s a rebound-Host (non-local Host) request to %s', (p) => {
    const res = middleware(makeRequest(`http://evil.com${p}`, { host: 'evil.com', method: 'POST' }));
    expect(res.status).toBe(403);
  });

  it('403s cross-origin GET /v1/chat/conversations (ID enumeration)', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/v1/chat/conversations', {
        host: 'localhost:4200',
        origin: 'http://evil.com',
      })
    );
    expect(res.status).toBe(403);
  });

  it('is fail-closed on a missing Host for a /v1 conversations route', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/v1/chat/conversations/abc123/respond', {
        origin: 'http://localhost:4200',
        method: 'POST',
      })
    );
    expect(res.status).toBe(403);
  });

  it('is fail-closed on an unparseable Origin for a /v1 conversations route', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/v1/chat/conversations/abc123/respond', {
        host: 'localhost:4200',
        origin: 'not-a-url',
        method: 'POST',
      })
    );
    expect(res.status).toBe(403);
  });
});

describe('middleware origin guard: allows legitimate local /v1 conversations requests (#143)', () => {
  it.each(V1_GUARDED_PATHS)('lets a localhost same-origin request to %s pass (not 403)', (p) => {
    const res = middleware(
      makeRequest(`http://localhost:4200${p}`, {
        host: 'localhost:4200',
        origin: 'http://localhost:4200',
        method: 'POST',
      })
    );
    expect(res.status).not.toBe(403);
  });

  it.each(V1_GUARDED_PATHS)('lets a native (no-Origin) localhost request to %s pass (not 403)', (p) => {
    const res = middleware(makeRequest(`http://localhost:4200${p}`, { host: 'localhost:4200', method: 'POST' }));
    expect(res.status).not.toBe(403);
  });
});

describe('middleware origin guard: public OpenAI /v1 surface stays reachable (#143)', () => {
  const PUBLIC_OPENAI_PATHS = ['/v1/chat/completions', '/v1/models'];

  it.each(PUBLIC_OPENAI_PATHS)('lets a cross-origin (evil Origin) request reach %s (not 403)', (p) => {
    const res = middleware(
      makeRequest(`http://evil.com${p}`, { host: 'evil.com', origin: 'http://evil.com', method: 'POST' })
    );
    expect(res.status).not.toBe(403);
  });

  it('does not treat a sibling of the OpenAI allow-list as public', () => {
    const res = middleware(
      makeRequest('http://localhost:4200/v1/models-evil', { host: 'localhost:4200', origin: 'http://evil.com' })
    );
    expect(res.status).toBe(403);
  });
});

describe('middleware matcher scope', () => {
  it('is scoped to /api/:path* and /v1/:path*', () => {
    expect(config.matcher).toContain('/api/:path*');
    expect(config.matcher).toContain('/v1/:path*');
  });
});
