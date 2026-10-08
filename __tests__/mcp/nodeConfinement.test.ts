/**
 * Tests for per-node, per-call confinement enforcement (issue #266).
 *
 * Each MCP node can register its own set of workspace roots, and when that node
 * calls a tool on the filesystem or bash servers, the confinement should be
 * scoped to ONLY that node's roots — not the global union across all nodes.
 *
 * This test file verifies:
 *  1. getNodeRootsForId returns only a specific node's roots
 *  2. getNodeRootsForId returns empty array for unknown nodeId
 *  3. loadEffectiveRoots with callerNodeId that HAS registered roots uses ONLY those node roots (+ server roots)
 *  4. loadEffectiveRoots with callerNodeId that has NO registered roots falls back to global node union (+ server roots)
 */

jest.mock('@/backend/services/mcp/config', () => ({
  loadServerRoots: jest.fn(),
}));

import path from 'path';
import {
  setNodeRoots,
  getNodeRoots,
  getNodeRootsForId,
  _resetNodeRootsForTests,
} from '@/backend/services/mcp/roots';
import { loadEffectiveRoots } from '@/backend/services/mcp/internal/confinement';
import { loadServerRoots } from '@/backend/services/mcp/config';

const mockedRegistry = loadServerRoots as jest.Mock;

describe('getNodeRootsForId (per-node root lookup)', () => {
  beforeEach(() => {
    _resetNodeRootsForTests();
  });

  it('returns the roots registered for a specific node', () => {
    const roots = ['/workspace/alpha', '/workspace/beta'];
    setNodeRoots('filesystem', 'node-a', roots);

    const retrieved = getNodeRootsForId('filesystem', 'node-a');
    expect(retrieved).toEqual(roots);
  });

  it('returns empty array for an unknown nodeId', () => {
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);

    const retrieved = getNodeRootsForId('filesystem', 'unknown-node');
    expect(retrieved).toEqual([]);
  });

  it('returns empty array for a node when queried for a different server', () => {
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);

    // A node can only be bound to one server at a time. Querying for a different
    // server returns empty array.
    const retrieved = getNodeRootsForId('bash', 'node-a');
    expect(retrieved).toEqual([]);
  });

  it('re-binding a node to a different server overwrites previous binding', () => {
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);
    expect(getNodeRootsForId('filesystem', 'node-a')).toEqual(['/workspace/alpha']);

    // Re-binding the same node to a different server overwrites the previous entry
    // (a node can only serve one MCP server at a time)
    setNodeRoots('bash', 'node-a', ['/bash-root']);
    expect(getNodeRootsForId('bash', 'node-a')).toEqual(['/bash-root']);
    expect(getNodeRootsForId('filesystem', 'node-a')).toEqual([]); // overwritten
  });

  it('returns updated roots after setNodeRoots', () => {
    const oldRoots = ['/workspace/old'];
    const newRoots = ['/workspace/new'];

    setNodeRoots('filesystem', 'node-a', oldRoots);
    expect(getNodeRootsForId('filesystem', 'node-a')).toEqual(oldRoots);

    setNodeRoots('filesystem', 'node-a', newRoots);
    expect(getNodeRootsForId('filesystem', 'node-a')).toEqual(newRoots);
  });
});

