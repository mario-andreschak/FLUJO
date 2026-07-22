/**
 * Static drift test for the fail-closed origin guard (#142).
 *
 * The whole point of #142 is that enforcement is now SECURE-BY-DEFAULT: the
 * `src/middleware.ts` matcher (`/api/:path*`) guards every `/api` route, and only
 * the explicit `publicApiAllowlist.ts` entries are public. This test locks that
 * in by construction so a future route cannot silently regress:
 *
 *   1. The middleware matcher still covers `/api/:path*`.
 *   2. The set of PUBLIC `/api` routes (per `isPublicApiPath`) exactly equals a
 *      reviewed snapshot — a new sensitive route cannot be made public by
 *      accident, and a stale allow-list entry cannot silently open nothing.
 *   3. Every allow-list entry maps to a real route file.
 *   4. The highest-risk "crown-jewel" sinks still carry their in-handler
 *      `assertLocalRequest` (defense-in-depth is not removed).
 *
 * The test PASSES on the current tree and FAILS if (a) the matcher is weakened,
 * (b) the public set drifts from the reviewed snapshot, or (c) a defense-in-depth
 * guard is dropped from a crown-jewel route.
 */

import fs from 'fs';
import path from 'path';
import { config as middlewareConfig } from '@/middleware';
import {
  isPublicApiPath,
  PUBLIC_API_EXACT_PATHS,
  PUBLIC_API_PREFIXES,
} from '@/utils/http/publicApiAllowlist';

const API_ROOT = path.join(process.cwd(), 'src', 'app', 'api');

/** Recursively collect every `route.ts` under `src/app/api`. */
function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRouteFiles(full));
    } else if (entry.isFile() && entry.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

/** Map a route.ts file path to its URL pathname, e.g. `.../api/git/route.ts` -> `/api/git`. */
function pathnameOf(routeFile: string): string {
  const rel = path.relative(path.join(process.cwd(), 'src', 'app'), path.dirname(routeFile));
  return '/' + rel.split(path.sep).join('/');
}

const routeFiles = collectRouteFiles(API_ROOT);
const routePathnames = routeFiles.map(pathnameOf);

describe('route guard drift', () => {
  it('finds the /api route files', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it('keeps the middleware matcher scoped to /api/:path* and /v1/:path* (fail-closed default)', () => {
    expect(middlewareConfig.matcher).toContain('/api/:path*');
    expect(middlewareConfig.matcher).toContain('/v1/:path*');
  });

  it('has an /api prefix on every discovered route (so the matcher covers it)', () => {
    for (const p of routePathnames) {
      expect(p.startsWith('/api/')).toBe(true);
    }
  });

  // The reviewed set of intentionally-public routes. Changing this array is a
  // deliberate security decision that must show up in the diff/review.
  const EXPECTED_PUBLIC_ROUTES = [
    '/api/oauth/callback',
    '/api/oauth/initiate',
    '/api/oauth/reset',
    '/api/registry/oauth/callback',
    '/api/webhooks/[id]',
  ].sort();

  it('the set of public /api routes equals the reviewed snapshot', () => {
    const actualPublic = routePathnames.filter((p) => isPublicApiPath(p)).sort();
    expect(actualPublic).toEqual(EXPECTED_PUBLIC_ROUTES);
  });

  it('every exact allow-list entry maps to a real route file', () => {
    for (const entry of PUBLIC_API_EXACT_PATHS) {
      expect(routePathnames).toContain(entry);
    }
  });

  it('every allow-list prefix covers at least one real route file', () => {
    for (const prefix of PUBLIC_API_PREFIXES) {
      const covered = routePathnames.some((p) => p.startsWith(prefix));
      expect(covered).toBe(true);
    }
  });

  // Command-execution / secret-return sinks that MUST keep an in-handler
  // `assertLocalRequest` as defense-in-depth even though middleware now guards
  // them centrally.
  const CROWN_JEWELS = [
    'api/backup',
    'api/browse',
    'api/cwd',
    'api/env',
    'api/git',
    'api/restore',
    'api/update',
    'api/encryption/secure',
    'api/mcp/servers',
    'api/mcp/servers/[name]',
    'api/mcp/test-connection',
    'api/mcp/test-connection/stream',
  ];

  it.each(CROWN_JEWELS)('%s still calls assertLocalRequest (defense-in-depth)', (routeDir) => {
    const file = path.join(process.cwd(), 'src', 'app', ...routeDir.split('/'), 'route.ts');
    expect(fs.existsSync(file)).toBe(true);
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/assertLocalRequest/);
  });
});
