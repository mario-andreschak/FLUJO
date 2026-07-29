/**
 * Unit tests for the canvas state helpers (issue #216).
 *
 * The docked MCP-Apps canvas keeps a conversation-level map of live apps keyed
 * by `serverName::uri`. These pure helpers own the load-bearing behaviour the
 * dock relies on: identity keying, open/focus, live update-in-place (badge on
 * background, silent on active), LRU ordering, the 16-tab cap + eviction, and
 * close/refocus. This suite locks that behaviour in.
 */

import {
  DEFAULT_CANVAS_TAB_CAP,
  canvasKey,
  canvasEntries,
  emptyCanvasState,
  openCanvasApp,
  updateCanvasApp,
  syncCanvasAppResult,
  setActiveCanvasTab,
  markRead,
  closeCanvasApp,
  hasUnread,
  enforceCap,
  type CanvasState,
} from '@/frontend/components/Chat/canvasState';

const open = (
  state: CanvasState,
  serverName: string,
  uri: string,
  now: number,
  extra: Record<string, unknown> = {},
) => openCanvasApp(state, { serverName, uri, ...extra }, now).state;

describe('canvasKey', () => {
  it('derives identity from serverName + uri (no server-specific fields)', () => {
    expect(canvasKey('fs', 'ui://devcanvas/diff')).toBe('fs::ui://devcanvas/diff');
  });

  it('routes the same serverName::uri to the same entry, different to a new one', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1);
    s = open(s, 'fs', 'ui://a', 2); // same key
    expect(s.order).toEqual(['fs::ui://a']);
    s = open(s, 'fs', 'ui://b', 3); // different key
    expect(s.order).toEqual(['fs::ui://a', 'fs::ui://b']);
  });
});

describe('openCanvasApp', () => {
  it('adds a new entry, focuses it, and marks it read', () => {
    const { state, evicted } = openCanvasApp(
      emptyCanvasState,
      { serverName: 'fs', uri: 'ui://a', toolName: 'write_file', resultContent: '{"content":[]}' },
      100,
    );
    expect(evicted).toEqual([]);
    expect(state.activeKey).toBe('fs::ui://a');
    const e = state.entries['fs::ui://a'];
    expect(e.unread).toBe(false);
    expect(e.toolName).toBe('write_file');
    expect(e.latestResultContent).toBe('{"content":[]}');
    expect(e.lastActiveAt).toBe(100);
  });

  it('re-opening an existing key refreshes payload without duplicating', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1, { resultContent: 'v1' });
    const r = openCanvasApp(s, { serverName: 'fs', uri: 'ui://a', resultContent: 'v2' }, 5);
    expect(r.state.order).toEqual(['fs::ui://a']);
    expect(r.state.entries['fs::ui://a'].latestResultContent).toBe('v2');
    expect(r.state.activeKey).toBe('fs::ui://a');
  });
});

describe('updateCanvasApp (live re-feed)', () => {
  it('is a no-op for a key that is not open', () => {
    const s = updateCanvasApp(emptyCanvasState, { serverName: 'fs', uri: 'ui://x', resultContent: 'z' }, 9);
    expect(s).toBe(emptyCanvasState);
  });

  it('updates the ACTIVE tab silently (no unread badge) and bumps recency', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1);
    s = updateCanvasApp(s, { serverName: 'fs', uri: 'ui://a', resultContent: 'new' }, 50);
    const e = s.entries['fs::ui://a'];
    expect(e.unread).toBe(false);
    expect(e.latestResultContent).toBe('new');
    expect(e.updatedAt).toBe(50);
    expect(e.lastActiveAt).toBe(50);
  });

  it('sets the unread badge when the updated tab is in the BACKGROUND', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1); // a active... then open b
    s = open(s, 'fs', 'ui://b', 2); // b becomes active, a is background
    s = updateCanvasApp(s, { serverName: 'fs', uri: 'ui://a', resultContent: 'bg' }, 99);
    expect(s.entries['fs::ui://a'].unread).toBe(true);
    expect(s.entries['fs::ui://a'].lastActiveAt).toBe(1); // recency NOT bumped for background
    expect(s.entries['fs::ui://b'].unread).toBe(false);
    expect(hasUnread(s)).toBe(true);
  });
});

describe('syncCanvasAppResult (issue #331)', () => {
  it.each(['flujo', 'filesystem', 'bash'])(
    'auto-opens an app shipped by the built-in %s server in the PiP canvas',
    (serverName) => {
      const { state, evicted } = syncCanvasAppResult(
        emptyCanvasState,
        { serverName, uri: 'ui://internal/app', resultContent: 'ready' },
        10,
      );

      expect(evicted).toEqual([]);
      expect(state.activeKey).toBe(`${serverName}::ui://internal/app`);
      expect(state.entries[state.activeKey!].latestResultContent).toBe('ready');
    },
  );

  it('keeps an external app behind the explicit click-to-mount consent gate', () => {
    const result = syncCanvasAppResult(
      emptyCanvasState,
      { serverName: 'github', uri: 'ui://github/app', resultContent: 'untrusted' },
      10,
    );

    expect(result.state).toBe(emptyCanvasState);
    expect(result.evicted).toEqual([]);
  });

  it('re-feeds an external app after the user has explicitly opened it', () => {
    let state = open(
      emptyCanvasState,
      'github',
      'ui://github/app',
      1,
      { resultContent: 'old' },
    );

    state = syncCanvasAppResult(
      state,
      { serverName: 'github', uri: 'ui://github/app', resultContent: 'new' },
      20,
    ).state;

    expect(state.entries['github::ui://github/app'].latestResultContent).toBe('new');
  });
});

