/**
 * Tests for MCP roots resolution (#15, revised by issue 46: the roots capability is
 * always declared and roots/list falls back to the server's own rootPath when the user
 * configured no roots anywhere).
 */

// Resolve a sentinel so we can prove global-variable substitution runs before normalization.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) =>
    typeof v === 'string' ? v.replace('${global:PROJ}', '/home/me/proj') : v
  ),
}));

import { pathToFileURL } from 'url';
import {
  normalizeRootUri,
  resolveServerRoots,
  _resetNodeRootsForTests,
} from '@/backend/services/mcp/roots';

const cfg = (roots?: unknown, rootPath?: string) =>
  ({ name: 'srv', transport: 'stdio', roots, rootPath }) as any;

beforeEach(() => {
  _resetNodeRootsForTests();
});

describe('normalizeRootUri', () => {
  it('passes through file:// URIs', () => {
    expect(normalizeRootUri('file:///home/me/proj')).toBe('file:///home/me/proj');
  });

  it('converts a filesystem path to a file URI', () => {
    // Compare against Node's own conversion so the test is platform-agnostic.
    expect(normalizeRootUri('/home/me/proj')).toBe(pathToFileURL('/home/me/proj').href);
  });

  it('rejects blanks and non-file URI schemes', () => {
    expect(normalizeRootUri('')).toBeNull();
    expect(normalizeRootUri('   ')).toBeNull();
    expect(normalizeRootUri('https://example.com')).toBeNull();
  });
});

describe('resolveServerRoots', () => {
  it('resolves global vars, converts to file URIs, and derives names', async () => {
    const roots = await resolveServerRoots(cfg(['${global:PROJ}', 'file:///srv/data', '  ']));
    expect(roots).toEqual([
      { uri: pathToFileURL('/home/me/proj').href, name: 'proj' },
      { uri: 'file:///srv/data', name: 'data' },
    ]);
  });

  it('falls back to the server rootPath when no roots are configured (issue 46)', async () => {
    const roots = await resolveServerRoots(cfg(undefined, '/opt/mcp-servers/srv'));
    expect(roots).toEqual([
      { uri: pathToFileURL('/opt/mcp-servers/srv').href, name: 'srv' },
    ]);
  });

  it('resolves ${global:VAR} in the rootPath fallback too', async () => {
    const roots = await resolveServerRoots(cfg([], '${global:PROJ}'));
    expect(roots).toEqual([{ uri: pathToFileURL('/home/me/proj').href, name: 'proj' }]);
  });

  it('does NOT fall back when server-level roots exist', async () => {
    const roots = await resolveServerRoots(cfg(['/workspace'], '/opt/mcp-servers/srv'));
    expect(roots).toEqual([{ uri: pathToFileURL('/workspace').href, name: 'workspace' }]);
  });

  it('returns an empty list when neither roots nor a usable rootPath exist', async () => {
    expect(await resolveServerRoots(cfg(undefined))).toEqual([]);
    expect(await resolveServerRoots(cfg(undefined, '   '))).toEqual([]);
  });
});
