/**
 * Tests for MCP roots resolution (#15).
 */

// Resolve a sentinel so we can prove global-variable substitution runs before normalization.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) =>
    typeof v === 'string' ? v.replace('${global:PROJ}', '/home/me/proj') : v
  ),
}));

import { pathToFileURL } from 'url';
import {
  hasRoots,
  rootsConfigKey,
  normalizeRootUri,
  resolveServerRoots,
} from '@/backend/services/mcp/roots';

const cfg = (roots?: unknown) => ({ name: 'srv', transport: 'stdio', roots }) as any;

describe('hasRoots', () => {
  it('is true only for a non-empty list of non-blank strings', () => {
    expect(hasRoots(cfg(['/a']))).toBe(true);
    expect(hasRoots(cfg([]))).toBe(false);
    expect(hasRoots(cfg(['  ']))).toBe(false);
    expect(hasRoots(cfg(undefined))).toBe(false);
  });
});

describe('rootsConfigKey', () => {
  it('changes when roots change and ignores blanks', () => {
    expect(rootsConfigKey(cfg(['/a']))).toBe(rootsConfigKey(cfg(['/a', '   '])));
    expect(rootsConfigKey(cfg(['/a']))).not.toBe(rootsConfigKey(cfg(['/b'])));
    expect(rootsConfigKey(cfg(undefined))).toBe('[]');
  });
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

  it('returns an empty list when no roots are configured', async () => {
    expect(await resolveServerRoots(cfg(undefined))).toEqual([]);
  });
});
