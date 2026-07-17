import {
  FlowGroupingItem,
  FlowSortOption,
  bucketNodeCount,
  deriveFlowSortGroup,
  sortFlows,
  sortFlowsFavoritesFirst,
  compareFlows,
} from '@/utils/shared/flowGrouping';

// Minimal flow factory — only the fields the sort/grouping logic reads.
const flow = (partial: Partial<FlowGroupingItem> & { nodeCount?: number }): FlowGroupingItem => ({
  id: partial.id ?? Math.random().toString(36).slice(2),
  name: partial.name ?? 'flow',
  nodes: partial.nodes ?? new Array(partial.nodeCount ?? 0).fill(null),
  favorite: partial.favorite,
});

describe('bucketNodeCount', () => {
  it('places counts on the correct side of each band boundary', () => {
    expect(bucketNodeCount(0).key).toBe('nodes:0');
    expect(bucketNodeCount(1).key).toBe('nodes:1-2');
    expect(bucketNodeCount(2).key).toBe('nodes:1-2');
    expect(bucketNodeCount(3).key).toBe('nodes:3-5');
    expect(bucketNodeCount(5).key).toBe('nodes:3-5');
    expect(bucketNodeCount(6).key).toBe('nodes:6-10');
    expect(bucketNodeCount(10).key).toBe('nodes:6-10');
    expect(bucketNodeCount(11).key).toBe('nodes:11+');
  });
});

describe('deriveFlowSortGroup', () => {
  it('folds name sorts by first letter', () => {
    const f = flow({ name: 'Alpha' });
    expect(deriveFlowSortGroup(f, 'name-asc')).toEqual({ key: 'letter:A', label: 'A' });
    expect(deriveFlowSortGroup(f, 'name-desc')).toEqual({ key: 'letter:A', label: 'A' });
  });

  it('folds node-count sorts by size band', () => {
    expect(deriveFlowSortGroup(flow({ nodeCount: 4 }), 'most-nodes').key).toBe('nodes:3-5');
    expect(deriveFlowSortGroup(flow({ nodeCount: 12 }), 'least-nodes').key).toBe('nodes:11+');
  });

  it('folds date sorts into a single bucket (no real timestamp on the type)', () => {
    expect(deriveFlowSortGroup(flow({}), 'newest')).toEqual({ key: 'all', label: 'All flows' });
    expect(deriveFlowSortGroup(flow({}), 'oldest')).toEqual({ key: 'all', label: 'All flows' });
  });
});

describe('sortFlows', () => {
  it('sorts by name A–Z and Z–A', () => {
    const flows = [flow({ name: 'Charlie' }), flow({ name: 'Alpha' }), flow({ name: 'Bravo' })];
    expect(sortFlows(flows, 'name-asc').map((f) => f.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(sortFlows(flows, 'name-desc').map((f) => f.name)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by node count most/least', () => {
    const flows = [
      flow({ id: 'mid', nodeCount: 5 }),
      flow({ id: 'big', nodeCount: 20 }),
      flow({ id: 'small', nodeCount: 1 }),
    ];
    expect(sortFlows(flows, 'most-nodes').map((f) => f.id)).toEqual(['big', 'mid', 'small']);
    expect(sortFlows(flows, 'least-nodes').map((f) => f.id)).toEqual(['small', 'mid', 'big']);
  });

  it('sorts newest/oldest by id (the placeholder ordering)', () => {
    const flows = [flow({ id: 'b' }), flow({ id: 'a' }), flow({ id: 'c' })];
    expect(sortFlows(flows, 'newest').map((f) => f.id)).toEqual(['c', 'b', 'a']);
    expect(sortFlows(flows, 'oldest').map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const flows = [flow({ name: 'B' }), flow({ name: 'A' })];
    const before = flows.map((f) => f.name);
    sortFlows(flows, 'name-asc');
    expect(flows.map((f) => f.name)).toEqual(before);
  });
});

describe('compareFlows', () => {
  it('returns 0 for an unknown sort key', () => {
    const cmp = compareFlows('bogus' as FlowSortOption);
    expect(cmp(flow({ id: 'a' }), flow({ id: 'b' }))).toBe(0);
  });
});

describe('sortFlowsFavoritesFirst (#120)', () => {
  it('floats favorites to the top, keeping the active sort within each partition', () => {
    const flows = [
      flow({ name: 'Charlie' }),
      flow({ name: 'Alpha', favorite: true }),
      flow({ name: 'Bravo' }),
      flow({ name: 'Zulu', favorite: true }),
    ];
    // Favorites (Alpha, Zulu) first — A–Z within — then non-favorites A–Z.
    expect(sortFlowsFavoritesFirst(flows, 'name-asc').map((f) => f.name)).toEqual([
      'Alpha',
      'Zulu',
      'Bravo',
      'Charlie',
    ]);
  });

  it('respects a non-alphabetical secondary sort within partitions', () => {
    const flows = [
      flow({ id: 'fav-small', nodeCount: 1, favorite: true }),
      flow({ id: 'plain-big', nodeCount: 20 }),
      flow({ id: 'fav-big', nodeCount: 10, favorite: true }),
      flow({ id: 'plain-small', nodeCount: 2 }),
    ];
    expect(sortFlowsFavoritesFirst(flows, 'most-nodes').map((f) => f.id)).toEqual([
      'fav-big',
      'fav-small',
      'plain-big',
      'plain-small',
    ]);
  });

  it('is stable/equivalent to sortFlows when nothing is favorited', () => {
    const flows = [flow({ name: 'Charlie' }), flow({ name: 'Alpha' }), flow({ name: 'Bravo' })];
    expect(sortFlowsFavoritesFirst(flows, 'name-asc').map((f) => f.name)).toEqual(
      sortFlows(flows, 'name-asc').map((f) => f.name),
    );
  });

  it('treats missing favorite (undefined) as not-favorite', () => {
    const flows = [flow({ name: 'Alpha' }), flow({ name: 'Bravo', favorite: true })];
    expect(sortFlowsFavoritesFirst(flows, 'name-asc').map((f) => f.name)).toEqual(['Bravo', 'Alpha']);
  });

  it('does not mutate the input array', () => {
    const flows = [flow({ name: 'B' }), flow({ name: 'A', favorite: true })];
    const before = flows.map((f) => f.name);
    sortFlowsFavoritesFirst(flows, 'name-asc');
    expect(flows.map((f) => f.name)).toEqual(before);
  });
});
