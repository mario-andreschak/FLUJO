import fs from 'fs';
import path from 'path';

const APP_ROOT = path.join(process.cwd(), 'src', 'app');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
const INSTALLATION_WIDE = new Set([
  '/api/network-exposure',
  '/api/telemetry/daily-active',
  '/api/update',
  '/api/workspaces',
]);
const MARKER = 'FLUJO_INSTALLATION_WIDE_ROUTE:';

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
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      const pathname = pathnameOf(file);
      const methods = exportedMethods(source);
      expect(methods.length).toBeGreaterThan(0);

      if (source.includes(MARKER)) {
        marked.push(pathname);
        expect(INSTALLATION_WIDE.has(pathname)).toBe(true);
        continue;
      }

      expect(INSTALLATION_WIDE.has(pathname)).toBe(false);
      expect(source).toContain("from '@/app/api/_workspace'");
      for (const method of methods) {
        expect(source).toMatch(
          new RegExp(`withWorkspaceRoute\\(\\s*${method}_handler\\s*\\)`),
        );
      }
    }

    expect(marked.sort()).toEqual([...INSTALLATION_WIDE].sort());
  });
});
