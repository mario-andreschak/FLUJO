import fs from 'node:fs';
import path from 'node:path';
import { assertOwnerRequest, isOwnerProtocolException, resolveOwnerRequest } from '@/backend/services/security/ownerAccess';
import { ACCESS_ROUTE_TABLE, classifyAccessRoute } from '@/backend/services/security/accessRoutes';
import { issueOwnerCredential } from '@/backend/services/security/ownerCredentials';
import { ownerCredentialRevision, ownerPolicyRevision } from '@/backend/services/security/ownerPolicy';
import { bindOwnerStream } from '@/backend/services/security/ownerStream';
import { ACCESS_ROLES } from '@/shared/types/access';
import { config as proxyConfig } from '@/proxy';
import { bearer, createNamedAccessFixture, type NamedAccessFixture } from './fixtures/namedAccess';

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function routeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === 'route.ts' ? [full] : [];
  });
}

const templateOf = (file: string) => `/${path.relative(APP_ROOT, path.dirname(file)).split(path.sep).join('/')}`;
const methodsOf = (source: string) => METHODS.filter(method =>
  new RegExp(`export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`).test(source));
const concrete = (template: string) => template.replace(/\[\.{0,3}[^\]]+\]/g, 'probe-id');

const ROUTES = routeFiles(APP_ROOT).map(file => {
  const source = fs.readFileSync(file, 'utf8');
  return { file, template: templateOf(file), source, methods: methodsOf(source) };
});

let fixture: NamedAccessFixture;
beforeEach(() => {
  fixture = createNamedAccessFixture({
    admin: 'admin', builder: 'builder', operator: 'operator', viewer: 'viewer', health: 'health', maintainer: 'maintainer',
  });
});
afterEach(() => fixture.restore());

describe('every route is reachable only on purpose', () => {
  it('finds the routes and the proxy guards every one of their prefixes', () => {
    expect(ROUTES.length).toBeGreaterThan(200);
    const prefixes = new Set(ROUTES.map(route => route.template.split('/')[1]));
    // A route outside these prefixes would sit outside the proxy, and outside every role.
    expect([...prefixes].sort()).toEqual(['api', 'mcp-flows', 'mcp-proxy', 'v1']);
    expect(proxyConfig.matcher).toEqual(expect.arrayContaining(['/api/:path*', '/v1/:path*', '/mcp-proxy/:path*', '/mcp-flows/:path*']));
  });

  it('points every table entry at a real route that really exports that method', () => {
    for (const rule of ACCESS_ROUTE_TABLE) {
      const route = ROUTES.find(candidate => candidate.template === rule.template);
      expect({ rule: `${rule.method} ${rule.template}`, found: Boolean(route) }).toEqual({ rule: `${rule.method} ${rule.template}`, found: true });
      expect(route!.methods).toContain(rule.method);
    }
  });

  it('checks a named row only on routes that go through the workspace wrapper', () => {
    for (const rule of ACCESS_ROUTE_TABLE.filter(item => item.row === 'conversation' || item.row === 'approval')) {
      const route = ROUTES.find(candidate => candidate.template === rule.template)!;
      expect({ template: rule.template, wrapped: route.source.includes('withWorkspaceRoute') })
        .toEqual({ template: rule.template, wrapped: true });
    }
  });

  it('keeps every conversation sub-route in the wrapper, so the row check cannot be skipped', () => {
    for (const route of ROUTES.filter(item => item.template.startsWith('/v1/chat/conversations/'))) {
      expect({ template: route.template, wrapped: route.source.includes('withWorkspaceRoute') })
        .toEqual({ template: route.template, wrapped: true });
    }
  });

  it.each(['builder', 'operator', 'viewer', 'health', 'maintainer'])('refuses %s on every route family outside its table entries', role => {
    const scopes = fixture.read().credentials.find(item => item.name === role)!.scopes;
    const leaks: string[] = [];
    for (const route of ROUTES) {
      for (const method of route.methods) {
        const url = `http://localhost:4200${concrete(route.template)}`;
        const request = bearer(fixture.tokens[role], url, { method });
        if (isOwnerProtocolException(request)) continue;
        const denied = assertOwnerRequest(request);
        const allowedByTable = classifyAccessRoute(method, new URL(url).pathname)?.anyOf.some(scope => scopes.includes(scope)) ?? false;
        const allowedByExactRow = (route.template === '/v1/models' && method === 'GET' && scopes.includes('openai:read'))
          || (route.template === '/v1/chat/completions' && scopes.includes('openai:execute'));
        const admitted = denied === null;
        if (admitted !== (allowedByTable || allowedByExactRow)) leaks.push(`${method} ${route.template} -> ${admitted}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('never lets a non-administrator reach the dangerous families', () => {
    const dangerous = ['/api/git', '/api/backup', '/api/restore', '/api/browse', '/api/env', '/api/encryption',
      '/api/mcp/servers/probe-id', '/api/planned-executions', '/api/credential-transfer', '/mcp-proxy/probe-id', '/mcp-flows',
      '/v1/chat/events', '/v1/chat/conversation-chains', '/v1/chat/conversations/probe-id/edit-state',
      '/v1/chat/conversations/probe-id/inject', '/v1/chat/conversations/probe-id/revert', '/v1/chat/conversations/probe-id/debug/state',
      '/v1/chat/conversations/probe-id/model-turns'];
    for (const role of ['builder', 'operator', 'viewer', 'health', 'maintainer']) {
      for (const route of dangerous) {
        for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          const denied = assertOwnerRequest(bearer(fixture.tokens[role], `http://localhost:4200${route}`, { method }));
          expect({ role, route, method, status: denied?.status }).toEqual({ role, route, method, status: 403 });
        }
      }
    }
  });

  it('opens every route to an administrator, and keeps bulk delete of conversations with administrators', () => {
    for (const route of ROUTES) {
      for (const method of route.methods) {
        const request = bearer(fixture.tokens.admin, `http://localhost:4200${concrete(route.template)}`, { method });
        if (isOwnerProtocolException(request)) continue;
        if (route.template.startsWith('/api/avatar/remote/')) continue; // Voice has its own workspace-bound grant.
        expect({ route: route.template, method, status: assertOwnerRequest(request)?.status }).toEqual({ route: route.template, method, status: undefined });
      }
    }
    const denied = assertOwnerRequest(bearer(fixture.tokens.operator, 'http://localhost:4200/v1/chat/conversations', { method: 'DELETE' }));
    expect(denied?.status).toBe(403);
  });

  it.each([
    ['/api/operations/status/extra', 'GET'], ['/API/OPERATIONS/STATUS', 'GET'], ['/api/operations/status', 'POST'],
    ['/api/operations/status', 'HEAD'], ['/api/operations/status%2F', 'GET'], ['/api//operations/status', 'GET'],
  ])('falls back to administration on the near miss %s %s', (route, method) => {
    expect(assertOwnerRequest(bearer(fixture.tokens.health, `http://localhost:4200${route}`, { method }))?.status).toBe(403);
  });
});