describe('loadEffectiveRoots with per-node callerNodeId (issue #266)', () => {
  beforeEach(() => {
    _resetNodeRootsForTests();
    mockedRegistry.mockReset();
  });

  it('scopes node-level roots to the specific node when callerNodeId HAS registered roots', async () => {
    // Simulate: server has persisted roots, and multiple nodes have contributed roots
    mockedRegistry.mockResolvedValue(['/server-configured-root']);

    // Node A and B both contribute roots to the same server
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);
    setNodeRoots('filesystem', 'node-b', ['/workspace/beta']);

    // When node A calls a tool with callerNodeId='node-a',
    // it gets: server-configured-root (always) + ONLY node-a's roots (not node-b's)
    const nodeAEffective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-a');
    expect(nodeAEffective).toContainEqual(path.resolve('/server-configured-root'));
    expect(nodeAEffective).toContainEqual(path.resolve('/workspace/alpha'));
    expect(nodeAEffective).not.toContainEqual(path.resolve('/workspace/beta')); // node-b's root excluded

    // When node B calls a tool, it gets server root + ONLY its own roots
    const nodeBEffective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-b');
    expect(nodeBEffective).toContainEqual(path.resolve('/server-configured-root'));
    expect(nodeBEffective).toContainEqual(path.resolve('/workspace/beta'));
    expect(nodeBEffective).not.toContainEqual(path.resolve('/workspace/alpha')); // node-a's root excluded
  });

  it('falls back to the global union when callerNodeId has NO registered roots', async () => {
    mockedRegistry.mockResolvedValue(['/server-configured-root']);

    // Only node A registers roots; node B does not
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);

    // When an unknown node calls a tool (or a node without registered roots),
    // it gets the global union: server roots + ALL node roots
    const unknownNodeEffective = await loadEffectiveRoots(
      'filesystem',
      'FLUJO_FS_ROOTS',
      'unknown-node'
    );
    const globalUnion = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS');

    // Unknown node falls back to the global union
    expect(unknownNodeEffective).toEqual(globalUnion);
    // Global union includes server-configured root and all node roots
    expect(globalUnion).toContainEqual(path.resolve('/server-configured-root'));
    expect(globalUnion).toContainEqual(path.resolve('/workspace/alpha'));
  });

  it('respects the env ceiling even with per-node confinement', async () => {
    const envCeiling = '/env-ceiling';
    process.env.FLUJO_FS_ROOTS = envCeiling;

    try {
      mockedRegistry.mockResolvedValue(['/server-configured-root']);
      setNodeRoots('filesystem', 'node-a', ['/workspace/inside-ceiling']);

      const effective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-a');

      // When a node tries to register a root outside the env ceiling, the path
      // should be filtered by isInside() and if none remain, the env roots are used.
      // In this case, /workspace/inside-ceiling is outside /env-ceiling, so it gets
      // filtered out and the effective root becomes the env ceiling itself.
      expect(effective).toEqual([path.resolve(envCeiling)]);
    } finally {
      delete process.env.FLUJO_FS_ROOTS;
    }
  });

  it('when callerNodeId=undefined, uses the full global union (legacy behavior)', async () => {
    mockedRegistry.mockResolvedValue(['/server-configured-root']);
    setNodeRoots('filesystem', 'node-a', ['/workspace/alpha']);
    setNodeRoots('filesystem', 'node-b', ['/workspace/beta']);

    // Call without a callerNodeId (legacy, or a tool invocation that doesn't pass it)
    const effective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS');

    // Should include all roots: server-configured-root + all node roots
    expect(effective).toContainEqual(path.resolve('/server-configured-root'));
    expect(effective).toContainEqual(path.resolve('/workspace/alpha'));
    expect(effective).toContainEqual(path.resolve('/workspace/beta'));
  });

  it('handles multiple nodes with the bash server the same way', async () => {
    mockedRegistry.mockResolvedValue(['/bash-server-root']);

    setNodeRoots('bash', 'shell-node-1', ['/shell/workspace/1']);
    setNodeRoots('bash', 'shell-node-2', ['/shell/workspace/2']);

    const node1Effective = await loadEffectiveRoots('bash', 'FLUJO_BASH_ROOTS', 'shell-node-1');
    const node2Effective = await loadEffectiveRoots('bash', 'FLUJO_BASH_ROOTS', 'shell-node-2');

    // Each node sees: bash-server-root + only its own node-level roots, not the other node's
    expect(node1Effective).toContainEqual(path.resolve('/bash-server-root'));
    expect(node1Effective).toContainEqual(path.resolve('/shell/workspace/1'));
    expect(node1Effective).not.toContainEqual(path.resolve('/shell/workspace/2'));

    expect(node2Effective).toContainEqual(path.resolve('/bash-server-root'));
    expect(node2Effective).toContainEqual(path.resolve('/shell/workspace/2'));
    expect(node2Effective).not.toContainEqual(path.resolve('/shell/workspace/1'));
  });

  it('preserves de-duplication within per-node roots', async () => {
    mockedRegistry.mockResolvedValue([]);

    // Register the same root twice for the same node (shouldn't happen, but defensive)
    const root = '/workspace/dup-test';
    setNodeRoots('filesystem', 'node-a', [root, root]);

    const retrieved = getNodeRootsForId('filesystem', 'node-a');
    // The actual registration only keeps the raw strings passed in
    expect(retrieved).toEqual([root, root]);

    const effective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-a');
    // loadEffectiveRoots de-dupes at the candidates level
    expect(effective).toHaveLength(1);
    expect(effective[0]).toBe(path.resolve(root));
  });
});