describe('setActiveCanvasTab / markRead', () => {
  it('activating a tab clears its unread badge and bumps recency', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1);
    s = open(s, 'fs', 'ui://b', 2);
    s = updateCanvasApp(s, { serverName: 'fs', uri: 'ui://a', resultContent: 'bg' }, 3);
    expect(s.entries['fs::ui://a'].unread).toBe(true);
    s = setActiveCanvasTab(s, 'fs::ui://a', 10);
    expect(s.activeKey).toBe('fs::ui://a');
    expect(s.entries['fs::ui://a'].unread).toBe(false);
    expect(s.entries['fs::ui://a'].lastActiveAt).toBe(10);
  });

  it('markRead clears a badge without changing focus', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1);
    s = open(s, 'fs', 'ui://b', 2);
    s = updateCanvasApp(s, { serverName: 'fs', uri: 'ui://a', resultContent: 'bg' }, 3);
    s = markRead(s, 'fs::ui://a');
    expect(s.entries['fs::ui://a'].unread).toBe(false);
    expect(s.activeKey).toBe('fs::ui://b');
  });
});

describe('cap + LRU eviction', () => {
  it('has a default cap of 16', () => {
    expect(DEFAULT_CANVAS_TAB_CAP).toBe(16);
  });

  it('evicts the least-recently-active tab when the cap is exceeded', () => {
    let s: CanvasState = emptyCanvasState;
    // Open 3 tabs at increasing times; cap = 2 → the oldest (a) is evicted.
    s = open(s, 'fs', 'ui://a', 1);
    s = open(s, 'fs', 'ui://b', 2);
    const r = openCanvasApp(s, { serverName: 'fs', uri: 'ui://c' }, 3, 2);
    expect(r.evicted).toEqual(['fs::ui://a']);
    expect(r.state.order).toEqual(['fs::ui://b', 'fs::ui://c']);
    expect(r.state.entries['fs::ui://a']).toBeUndefined();
    expect(r.state.activeKey).toBe('fs::ui://c');
  });

  it('never evicts the just-opened (protected) tab even if it is newest', () => {
    let s: CanvasState = emptyCanvasState;
    s = open(s, 'fs', 'ui://a', 100); // most recent by time but will be background
    s = open(s, 'fs', 'ui://b', 50, {}); // note: earlier timestamp
    // cap 1 → only one may survive; the just-opened 'b' is protected.
    const r = enforceCap(s, 1, 'fs::ui://b');
    expect(r.state.order).toEqual(['fs::ui://b']);
    expect(r.evicted).toEqual(['fs::ui://a']);
  });

  it('LRU picks the smallest lastActiveAt across mixed activity', () => {
    let s: CanvasState = emptyCanvasState;
    s = open(s, 'fs', 'ui://a', 10);
    s = open(s, 'fs', 'ui://b', 20);
    s = open(s, 'fs', 'ui://c', 30);
    // Touch 'a' so it is no longer the oldest; now 'b' is the LRU victim.
    s = setActiveCanvasTab(s, 'fs::ui://a', 40);
    const r = openCanvasApp(s, { serverName: 'fs', uri: 'ui://d' }, 50, 3);
    expect(r.evicted).toEqual(['fs::ui://b']);
  });
});

describe('closeCanvasApp', () => {
  it('removes a tab and refocuses the most-recently-active survivor', () => {
    let s: CanvasState = emptyCanvasState;
    s = open(s, 'fs', 'ui://a', 10);
    s = open(s, 'fs', 'ui://b', 20);
    s = open(s, 'fs', 'ui://c', 30); // c active
    s = closeCanvasApp(s, 'fs::ui://c');
    expect(s.entries['fs::ui://c']).toBeUndefined();
    expect(s.activeKey).toBe('fs::ui://b'); // newest survivor
    expect(canvasEntries(s).map((e) => e.key)).toEqual(['fs::ui://a', 'fs::ui://b']);
  });

  it('closing the last tab leaves an empty, hidden dock', () => {
    let s = open(emptyCanvasState, 'fs', 'ui://a', 1);
    s = closeCanvasApp(s, 'fs::ui://a');
    expect(s.activeKey).toBeNull();
    expect(canvasEntries(s)).toEqual([]);
  });

  it('closing a background tab keeps the active tab focused', () => {
    let s: CanvasState = emptyCanvasState;
    s = open(s, 'fs', 'ui://a', 10);
    s = open(s, 'fs', 'ui://b', 20); // b active
    s = closeCanvasApp(s, 'fs::ui://a');
    expect(s.activeKey).toBe('fs::ui://b');
  });
});
