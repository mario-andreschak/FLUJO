import fs from 'node:fs';
import path from 'node:path';
import {
  ROUTE_CAPABILITIES, SIGNED_OUT_ROUTES, WORKSPACE_ADMIN_ROUTES, WORKSPACE_ADMIN_STEPS,
  routeCapabilityFor, routePatternFor, type RoutePattern,
} from '@/backend/services/accounts/routeCapabilities';
import { decideRouteAccess } from '@/backend/services/accounts/access';
import { isOwnerProtocolException } from '@/backend/services/security/ownerAccess';
import { ROUTE_KINDS, type AccountPrincipal } from '@/shared/types/accounts';
import { NOW, accountsFixture, people } from './fixtures';

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;

function collectRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(full);
    return entry.isFile() && entry.name === 'route.ts' ? [full] : [];
  });
}

function patternOf(file: string): string {
  return `/${path.relative(APP_ROOT, path.dirname(file)).split(path.sep).join('/')}`;
}

function exportedMethods(source: string): string[] {
  return METHODS.filter(method => new RegExp(
    `export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`,
  ).test(source));
}

const routeFiles = collectRouteFiles(APP_ROOT);
const routes = routeFiles.map(file => ({
  pattern: patternOf(file),
  source: fs.readFileSync(file, 'utf8'),
}));
const mapped = Object.keys(ROUTE_CAPABILITIES) as RoutePattern[];
const kindOf = (pattern: string) => ROUTE_CAPABILITIES[pattern as RoutePattern];
const sample = (pattern: string) => pattern.replace(/\[[^\]]+\]/g, 'sample-value');

