/**
 * Tests for the node-level MCP roots overlay (issue 46).
 *
 * FlowBuilder MCP nodes can contribute extra workspace folders to their bound
 * server. Connections are singletons keyed by server name, so node roots are an
 * additive, request-time overlay: roots/list returns the union of server-level
 * and node-level roots, and only the PRESENCE of any roots (none <-> some)
 * changes the client capability key (forcing a controlled client rebuild).
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
  hasNodeRoots,
  hasAnyRoots,
  resolveServerRoots,
  _resetNodeRootsForTests,
} from '@/backend/services/mcp/roots';
import { createNewClient, shouldRecreateClient } from '@/backend/services/mcp/connection';

const cfg = (roots?: unknown, name = 'srv') => ({ name, transport: 'stdio', roots }) as any;

beforeEach(() => {
  _resetNodeRootsForTests();
});

describe('node roots registry', () => {
  it('registers, replaces and clears roots per node id', () => {
    setNodeRoots('srv', 'node-1', ['/a', '/b']);
    expect(getNodeRoots('srv')).toEqual(['/a', '/b']);
    expect(hasNodeRoots('srv')).toBe(true);

    // Last write wins for the same node.
    setNodeRoots('srv', 'node-1', ['/c']);
    expect(getNodeRoots('srv')).toEqual(['/c']);

    // Empty / undefined clears the node's registration.
    setNodeRoots('srv', 'node-1', []);
    expect(getNodeRoots('srv')).toEqual([]);
    expect(hasNodeRoots('srv')).toBe(false);
  });

  it('ignores blank entries and clears when only blanks remain', () => {
    setNodeRoots('srv', 'node-1', ['  ', '/a', '']);
    expect(getNodeRoots('srv')).toEqual(['/a']);

    setNodeRoots('srv', 'node-1', ['   ']);
    expect(hasNodeRoots('srv')).toBe(false);
  });

  it('unions roots from multiple nodes bound to the same server, de-duped', () => {
    setNodeRoots('srv', 'node-1', ['/a', '/shared']);
    setNodeRoots('srv', 'node-2', ['/b', '/shared']);
    expect(getNodeRoots('srv')).toEqual(['/a', '/shared', '/b']);
  });

  it('moves a node registration when the node is re-bound to another server', () => {
    setNodeRoots('srv', 'node-1', ['/a']);
    setNodeRoots('other', 'node-1', ['/a']);
    expect(hasNodeRoots('srv')).toBe(false);
    expect(getNodeRoots('other')).toEqual(['/a']);
  });
});

describe('hasAnyRoots', () => {
  it('is true for server-level roots, node-level roots, or both — false for neither', () => {
    expect(hasAnyRoots(cfg(undefined))).toBe(false);
    expect(hasAnyRoots(cfg(['/srv-root']))).toBe(true);

    setNodeRoots('srv', 'node-1', ['/node-root']);
    expect(hasAnyRoots(cfg(undefined))).toBe(true);
    expect(hasAnyRoots(cfg(['/srv-root']))).toBe(true);

    // A different server is unaffected by srv's node roots.
    expect(hasAnyRoots(cfg(undefined, 'other'))).toBe(false);
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

  it('regression: no server roots and no node roots resolves to an empty list', async () => {
    expect(await resolveServerRoots(cfg(undefined))).toEqual([]);
  });
});

describe('capability rebuild on roots-presence change', () => {
  it('node roots appearing on a no-roots server change the capability key (rebuild)', () => {
    const config = cfg(undefined);
    const client = createNewClient(config);

    setNodeRoots('srv', 'node-1', ['/a']);
    const { needsNewClient, reason } = shouldRecreateClient(client, config);
    expect(needsNewClient).toBe(true);
    expect(reason).toContain('capabilities');
  });

  it('node roots disappearing again change the capability key back (rebuild)', () => {
    setNodeRoots('srv', 'node-1', ['/a']);
    const config = cfg(undefined);
    const client = createNewClient(config);

    setNodeRoots('srv', 'node-1', []);
    const { needsNewClient, reason } = shouldRecreateClient(client, config);
    expect(needsNewClient).toBe(true);
    expect(reason).toContain('capabilities');
  });

  it('node roots on a server that already has server-level roots do NOT force a rebuild', () => {
    // The capability is already declared and roots are resolved fresh per request, so a
    // content-only change must not respawn the server process. (shouldRecreateClient
    // still reports needsNewClient here because this bare test client has no transport —
    // the assertion is that the reason is NOT a capability change.)
    const config = cfg(['/srv-root']);
    const client = createNewClient(config);

    setNodeRoots('srv', 'node-1', ['/node-root']);
    const { reason } = shouldRecreateClient(client, config);
    expect(reason).not.toContain('capabilities');
  });

  it('regression: a no-roots server with no node roots has no capability-key change', () => {
    const config = cfg(undefined);
    const client = createNewClient(config);
    const { reason } = shouldRecreateClient(client, config);
    expect(reason).not.toContain('capabilities');
  });
});
