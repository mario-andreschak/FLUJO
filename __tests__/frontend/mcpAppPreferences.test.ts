import {
  readDismissedMcpAppKeys,
  writeMcpAppDismissed,
} from '@/frontend/components/Chat/mcpAppPreferences';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

const globalWithWindow = global as unknown as {
  window?: { localStorage: MemoryStorage };
};

beforeEach(() => {
  globalWithWindow.window = { localStorage: new MemoryStorage() };
});

afterEach(() => {
  delete globalWithWindow.window;
});

describe('MCP App dismissal preferences', () => {
  it('persists close intent per conversation and clears it on manual reopen', () => {
    const key = 'browser::ui://browser/view';
    writeMcpAppDismissed('conversation-1', key, true);

    expect(readDismissedMcpAppKeys('conversation-1')).toEqual([key]);
    expect(readDismissedMcpAppKeys('conversation-2')).toEqual([]);

    writeMcpAppDismissed('conversation-1', key, false);
    expect(readDismissedMcpAppKeys('conversation-1')).toEqual([]);
  });

  it('deduplicates repeated close writes', () => {
    const key = 'browser::ui://browser/view';
    writeMcpAppDismissed('conversation-1', key, true);
    writeMcpAppDismissed('conversation-1', key, true);
    expect(readDismissedMcpAppKeys('conversation-1')).toEqual([key]);
  });
});
