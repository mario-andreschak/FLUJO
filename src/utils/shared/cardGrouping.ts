/**
 * Shared card-grouping helpers for the Models / MCP / Flow list surfaces.
 *
 * Two related features share this module (issues #71 and #73):
 *   - #71 "folders": explicit, user-assigned folders (`groupByFolder`).
 *   - #73 "auto-fold on sort": buckets derived from the active sort key
 *     (`groupItems` + surface-specific `deriveGroup` callbacks).
 *
 * All functions are pure and order-preserving where noted, so they are cheap to
 * unit-test and safe to run inside a `useMemo`.
 */

export interface CardGroup<T> {
  /** Stable key for collapse state (e.g. "letter:A", "folder:Work"). */
  key: string;
  /** Human-readable header text (e.g. "A", "Work", "Ungrouped"). */
  label: string;
  items: T[];
}

/** Header label used for items that have no folder assigned. */
export const UNGROUPED_LABEL = 'Ungrouped';
/** Stable key for the "Ungrouped" bucket (never collides with a folder name). */
export const UNGROUPED_KEY = 'folder:__ungrouped__';

/**
 * Group items by a caller-derived key/label, PRESERVING the order in which
 * groups are first encountered. Because the caller passes an already
 * sorted/filtered array, group order follows the active sort direction and no
 * re-sorting happens here (used for #73's sort-derived folding).
 */
export function groupItems<T>(
  items: T[],
  deriveGroup: (item: T) => { key: string; label: string },
): CardGroup<T>[] {
  const groups: CardGroup<T>[] = [];
  const index = new Map<string, CardGroup<T>>();

  for (const item of items) {
    const { key, label } = deriveGroup(item);
    let group = index.get(key);
    if (!group) {
      group = { key, label, items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
}

/**
 * Alphabetical bucket for a name: the upper-cased first character, with any
 * non A–Z leading character (digits, symbols, empty) collapsed into a single
 * "#" bucket. Returns a `{ key, label }` suitable for {@link groupItems}.
 */
export function alphaBucket(name: string | undefined | null): { key: string; label: string } {
  const ch = (name ?? '').trim().charAt(0).toUpperCase();
  if (ch >= 'A' && ch <= 'Z') {
    return { key: `letter:${ch}`, label: ch };
  }
  return { key: 'letter:#', label: '#' };
}

/**
 * Group items by an explicit, user-assigned folder (#71).
 *
 * Named folders come first, sorted A–Z; items without a folder fall into a
 * single "Ungrouped" bucket that is always rendered LAST. Absence of a folder
 * (undefined / empty / whitespace) is treated as "Ungrouped", so pre-existing
 * data without the field keeps working with zero migration.
 */
export function groupByFolder<T>(
  items: T[],
  getFolder: (item: T) => string | undefined,
  ungroupedLabel: string = UNGROUPED_LABEL,
): CardGroup<T>[] {
  const named = new Map<string, T[]>();
  const ungrouped: T[] = [];

  for (const item of items) {
    const folder = getFolder(item)?.trim();
    if (folder) {
      const bucket = named.get(folder);
      if (bucket) {
        bucket.push(item);
      } else {
        named.set(folder, [item]);
      }
    } else {
      ungrouped.push(item);
    }
  }

  const groups: CardGroup<T>[] = Array.from(named.keys())
    .sort((a, b) => a.localeCompare(b))
    .map((folder) => ({ key: `folder:${folder}`, label: folder, items: named.get(folder)! }));

  if (ungrouped.length > 0) {
    groups.push({ key: UNGROUPED_KEY, label: ungroupedLabel, items: ungrouped });
  }

  return groups;
}

/**
 * Distinct, A–Z sorted list of folders currently in use across `items` — feeds
 * the "Move to folder…" picker so users can reuse existing folder names.
 */
export function collectFolders<T>(
  items: T[],
  getFolder: (item: T) => string | undefined,
): string[] {
  const set = new Set<string>();
  for (const item of items) {
    const folder = getFolder(item)?.trim();
    if (folder) {
      set.add(folder);
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