describe('credentials that no longer hold', () => {
  it('answers expired, revoked and unknown tokens the same way, and leaves working ones alone', () => {
    const url = 'http://localhost:4200/api/operations/status';
    const policy = fixture.read();
    fixture.write({ ...policy, credentials: policy.credentials.map(item => {
      if (item.name === 'health') return { ...item, revokedAt: Date.now() - 1 };
      if (item.name === 'maintainer') return { ...item, expiresAt: Date.now() - 1 };
      return item;
    }) });
    const answers = [fixture.tokens.health, fixture.tokens.maintainer, `flo_v1_${'x'.repeat(43)}`]
      .map(token => assertOwnerRequest(bearer(token, url))!);
    expect(answers.map(answer => answer.status)).toEqual([401, 401, 401]);
    expect(assertOwnerRequest(bearer(fixture.tokens.viewer, url))?.status).toBe(403);
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, url))).toBeNull();
  });

  it('never accepts a token in the URL or a claimed identity header', () => {
    const url = `http://localhost:4200/api/operations/status?token=${fixture.tokens.admin}&access_token=${fixture.tokens.admin}`;
    const headers = { 'x-flujo-owner': 'admin', 'x-flujo-credential': fixture.ids.admin };
    expect(assertOwnerRequest(new Request(url, { headers }))?.status).toBe(401);
  });

  it('fails closed on a corrupt or missing policy, and does not fall back to anonymous access', () => {
    const url = 'http://localhost:4200/api/operations/status';
    fs.writeFileSync(fixture.policyFile, '{ this is not json', { mode: 0o600 });
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, url))?.status).toBe(503);
    expect(assertOwnerRequest(new Request(url))?.status).toBe(503);
    fs.rmSync(fixture.policyFile);
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, url))?.status).toBe(503);
  });

  it('refuses a policy that would make a role lie', () => {
    const url = 'http://localhost:4200/api/operations/status';
    const policy = fixture.read();
    const health = policy.credentials.find(item => item.name === 'health')!;
    const lying = [
      // Says viewer, holds administration.
      { ...health, role: 'viewer', scopes: ['control:admin', 'secrets:read'] },
      // Flow limit together with something that reaches past one flow.
      { ...health, role: 'custom', scopes: ['control:admin', 'secrets:read'], workspaceId: 'site-a', flowIds: ['f'] },
      { ...health, role: 'custom', scopes: ['runs:all', 'runs:read'], workspaceId: 'site-a', flowIds: ['f'] },
      { ...health, role: 'custom', scopes: ['flows:read'], workspaceId: 'site-a', flowIds: ['f'] },
      // Flow limit with no workspace, where the same id could mean another flow.
      { ...health, role: 'custom', scopes: ['openai:execute'], flowIds: ['f'] },
      // Administration cannot be confined to one workspace.
      { ...health, role: 'custom', scopes: ['control:admin', 'secrets:read'], workspaceId: 'site-a' },
    ];
    for (const record of lying) {
      fixture.write({ ...policy, credentials: policy.credentials.map(item => item.name === 'health' ? record : item) } as never);
      expect(assertOwnerRequest(bearer(fixture.tokens.admin, url))?.status).toBe(503);
    }
    // Schema 1 cannot carry people or narrow scopes either.
    fixture.write({ ...policy, schemaVersion: 1 });
    expect(assertOwnerRequest(bearer(fixture.tokens.admin, url))?.status).toBe(503);
  });
});