describe('Integration: node root registration and confinement lifecycle', () => {
  beforeEach(() => {
    _resetNodeRootsForTests();
    mockedRegistry.mockReset();
  });

  it('tracks multiple independent nodes without cross-contamination', async () => {
    mockedRegistry.mockResolvedValue([]);

    // Three independent nodes, each bound to its own server
    setNodeRoots('filesystem', 'node-alpha', ['/data/alpha']);
    setNodeRoots('bash', 'node-beta', ['/scripts/beta']);
    setNodeRoots('filesystem', 'node-gamma', ['/data/gamma']);

    // Each node sees ONLY its own roots when queried
    expect(getNodeRootsForId('filesystem', 'node-alpha')).toEqual(['/data/alpha']);
    expect(getNodeRootsForId('bash', 'node-beta')).toEqual(['/scripts/beta']);
    expect(getNodeRootsForId('filesystem', 'node-gamma')).toEqual(['/data/gamma']);

    // In confinement, each node is confined to only its own node-level roots
    // (plus any server-level roots which are shared)
    const alphaFS = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-alpha');
    const betaBash = await loadEffectiveRoots('bash', 'FLUJO_BASH_ROOTS', 'node-beta');
    const gammaFS = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-gamma');

    expect(alphaFS).toContainEqual(path.resolve('/data/alpha'));
    expect(alphaFS).not.toContainEqual(path.resolve('/data/gamma'));

    expect(betaBash).toContainEqual(path.resolve('/scripts/beta'));
    expect(betaBash).not.toContainEqual(path.resolve('/data/alpha'));

    expect(gammaFS).toContainEqual(path.resolve('/data/gamma'));
    expect(gammaFS).not.toContainEqual(path.resolve('/data/alpha'));
  });

  it('allows a node to update its roots and confinement is updated', async () => {
    mockedRegistry.mockResolvedValue([]);

    const node = 'node-upgrade';

    // Initial registration
    setNodeRoots('filesystem', node, ['/workspace/v1']);
    let effective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', node);
    expect(effective).toContainEqual(path.resolve('/workspace/v1'));

    // Update registration
    setNodeRoots('filesystem', node, ['/workspace/v2']);
    effective = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', node);
    expect(effective).toContainEqual(path.resolve('/workspace/v2'));
    expect(effective).not.toContainEqual(path.resolve('/workspace/v1'));
  });

  it('clearing a nodes roots returns it to the global union fallback', async () => {
    mockedRegistry.mockResolvedValue(['/server-global-root']);
    setNodeRoots('filesystem', 'node-a', ['/workspace/a']);
    setNodeRoots('filesystem', 'node-b', ['/workspace/b']);

    // Node A has its own roots, so it's confined to only its root (+ server root)
    const nodeAWithRoots = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-a');
    expect(nodeAWithRoots).toContainEqual(path.resolve('/workspace/a'));
    expect(nodeAWithRoots).not.toContainEqual(path.resolve('/workspace/b'));

    // Clear node A's roots
    setNodeRoots('filesystem', 'node-a', []);

    // Now node A has no registered roots, so it falls back to the global union
    // (server root + all remaining node roots)
    const nodeAWithoutRoots = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS', 'node-a');
    const globalUnion = await loadEffectiveRoots('filesystem', 'FLUJO_FS_ROOTS');
    expect(nodeAWithoutRoots).toEqual(globalUnion);
    expect(globalUnion).toContainEqual(path.resolve('/server-global-root'));
    expect(globalUnion).toContainEqual(path.resolve('/workspace/b'));
  });
});
