/**
 * Tests for the node-level MCP roots overlay + the always-declared roots capability
 * (issue 46, owner-revised design).
 *
 * FlowBuilder MCP nodes can contribute extra workspace folders to their bound server.
 * Connections are singletons keyed by server name, so node roots are an additive,
 * request-time overlay: roots/list returns the union of server-level and node-level
 * roots (falling back to the server's own rootPath when there are none). The roots
 * client capability is ALWAYS declared, so NO roots change may ever rebuild the
 * client/connection — changed servers are announced via
 * notifications/roots/list_changed instead (covered in rootsNotification.test.ts).
 */

// Resolve a sentinel so we can prove global-variable substitution runs for node roots too.
jest.mock('@/backend/utils/resolveGlobalVars', () => ({
  resolveGlobalVars: jest.fn(async (v: unknown) =>
    typeof v === 'string' ? v.replace('${global:PROJ}', '/home/me/proj') : v
  ),
}));

import { pathToFileURL } from 'url';
import {
  setNodeRoots,
  getNodeRoots,
  resolveServerRoots,
  _resetNodeRootsForTests,
} from '@/backend/services/mcp/roots';
import { createNewClient, shouldRecreateClient } from '@/backend/services/mcp/connection';

const cfg = (roots?: unknown, name = 'srv', extra: Record<string, unknown> = {}) =>
  ({ name, transport: 'stdio', roots, ...extra }) as any;

beforeEach(() => {
  _resetNodeRootsForTests();
});

describe('node roots registry', () => {
  it('registers, replaces and clears roots per node id', () => {
    setNodeRoots('srv', 'node-1', ['/a', '/b']);
    expect(getNodeRoots('srv')).toEqual(['/a', '/b']);

    // Last write wins for the same node.
    setNodeRoots('srv', 'node-1', ['/c']);
    expect(getNodeRoots('srv')).toEqual(['/c']);

    // Empty / undefined clears the node's registration.
    setNodeRoots('srv', 'node-1', []);
    expect(getNodeRoots('srv')).toEqual([]);
  });

  it('ignores blank entries and clears when only blanks remain', () => {
    setNodeRoots('srv', 'node-1', ['  ', '/a', '']);
    expect(getNodeRoots('srv')).toEqual(['/a']);

    setNodeRoots('srv', 'node-1', ['   ']);
    expect(getNodeRoots('srv')).toEqual([]);
  });

  it('unions roots from multiple nodes bound to the same server, de-duped', () => {
    setNodeRoots('srv', 'node-1', ['/a', '/shared']);
    setNodeRoots('srv', 'node-2', ['/b', '/shared']);
    expect(getNodeRoots('srv')).toEqual(['/a', '/shared', '/b']);
  });

  it('moves a node registration when the node is re-bound to another server', () => {
    setNodeRoots('srv', 'node-1', ['/a']);
    setNodeRoots('other', 'node-1', ['/a']);
    expect(getNodeRoots('srv')).toEqual([]);
    expect(getNodeRoots('other')).toEqual(['/a']);
  });

  it('reports exactly the servers whose effective node-roots set changed', () => {
    // First registration changes srv.
    expect(setNodeRoots('srv', 'node-1', ['/a'])).toEqual(['srv']);
    // Re-registering identical content changes nothing.
    expect(setNodeRoots('srv', 'node-1', ['/a'])).toEqual([]);
    // A second node adding an already-covered root changes nothing either...
    expect(setNodeRoots('srv', 'node-2', ['/a'])).toEqual([]);
    // ...and removing it again also leaves the effective set intact (node-1 still has /a).
    expect(setNodeRoots('srv', 'node-2', [])).toEqual([]);
    // Re-binding node-1 to another server changes BOTH servers' effective sets.
    expect(setNodeRoots('other', 'node-1', ['/a']).sort()).toEqual(['other', 'srv']);
    // Clearing a non-existent registration is a no-op.
    expect(setNodeRoots('srv', 'unknown-node', [])).toEqual([]);
  });
});