describe('changing one person does not disturb the others', () => {
  const authorize = (token: string) => {
    const resolved = resolveOwnerRequest(bearer(token, 'http://localhost:4200/api/owner/me'));
    if (!resolved.ok) throw new Error(`denied ${resolved.response.status}`);
    return resolved.authorization;
  };

  it('keeps witnesses when someone else is added, renamed or revoked, and ends only that person', () => {
    const operator = authorize(fixture.tokens.operator);
    const viewer = authorize(fixture.tokens.viewer);
    const adminRevision = ownerPolicyRevision(fixture.read());
    fixture.add('new-person', { role: 'operator' });
    expect(operator.recheck()).toBeNull();
    expect(ownerPolicyRevision(fixture.read())).toBe(adminRevision); // MCP approvals pinned to administrators survive.

    const renamed = fixture.read();
    fixture.write({ ...renamed, credentials: renamed.credentials.map(item => item.name === 'operator' ? { ...item, name: 'Op' } : item) });
    expect(operator.recheck()).toBeNull(); // A new display name signs nobody out.

    const revoked = fixture.read();
    fixture.write({ ...revoked, credentials: revoked.credentials.map(item => item.name === 'viewer' ? { ...item, revokedAt: Date.now() } : item) });
    expect(viewer.recheck()?.status).toBe(401);
    expect(operator.recheck()).toBeNull();
  });

  it('ends an open stream as soon as that person is revoked', async () => {
    const authorization = authorize(fixture.tokens.operator);
    const body = new ReadableStream<Uint8Array>({ pull: async controller => {
      await new Promise(resolve => setTimeout(resolve, 20));
      controller.enqueue(new TextEncoder().encode('data: x\n\n'));
    } });
    const abort = new AbortController();
    const bound = bindOwnerStream(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), authorization, abort.signal);
    const reader = bound.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const policy = fixture.read();
    fixture.write({ ...policy, credentials: policy.credentials.map(item => item.name === 'operator' ? { ...item, revokedAt: Date.now() } : item) });
    await expect((async () => { for (;;) await reader.read(); })()).rejects.toThrow('Stream authorization ended.');
    abort.abort();
  });

  it('keeps the old whole-file rule for a schema 1 policy', () => {
    const issued = issueOwnerCredential(['control:admin', 'secrets:read'], Date.now() + 60_000, Date.now() - 1000);
    const other = issueOwnerCredential(['openai:execute'], Date.now() + 60_000, Date.now() - 1000);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [issued.record] });
    const before = ownerCredentialRevision(fixture.read(), issued.record.id);
    const witness = authorize(issued.token);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [issued.record, other.record] });
    expect(ownerCredentialRevision(fixture.read(), issued.record.id)).not.toBe(before);
    expect(witness.recheck()?.status).toBe(401);
  });

  it('does not apply the narrow table to a schema 1 credential', () => {
    const execute = issueOwnerCredential(['openai:execute', 'openai:read'], Date.now() + 60_000, Date.now() - 1000);
    fixture.write({ schemaVersion: 1, ownerId: 'owner', credentials: [execute.record] });
    for (const route of ['/api/owner/me', '/api/workspaces', '/v1/chat/conversations']) {
      expect(assertOwnerRequest(bearer(execute.token, `http://localhost:4200${route}`))?.status).toBe(403);
    }
    expect(assertOwnerRequest(bearer(execute.token, 'http://localhost:4200/v1/models'))).toBeNull();
  });
});

it('names every preset in the role list', () => {
  expect(ACCESS_ROLES).toEqual(['admin', 'builder', 'operator', 'viewer', 'health', 'maintainer']);
});
