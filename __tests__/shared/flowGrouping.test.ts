import {
  FlowGroupingItem,
  FlowSortOption,
  bucketNodeCount,
  deriveFlowSortGroup,
  recencyBucket,
  flowTimestamp,
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
  createdAt: partial.createdAt,
  updatedAt: partial.updatedAt,
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

  it('folds date sorts into coarse recency buckets from the flow timestamp (#108)', () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const DAY = 24 * HOUR;
    expect(deriveFlowSortGroup(flow({ updatedAt: now - HOUR }), 'newest').key).toBe('recency:today');
    expect(deriveFlowSortGroup(flow({ updatedAt: now - 3 * DAY }), 'oldest').key).toBe('recency:week');
    expect(deriveFlowSortGroup(flow({ updatedAt: now - 20 * DAY }), 'newest').key).toBe('recency:month');
    expect(deriveFlowSortGroup(flow({ updatedAt: now - 100 * DAY }), 'newest').key).toBe('recency:older');
  });

  it('folds flows without a timestamp into the "No date" bucket under date sorts', () => {
    expect(deriveFlowSortGroup(flow({}), 'newest')).toEqual({ key: 'recency:unknown', label: 'No date' });
    expect(deriveFlowSortGroup(flow({}), 'oldest')).toEqual({ key: 'recency:unknown', label: 'No date' });
  });
});

describe('flowTimestamp (#108)', () => {
  it('prefers updatedAt, falls back to createdAt, then 0', () => {
    expect(flowTimestamp(flow({ createdAt: 100, updatedAt: 200 }))).toBe(200);
    expect(flowTimestamp(flow({ createdAt: 100 }))).toBe(100);
    expect(flowTimestamp(flow({}))).toBe(0);
  });
});

describe('recencyBucket (#108)', () => {
  const now = 1_000_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  it('maps ages onto the correct rolling window', () => {
    expect(recencyBucket(now - 1000, now).key).toBe('recency:today');
    expect(recencyBucket(now - 2 * DAY, now).key).toBe('recency:week');
    expect(recencyBucket(now - 10 * DAY, now).key).toBe('recency:month');
    expect(recencyBucket(now - 40 * DAY, now).key).toBe('recency:older');
  });
  it('returns the "No date" bucket for a missing (0) timestamp', () => {
    expect(recencyBucket(0, now)).toEqual({ key: 'recency:unknown', label: 'No date' });
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

  it('sorts newest/oldest by real timestamp (updatedAt), not by id (#108)', () => {
    const flows = [
      flow({ id: 'mid', updatedAt: 200 }),
      flow({ id: 'new', updatedAt: 300 }),
      flow({ id: 'old', updatedAt: 100 }),
    ];
    expect(sortFlows(flows, 'newest').map((f) => f.id)).toEqual(['new', 'mid', 'old']);
    expect(sortFlows(flows, 'oldest').map((f) => f.id)).toEqual(['old', 'mid', 'new']);
  });

  it('falls back to createdAt when updatedAt is absent (#108)', () => {
    const flows = [
      flow({ id: 'b', createdAt: 200 }),
      flow({ id: 'a', createdAt: 100 }),
      flow({ id: 'c', updatedAt: 300 }),
    ];
    expect(sortFlows(flows, 'newest').map((f) => f.id)).toEqual(['c', 'b', 'a']);
  });

  it('sorts flows without any timestamp last under newest, first under oldest (#108)', () => {
    const flows = [
      flow({ id: 'has', updatedAt: 500 }),
      flow({ id: 'none' }),
    ];
    expect(sortFlows(flows, 'newest').map((f) => f.id)).toEqual(['has', 'none']);
    expect(sortFlows(flows, 'oldest').map((f) => f.id)).toEqual(['none', 'has']);
  });

  it('applies a deterministic name-then-id tiebreak for equal timestamps (#108)', () => {
    const flows = [
      flow({ id: 'z', name: 'Bravo', updatedAt: 100 }),
      flow({ id: 'a', name: 'Bravo', updatedAt: 100 }),
      flow({ id: 'm', name: 'Alpha', updatedAt: 100 }),
    ];
    // Equal timestamps → name A–Z, then id A–Z as the final tiebreak.
    expect(sortFlows(flows, 'newest').map((f) => f.id)).toEqual(['m', 'a', 'z']);
    expect(sortFlows(flows, 'oldest').map((f) => f.id)).toEqual(['m', 'a', 'z']);
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

  it('keeps favorites first while sorting each partition newest-first (#120)', () => {
    const flows = [
      flow({ id: 'plain-new', updatedAt: 400 }),
      flow({ id: 'fav-old', updatedAt: 100, favorite: true }),
      flow({ id: 'plain-old', updatedAt: 200 }),
      flow({ id: 'fav-new', updatedAt: 300, favorite: true }),
    ];
    // Favorites (by newest) first, then non-favorites (by newest).
    expect(sortFlowsFavoritesFirst(flows, 'newest').map((f) => f.id)).toEqual([
      'fav-new',
      'fav-old',
      'plain-new',
      'plain-old',
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
