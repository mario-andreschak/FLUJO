import { readUiPreference, writeUiPreference } from '@/frontend/hooks/useUiPreference';

// The hook itself is a thin useState/useCallback wrapper around these pure
// storage helpers, which carry the risk-bearing logic (JSON round-trip, missing
// key / malformed value fallback, SSR guard). We exercise them directly in the
// node test env with a minimal in-memory localStorage stub bolted onto a fake
// `window`, and restore the environment afterwards so no other suite is affected.

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const g = global as unknown as { window?: { localStorage: MemoryStorage } };
let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  g.window = { localStorage: storage };
});

afterEach(() => {
  delete g.window;
});

describe('readUiPreference', () => {
  it('returns the initial value when the key is missing', () => {
    expect(readUiPreference('flujo-ui:test:sort', 'name-asc')).toBe('name-asc');
  });

  it('returns the initial value when there is no window (SSR)', () => {
    delete g.window;
    expect(readUiPreference('flujo-ui:test:sort', 'name-asc')).toBe('name-asc');
  });

  it('parses a previously stored value', () => {
    storage.setItem('flujo-ui:test:group', JSON.stringify('folder'));
    expect(readUiPreference('flujo-ui:test:group', 'none')).toBe('folder');
  });

  it('falls back to the initial value on malformed JSON', () => {
    storage.setItem('flujo-ui:test:group', 'not json{');
    expect(readUiPreference('flujo-ui:test:group', 'none')).toBe('none');
  });
});

describe('writeUiPreference', () => {
  it('round-trips a scalar preference', () => {
    writeUiPreference('flujo-ui:test:view', 'compact');
    expect(readUiPreference('flujo-ui:test:view', 'grid')).toBe('compact');
  });

  it('is a no-op on the server without throwing', () => {
    delete g.window;
    expect(() => writeUiPreference('flujo-ui:test:view', 'compact')).not.toThrow();
  });
});

describe('collapsed sections (Set <-> array) persistence pattern', () => {
  const KEY = 'flujo-ui:test:collapsed';

  // The dashboards persist collapsedKeys as a string[] and derive a Set on read;
  // this mirrors that contract end-to-end through the storage helpers.
  it('round-trips a collapsed-key set via an array', () => {
    const collapsed = new Set<string>(['letter:A', 'folder:Work']);
    writeUiPreference(KEY, Array.from(collapsed));

    const restored = new Set(readUiPreference<string[]>(KEY, []));
    expect(restored.has('letter:A')).toBe(true);
    expect(restored.has('folder:Work')).toBe(true);
    expect(restored.has('letter:Z')).toBe(false);
    expect(restored.size).toBe(2);
  });

  it('defaults to an empty set when nothing is stored', () => {
    const restored = new Set(readUiPreference<string[]>(KEY, []));
    expect(restored.size).toBe(0);
  });
});
