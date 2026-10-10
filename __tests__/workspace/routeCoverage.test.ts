import fs from 'fs';
import path from 'path';

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
const INSTALLATION_WIDE = new Set([
  '/api/cloud/instance',
  '/api/mcp/servers/[name]/host-consent',
  '/api/network-exposure',
  '/api/runtime-environment',
  '/api/telemetry/daily-active',
  '/api/update',
  '/api/worker/status',
  '/api/workspaces',
]);
const MARKER = 'FLUJO_INSTALLATION_WIDE_ROUTE:';
// The remote wrapper resolves owner authority before the ordinary workspace
// wrapper can select storage. Keep this exception exact and audit its delegate.
const AUTHENTICATED_AVATAR = new Set([
  '/api/avatar/remote/[voiceAction]', '/api/avatar/remote/availability',
]);

function collectRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(full);
    return entry.isFile() && entry.name === 'route.ts' ? [full] : [];
  });
}

function pathnameOf(file: string): string {
  return `/${path.relative(APP_ROOT, path.dirname(file)).split(path.sep).join('/')}`;
}

function exportedMethods(source: string): string[] {
  return METHODS.filter(method => new RegExp(
    `export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`,
  ).test(source));
}

describe('workspace route coverage', () => {
  const routes = collectRouteFiles(APP_ROOT);

  it('classifies every application route and keeps the installation-wide allowlist exact', () => {
    const marked: string[] = [];
    const ownerSessionRoutes: string[] = [];
    const ownerBootstrapRoutes: string[] = [];
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const pathname = pathnameOf(file);
      const methods = exportedMethods(source);
      expect(methods.length).toBeGreaterThan(0);

      if (source.includes(MARKER)) {
        marked.push(pathname);
        expect(INSTALLATION_WIDE.has(pathname)).toBe(true);
        if (pathname === '/api/mcp/servers/[name]/host-consent') {
          // This operator-only exception is reachable before Worker readiness.
          // Require owner admission before workspace selection/storage access.
          expect(methods.sort()).toEqual(['DELETE', 'GET', 'POST']);
          const wrapper = source.slice(source.indexOf('function operatorWorkspace('));
          expect(wrapper).toContain('authorizeExecutionTransport(request)');
          expect(wrapper).toContain('resolveOwnerRequest(request, scopes, { requireBearer: true })');
          expect(wrapper.indexOf('resolveOwnerRequest(request, scopes')).toBeLessThan(wrapper.indexOf('resolveWorkspace(request)'));
          expect(wrapper.indexOf('resolveWorkspace(request)')).toBeLessThan(wrapper.indexOf('ensureWorkspaceDirs(workspace)'));
          for (const method of methods) expect(wrapper).toContain(`export const ${method} = operatorWorkspace(`);
        }
        continue;
      }

      expect(INSTALLATION_WIDE.has(pathname)).toBe(false);
      if (pathname === '/api/owner/bootstrap') {
        ownerBootstrapRoutes.push(pathname);
        expect(methods.sort()).toEqual(['GET', 'POST']);
        expect(source).toContain("from '@/backend/services/security/ownerBootstrap'");
        expect(source.match(/\bisOwnerBootstrapRequest\(request\)/g)).toHaveLength(2);
        expect(source).toContain('readBoundedBody(request, 256)');
        expect(source).toContain('input.confirmOwnerEnrollment !== true');
        expect(source).toContain('pairFirstOwner(request, true)');
        const admission = fs.readFileSync(path.join(process.cwd(), 'src/backend/services/security/ownerBootstrap.ts'), 'utf8');
        expect(admission).toContain('ownerBrowserRequestAllowed(request, true)');
        expect(admission).toContain('authenticateOwnerBearer(request, configured.grant, now)');
        expect(admission).toContain('isOwnerBootstrapAvailable(Math.max(now, Date.now()))');
        continue;
      }
      if (pathname === '/api/owner/session') {
        ownerSessionRoutes.push(pathname);
        expect(methods.sort()).toEqual(['DELETE', 'GET', 'POST']);
        expect(source).toContain("from '@/backend/services/security/ownerAccess'");
        expect(source).toContain("from '@/backend/services/security/ownerSession'");
        expect(source).toContain('resolveOwnerRequest(request,');
        expect(source).toContain('requireBearer: true');
        expect(source).toContain('admitted.authorization.recheck()');
        expect(source).toContain('createOwnerSession(request,');
        expect(source).toContain('revokeOwnerSession(request)');
        expect(source).toContain('ownerBrowserRequestAllowed(request, true)');
        continue;
      }
      if (AUTHENTICATED_AVATAR.has(pathname)) {
        expect(source).toContain("from '@/backend/services/avatar/remoteVoice'");
        for (const method of methods) {
          expect(source).toMatch(new RegExp(`withRemoteAvatarRoute\\(\\s*${method}_handler\\s*\\)`));
        }
        const wrapper = fs.readFileSync(path.join(process.cwd(), 'src/backend/services/avatar/remoteVoice.ts'), 'utf8');
        expect(wrapper).toContain("from '@/app/api/_workspace'");
        expect(wrapper).toContain('withWorkspaceRoute(');
        continue;
      }
      expect(source).toContain("from '@/app/api/_workspace'");
      for (const method of methods) {
        expect(source).toMatch(
          new RegExp(`withWorkspaceRoute\\(\\s*${method}_handler\\s*\\)`),
        );
      }
    }

    expect(marked.sort()).toEqual([...INSTALLATION_WIDE].sort());
    expect(ownerSessionRoutes).toEqual(['/api/owner/session']);
    expect(ownerBootstrapRoutes).toEqual(['/api/owner/bootstrap']);
  });
});
