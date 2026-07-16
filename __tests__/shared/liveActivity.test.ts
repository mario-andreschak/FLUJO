/**
 * Tier 3 — live-activity model: pruning by TTL and resource-node matching
 * (static by server+uri, run artifacts by name — run URIs are id-based, so
 * name is the stable identity).
 */
import {
  pruneLiveActivity,
  matchResourceNode,
  resourceActivityKey,
  LIVE_HIGHLIGHT_TTL_MS,
  EMPTY_LIVE_ACTIVITY,
} from '@/utils/shared/liveActivity';

describe('pruneLiveActivity', () => {
  it('drops entries older than the TTL and keeps young ones', () => {
    const now = 100_000;
    const pruned = pruneLiveActivity({
      byNode: {
        young: { kind: 'active', ts: now - 100 },
        old: { kind: 'active', ts: now - LIVE_HIGHLIGHT_TTL_MS - 1 },
      },
      byResource: { [resourceActivityKey('srv', 'u://x')]: { kind: 'read', ts: now - LIVE_HIGHLIGHT_TTL_MS - 1 } },
      byResourceName: { report: { kind: 'write', ts: now - 50 } },
      resourceVersion: 7,
    }, now);

    expect(Object.keys(pruned.byNode)).toEqual(['young']);
    expect(Object.keys(pruned.byResource)).toEqual([]);
    expect(Object.keys(pruned.byResourceName)).toEqual(['report']);
    expect(pruned.resourceVersion).toBe(7); // version is monotonic, never pruned
  });

  it('empty stays empty', () => {
    const pruned = pruneLiveActivity(EMPTY_LIVE_ACTIVITY, Date.now());
    expect(pruned.byNode).toEqual({});
  });
});

describe('matchResourceNode', () => {
  const nodes = [
    { id: 'proc', type: 'process', data: { type: 'process', properties: {} } },
    {
      id: 'static-res',
      type: 'resource',
      data: { type: 'resource', properties: { scope: 'mcp', boundServer: 'files', uri: 'file:///spec.md' } },
    },
    {
      id: 'run-res',
      type: 'resource',
      data: { type: 'resource', properties: { scope: 'run', runName: 'report' } },
    },
  ];

  it('matches static resources by exact server + uri', () => {
    expect(matchResourceNode(nodes, { server: 'files', uri: 'file:///spec.md' })).toBe('static-res');
    expect(matchResourceNode(nodes, { server: 'files', uri: 'file:///other.md' })).toBeNull();
    expect(matchResourceNode(nodes, { server: 'ghost', uri: 'file:///spec.md' })).toBeNull();
  });

  it('matches run artifacts by name (run URIs are id-based)', () => {
    expect(matchResourceNode(nodes, {
      server: 'flujo', uri: 'flujo://run/conv-1/abc', name: 'report',
    })).toBe('run-res');
    expect(matchResourceNode(nodes, { server: 'flujo', uri: 'flujo://run/conv-1/abc' })).toBeNull();
  });

  it('never matches non-resource nodes', () => {
    expect(matchResourceNode(nodes, { name: 'proc' })).toBeNull();
  });
});