describe('route capability map', () => {
  it('gives every route exactly one kind', () => {
    const missing = routes.map(route => route.pattern).filter(pattern => !(pattern in ROUTE_CAPABILITIES));
    if (missing.length > 0) {
      throw new Error(`Add these routes to ROUTE_CAPABILITIES in src/backend/services/accounts/routeCapabilities.ts `
        + `with one of ${ROUTE_KINDS.join(', ')} (see ROUTE_KINDS in src/shared/types/accounts.ts):\n${missing.join('\n')}`);
    }
    for (const pattern of mapped) expect(ROUTE_KINDS).toContain(kindOf(pattern));
  });

  it('lists no route that no longer exists', () => {
    const existing = new Set(routes.map(route => route.pattern));
    const stale = mapped.filter(pattern => !existing.has(pattern));
    if (stale.length > 0) {
      throw new Error(`Remove these routes from ROUTE_CAPABILITIES; their route.ts is gone:\n${stale.join('\n')}`);
    }
    expect(mapped).toHaveLength(routes.length);
  });

  it('uses only plain [param] segments, which routePatternFor understands', () => {
    const unsupported = mapped.filter(pattern => pattern.split('/').slice(1)
      .some(segment => /^[([@]/.test(segment) && !/^\[[A-Za-z][A-Za-z0-9]*\]$/.test(segment)));
    if (unsupported.length > 0) {
      throw new Error('Catch-all, optional, group or parallel route folders need support in routePatternFor '
        + `(src/backend/services/accounts/routeCapabilities.ts) before they can be listed:\n${unsupported.join('\n')}`);
    }
  });

  it('finds each route again from a real request path', () => {
    for (const pattern of mapped) expect(routePatternFor(sample(pattern))).toBe(pattern);
  });

  it('prefers a fixed path over a [param] path, like Next.js', () => {
    expect(routePatternFor('/api/flow/assist')).toBe('/api/flow/assist');
    expect(routePatternFor('/api/flow/abc123')).toBe('/api/flow/[id]');
    expect(routePatternFor('/v1/personas/readiness')).toBe('/v1/personas/readiness');
    expect(routePatternFor('/v1/personas/p-1')).toBe('/v1/personas/[personaId]');
    expect(routePatternFor('/api/mcp/servers/x/tools/y/stream')).toBe('/api/mcp/servers/[name]/tools/[toolName]/stream');
    expect(routePatternFor('/api/webhooks/mcp')).toBe('/api/webhooks/[id]');
    expect(routePatternFor('/api/flow/')).toBe('/api/flow');
    expect(routePatternFor('/api//flow')).toBeUndefined();
    expect(routePatternFor('/api/no-such-route')).toBeUndefined();
    expect(routePatternFor('/')).toBeUndefined();
  });

  it('keeps installation-wide routes out of the workspace kind', () => {
    const installationWide = routes.filter(route => route.source.includes('FLUJO_INSTALLATION_WIDE_ROUTE:'));
    expect(installationWide.length).toBeGreaterThan(0);
    for (const route of installationWide) expect([route.pattern, kindOf(route.pattern)]).not.toEqual([route.pattern, 'workspace']);
  });

  it('keeps routes that start programs on the server out of reach of ordinary members', () => {
    const starters = routes.filter(route => /from ['"](?:node:)?child_process['"]/.test(route.source));
    expect(starters.length).toBeGreaterThan(0);
    for (const route of starters) expect([route.pattern, ['host', 'admin'].includes(kindOf(route.pattern))]).toEqual([route.pattern, true]);
  });

  it('marks every owner-policy protocol exception as a protocol route', () => {
    for (const route of routes) {
      for (const method of exportedMethods(route.source)) {
        const request = new Request(`http://localhost${sample(route.pattern)}`, { method });
        if (isOwnerProtocolException(request)) expect([route.pattern, kindOf(route.pattern)]).toEqual([route.pattern, 'protocol']);
      }
    }
  });

  it('keeps the special lists consistent with the kinds', () => {
    for (const pattern of SIGNED_OUT_ROUTES) expect([pattern, kindOf(pattern)]).toEqual([pattern, 'account']);
    for (const pattern of WORKSPACE_ADMIN_ROUTES) expect([pattern, kindOf(pattern)]).toEqual([pattern, 'workspace']);
    for (const { route } of WORKSPACE_ADMIN_STEPS) expect(mapped).toContain(route);
  });

  it('derives the workspace action from the method and the admin list', () => {
    expect(routeCapabilityFor('/api/flow/f1', 'GET')).toMatchObject({ pattern: '/api/flow/[id]', kind: 'workspace', workspaceAction: 'read' });
    expect(routeCapabilityFor('/api/flow/f1', 'DELETE')).toMatchObject({ workspaceAction: 'edit' });
    expect(routeCapabilityFor('/api/backup', 'POST')).toMatchObject({ kind: 'workspace', workspaceAction: 'admin' });
    expect(routeCapabilityFor('/api/credential-migration', 'GET')).toMatchObject({ workspaceAction: 'read' });
    expect(routeCapabilityFor('/api/credential-migration', 'POST')).toMatchObject({ workspaceAction: 'admin' });
    expect(routeCapabilityFor('/api/owner/session', 'POST')).toMatchObject({ kind: 'account', signedOutAllowed: true });
    expect(routeCapabilityFor('/api/workspaces', 'GET')).toMatchObject({ kind: 'account', signedOutAllowed: false });
    expect(routeCapabilityFor('/api/browse', 'GET')).toMatchObject({ kind: 'host' });
    expect(routeCapabilityFor('/api/update', 'POST')).toMatchObject({ kind: 'admin' });
    expect(routeCapabilityFor('/api/no-such-route', 'GET')).toBeUndefined();
  });
});

describe('route capability map with the access rules (two people)', () => {
  const accounts = accountsFixture();
  const decide = (principal: AccountPrincipal | null, pattern: RoutePattern, method: string, workspace: string | null) => {
    const capability = routeCapabilityFor(sample(pattern), method)!;
    return decideRouteAccess(accounts, principal, {
      kind: capability.kind, workspace, workspaceAction: capability.workspaceAction,
      signedOutAllowed: capability.signedOutAllowed,
    }, NOW);
  };
  const everyRequest = routes.flatMap(route => exportedMethods(route.source)
    .map(method => ({ pattern: route.pattern as RoutePattern, method })));

  it('changes nothing while multi-user mode is off', () => {
    for (const file of [null, accountsFixture({ enabled: false })]) {
      for (const { pattern, method } of everyRequest) {
        const capability = routeCapabilityFor(sample(pattern), method)!;
        expect(decideRouteAccess(file, null, {
          kind: capability.kind, workspace: 'loose-ws', workspaceAction: capability.workspaceAction,
        }, NOW)).toEqual({ allowed: true, grant: 'multi-user-off' });
      }
    }
  });

  it('answers 404 when one person calls any workspace or host route on another person\'s workspace', () => {
    for (const { pattern, method } of everyRequest) {
      if (!['workspace', 'host'].includes(kindOf(pattern))) continue;
      expect([pattern, method, decide(people.ben, pattern, method, 'anna-ws')])
        .toEqual([pattern, method, { allowed: false, denial: 'not-found', status: 404 }]);
      expect([pattern, method, decide(people.anna, pattern, method, 'ben-ws')])
        .toEqual([pattern, method, { allowed: false, denial: 'not-found', status: 404 }]);
    }
  });

  it('lets each person use workspace routes in their own workspace, and asks for sign-in otherwise', () => {
    for (const { pattern, method } of everyRequest) {
      if (kindOf(pattern) !== 'workspace') continue;
      expect([pattern, method, decide(people.anna, pattern, method, 'anna-ws').allowed]).toEqual([pattern, method, true]);
      expect([pattern, method, decide(null, pattern, method, 'anna-ws')])
        .toEqual([pattern, method, { allowed: false, denial: 'sign-in-required', status: 401 }]);
    }
  });

  it('keeps host and admin routes from members without those rights', () => {
    for (const { pattern, method } of everyRequest) {
      const kind = kindOf(pattern);
      if (kind === 'host') expect(decide(people.anna, pattern, method, 'anna-ws')).toMatchObject({ denial: 'host-access-required' });
      if (kind === 'admin') expect(decide(people.anna, pattern, method, null)).toMatchObject({ denial: 'admin-required' });
      if (kind === 'protocol') expect(decide(null, pattern, method, null)).toEqual({ allowed: true, grant: 'own-check' });
    }
  });
});
