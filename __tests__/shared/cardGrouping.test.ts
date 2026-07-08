import {
  groupItems,
  groupByFolder,
  alphaBucket,
  collectFolders,
  UNGROUPED_LABEL,
  UNGROUPED_KEY,
  CardGroup,
} from '@/utils/shared/cardGrouping';

interface Item {
  name: string;
  folder?: string;
}

const labels = (groups: CardGroup<unknown>[]) => groups.map((g) => g.label);

describe('alphaBucket', () => {
  it('uses the upper-cased first letter', () => {
    expect(alphaBucket('apple')).toEqual({ key: 'letter:A', label: 'A' });
    expect(alphaBucket('Banana')).toEqual({ key: 'letter:B', label: 'B' });
  });

  it('buckets digits, symbols, empty and whitespace into "#"', () => {
    expect(alphaBucket('3things')).toEqual({ key: 'letter:#', label: '#' });
    expect(alphaBucket('_hidden')).toEqual({ key: 'letter:#', label: '#' });
    expect(alphaBucket('')).toEqual({ key: 'letter:#', label: '#' });
    expect(alphaBucket('   ')).toEqual({ key: 'letter:#', label: '#' });
    expect(alphaBucket(undefined)).toEqual({ key: 'letter:#', label: '#' });
  });
});

describe('groupItems', () => {
  it('returns an empty array for no items', () => {
    expect(groupItems([], () => ({ key: 'x', label: 'x' }))).toEqual([]);
  });

  it('preserves the order in which groups are first encountered (no re-sorting)', () => {
    const items: Item[] = [
      { name: 'Zebra' },
      { name: 'apple' },
      { name: 'Ant' },
      { name: 'Bee' },
    ];
    const groups = groupItems(items, (i) => alphaBucket(i.name));
    // Encounter order: Z, then A (apple + Ant), then B.
    expect(labels(groups)).toEqual(['Z', 'A', 'B']);
    expect(groups[1].items.map((i) => i.name)).toEqual(['apple', 'Ant']);
  });

  it('keeps a single group when every item shares a bucket', () => {
    const groups = groupItems(
      [{ name: 'a' }, { name: 'and' }],
      (i) => alphaBucket(i.name),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });
});

describe('groupByFolder', () => {
  it('returns an empty array for no items', () => {
    expect(groupByFolder([] as Item[], (i) => i.folder)).toEqual([]);
  });

  it('produces a single Ungrouped bucket when nothing has a folder', () => {
    const items: Item[] = [{ name: 'a' }, { name: 'b' }];
    const groups = groupByFolder(items, (i) => i.folder);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(UNGROUPED_KEY);
    expect(groups[0].label).toBe(UNGROUPED_LABEL);
  });

  it('sorts named folders A-Z and always puts Ungrouped last', () => {
    const items: Item[] = [
      { name: 'a', folder: 'Work' },
      { name: 'b' },
      { name: 'c', folder: 'Admin' },
      { name: 'd', folder: 'Work' },
    ];
    const groups = groupByFolder(items, (i) => i.folder);
    expect(labels(groups)).toEqual(['Admin', 'Work', UNGROUPED_LABEL]);
    expect(groups[1].items.map((i) => i.name)).toEqual(['a', 'd']);
    expect(groups[2].items.map((i) => i.name)).toEqual(['b']);
  });

  it('treats empty/whitespace folder as Ungrouped', () => {
    const items: Item[] = [
      { name: 'a', folder: '   ' },
      { name: 'b', folder: '' },
    ];
    const groups = groupByFolder(items, (i) => i.folder);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe(UNGROUPED_LABEL);
  });

  it('honors a custom ungrouped label', () => {
    const groups = groupByFolder([{ name: 'a' }] as Item[], (i) => i.folder, 'No folder');
    expect(groups[0].label).toBe('No folder');
  });
});

describe('collectFolders', () => {
  it('returns distinct, A-Z sorted folder names and ignores blanks', () => {
    const items: Item[] = [
      { name: 'a', folder: 'Work' },
      { name: 'b', folder: 'Admin' },
      { name: 'c', folder: 'Work' },
      { name: 'd' },
      { name: 'e', folder: '  ' },
    ];
    expect(collectFolders(items, (i) => i.folder)).toEqual(['Admin', 'Work']);
  });

  it('returns an empty array when nothing is foldered', () => {
    expect(collectFolders([{ name: 'a' }] as Item[], (i) => i.folder)).toEqual([]);
  });
});