describe('resolveServerRoots with the node overlay', () => {
  it('returns the union of server and node roots, de-duplicated by URI', async () => {
    setNodeRoots('srv', 'node-1', ['/node/only', '/shared']);
    const roots = await resolveServerRoots(cfg(['/shared', '/server/only']));
    expect(roots).toEqual([
      { uri: pathToFileURL('/shared').href, name: 'shared' },
      { uri: pathToFileURL('/server/only').href, name: 'only' },
      { uri: pathToFileURL('/node/only').href, name: 'only' },
    ]);
  });

  it('resolves ${global:VAR} in node roots', async () => {
    setNodeRoots('srv', 'node-1', ['${global:PROJ}']);
    const roots = await resolveServerRoots(cfg(undefined));
    expect(roots).toEqual([{ uri: pathToFileURL('/home/me/proj').href, name: 'proj' }]);
  });

  it('node roots suppress the rootPath fallback; clearing them restores it', async () => {
    const config = cfg(undefined, 'srv', { rootPath: '/opt/mcp-servers/srv' });

    // No roots anywhere -> the server's own path is the default root.
    expect(await resolveServerRoots(config)).toEqual([
      { uri: pathToFileURL('/opt/mcp-servers/srv').href, name: 'srv' },
    ]);

    // A node root exists -> it IS the roots list (no fallback mixed in).
    setNodeRoots('srv', 'node-1', ['/workspace']);
    expect(await resolveServerRoots(config)).toEqual([
      { uri: pathToFileURL('/workspace').href, name: 'workspace' },
    ]);

    // Cleared again -> fallback returns.
    setNodeRoots('srv', 'node-1', []);
    expect(await resolveServerRoots(config)).toEqual([
      { uri: pathToFileURL('/opt/mcp-servers/srv').href, name: 'srv' },
    ]);
  });

  it('no roots and no rootPath resolves to an empty list (spec-valid)', async () => {
    expect(await resolveServerRoots(cfg(undefined))).toEqual([]);
  });
});

describe('always-declared roots capability (issue 46)', () => {
  it('declares roots (listChanged) for a server WITHOUT any configured roots', () => {
    const client = createNewClient(cfg(undefined));
    // The SDK offers no public getter for the client's own declared capabilities;
    // reading the private field is the cheapest regression net for "always declared".
    const caps = (client as any)._capabilities;
    expect(caps.roots).toEqual({ listChanged: true });
    // Sampling stays opt-in.
    expect(caps.sampling).toBeUndefined();
  });

  it('never reports a capability change for ANY roots change (no rebuild)', () => {
    // Regression against the rejected first implementation, where the capability key
    // included roots and a none<->some transition forced a client rebuild at runtime.
    const config = cfg(undefined);
    const client = createNewClient(config);

    // Node roots appearing on a rootless server: not a capability change.
    setNodeRoots('srv', 'node-1', ['/a']);
    expect(shouldRecreateClient(client, config).reason ?? '').not.toContain('capabilities');

    // ...nor disappearing again.
    setNodeRoots('srv', 'node-1', []);
    expect(shouldRecreateClient(client, config).reason ?? '').not.toContain('capabilities');

    // Server-level roots content changes: not a capability change either.
    expect(shouldRecreateClient(client, cfg(['/a'])).reason ?? '').not.toContain('capabilities');
    expect(shouldRecreateClient(client, cfg(['/b'])).reason ?? '').not.toContain('capabilities');
  });

  it('a sampling policy change still rebuilds the client', () => {
    const config = cfg(undefined);
    const client = createNewClient(config);

    const withSampling = cfg(undefined, 'srv', {
      sampling: { enabled: true, modelId: 'model-1' },
    });
    const result = shouldRecreateClient(client, withSampling);
    expect(result.needsNewClient).toBe(true);
    expect(result.reason).toContain('capabilities');
  });
});
