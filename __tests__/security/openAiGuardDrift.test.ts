/**
 * Static drift test for the fail-closed origin guard's `/v1` extension (#143).
 *
 * #143 extends the secure-by-default middleware matcher to `/v1/:path*` and
 * declares an explicit, narrow allow-list of the genuinely-public OpenAI surface
 * (`/v1/chat/completions`, `/v1/models`). Everything else under `/v1` — notably
 * the internal `/v1/chat/conversations/**` control-plane — is fail-closed. This
 * test locks that in by construction so a future `/v1` route cannot silently
 * regress:
 *
 *   1. The set of PUBLIC `/v1` routes (per `isPublicOpenAiPath`) exactly equals a
 *      reviewed snapshot — a new sensitive `/v1` route cannot be made public by
 *      accident, and no `/v1/chat/conversations/**` route is ever public.
 *   2. Every `PUBLIC_OPENAI_EXACT_PATHS` entry maps to a real route file.
 *   3. The highest-risk conversation "crown-jewel" handlers still carry their
 *      in-handler `assertLocalRequest` (defense-in-depth is not removed).
 */

import fs from 'fs';
import path from 'path';
import {
  isPublicOpenAiPath,
  PUBLIC_OPENAI_EXACT_PATHS,
} from '@/utils/http/publicApiAllowlist';

const V1_ROOT = path.join(process.cwd(), 'src', 'app', 'v1');

/** Recursively collect every `route.ts` under `src/app/v1`. */
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

/** Map a route.ts file path to its URL pathname, e.g. `.../v1/models/route.ts` -> `/v1/models`. */
function pathnameOf(routeFile: string): string {
  const rel = path.relative(path.join(process.cwd(), 'src', 'app'), path.dirname(routeFile));
  return '/' + rel.split(path.sep).join('/');
}

const routeFiles = collectRouteFiles(V1_ROOT);
const routePathnames = routeFiles.map(pathnameOf);

describe('/v1 openai guard drift (#143)', () => {
  it('finds the /v1 route files', () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it('has a /v1 prefix on every discovered route (so the matcher covers it)', () => {
    for (const p of routePathnames) {
      expect(p.startsWith('/v1/')).toBe(true);
    }
  });

  // The reviewed set of intentionally-public /v1 (OpenAI-compatible) routes.
  // Changing this array is a deliberate security decision that must show up in
  // the diff/review.
  const EXPECTED_PUBLIC_OPENAI_ROUTES = ['/v1/chat/completions', '/v1/models'].sort();

  it('the set of public /v1 routes equals the reviewed snapshot', () => {
    const actualPublic = routePathnames.filter((p) => isPublicOpenAiPath(p)).sort();
    expect(actualPublic).toEqual(EXPECTED_PUBLIC_OPENAI_ROUTES);
  });

  it('never treats a /v1/chat/conversations/** route as public', () => {
    const conversationRoutes = routePathnames.filter((p) => p.startsWith('/v1/chat/conversations'));
    expect(conversationRoutes.length).toBeGreaterThan(0);
    for (const p of conversationRoutes) {
      expect(isPublicOpenAiPath(p)).toBe(false);
    }
  });

  it('every public-OpenAI allow-list entry maps to a real route file', () => {
    for (const entry of PUBLIC_OPENAI_EXACT_PATHS) {
      expect(routePathnames).toContain(entry);
    }
  });

  // Internal conversation control-plane sinks that MUST keep an in-handler
  // `assertLocalRequest` as defense-in-depth even though middleware now guards
  // them centrally.
  const CONVERSATION_CROWN_JEWELS = [
    'v1/chat/conversations',
    'v1/chat/conversations/[conversationId]',
    'v1/chat/conversations/[conversationId]/respond',
    'v1/chat/conversations/[conversationId]/cancel',
    'v1/chat/conversations/[conversationId]/debug/continue',
    'v1/chat/conversations/[conversationId]/debug/step',
    'v1/chat/conversations/[conversationId]/edit-state',
    'v1/chat/conversations/[conversationId]/breakpoints',
  ];

  it.each(CONVERSATION_CROWN_JEWELS)('%s still calls assertLocalRequest (defense-in-depth)', (routeDir) => {
    const file = path.join(process.cwd(), 'src', 'app', ...routeDir.split('/'), 'route.ts');
    expect(fs.existsSync(file)).toBe(true);
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/assertLocalRequest/);
  });
});
