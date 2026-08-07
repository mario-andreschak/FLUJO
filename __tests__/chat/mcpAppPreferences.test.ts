/**
 * Unit tests for the MCP Apps canvas dismissal/suppression preference helpers
 * (issue #375: "the canvas keeps re-opening even though I collapsed it").
 *
 * These are thin localStorage-backed helpers; the tests lock in per-conversation
 * isolation and tolerance of malformed stored values, since a corrupted entry
 * must degrade to "nothing dismissed / not suppressed" rather than throw.
 */

import {
  dismissedMcpAppPreferenceKey,
  readDismissedMcpAppKeys,
  writeMcpAppDismissed,
  writeMcpAppsDismissed,
  autoOpenSuppressedPreferenceKey,
  readAutoOpenSuppressed,
  writeAutoOpenSuppressed,
} from '@/frontend/components/Chat/mcpAppPreferences';

beforeEach(() => {
  window.localStorage.clear();
});

describe('dismissedMcpAppPreferenceKey / readDismissedMcpAppKeys', () => {
  it('namespaces the key per conversation', () => {
    expect(dismissedMcpAppPreferenceKey('c1')).toBe('flujo-ui:mcp-canvas:dismissed:c1');
  });

  it('returns an empty array when nothing is stored', () => {
    expect(readDismissedMcpAppKeys('c1')).toEqual([]);
  });

  it('tolerates malformed stored values (non-array / mixed types)', () => {
    window.localStorage.setItem(dismissedMcpAppPreferenceKey('c1'), JSON.stringify({ not: 'an array' }));
    expect(readDismissedMcpAppKeys('c1')).toEqual([]);
    window.localStorage.setItem(dismissedMcpAppPreferenceKey('c2'), JSON.stringify(['fs::ui://a', 42, null]));
    expect(readDismissedMcpAppKeys('c2')).toEqual(['fs::ui://a']);
  });
});

describe('writeMcpAppDismissed', () => {
  it('adds and removes a single key without disturbing others', () => {
    writeMcpAppDismissed('c1', 'fs::ui://a', true);
    writeMcpAppDismissed('c1', 'fs::ui://b', true);
    expect(new Set(readDismissedMcpAppKeys('c1'))).toEqual(new Set(['fs::ui://a', 'fs::ui://b']));
    writeMcpAppDismissed('c1', 'fs::ui://a', false);
    expect(readDismissedMcpAppKeys('c1')).toEqual(['fs::ui://b']);
  });

  it('is isolated per conversation', () => {
    writeMcpAppDismissed('c1', 'fs::ui://a', true);
    expect(readDismissedMcpAppKeys('c2')).toEqual([]);
  });
});

describe('writeMcpAppsDismissed (batch)', () => {
  it('dismisses every key in one call (collapse-all path)', () => {
    writeMcpAppsDismissed('c1', ['fs::ui://a', 'fs::ui://b'], true);
    expect(new Set(readDismissedMcpAppKeys('c1'))).toEqual(new Set(['fs::ui://a', 'fs::ui://b']));
  });

  it('un-dismisses every key in one call', () => {
    writeMcpAppsDismissed('c1', ['fs::ui://a', 'fs::ui://b'], true);
    writeMcpAppsDismissed('c1', ['fs::ui://a'], false);
    expect(readDismissedMcpAppKeys('c1')).toEqual(['fs::ui://b']);
  });

  it('is a no-op for an empty key list', () => {
    writeMcpAppDismissed('c1', 'fs::ui://a', true);
    writeMcpAppsDismissed('c1', [], true);
    expect(readDismissedMcpAppKeys('c1')).toEqual(['fs::ui://a']);
  });
});

describe('autoOpenSuppressedPreferenceKey / read/writeAutoOpenSuppressed', () => {
  it('namespaces the key per conversation', () => {
    expect(autoOpenSuppressedPreferenceKey('c1')).toBe('flujo-ui:mcp-canvas:auto-open-suppressed:c1');
  });

  it('defaults to not suppressed', () => {
    expect(readAutoOpenSuppressed('c1')).toBe(false);
  });

  it('round-trips true/false and is isolated per conversation', () => {
    writeAutoOpenSuppressed('c1', true);
    expect(readAutoOpenSuppressed('c1')).toBe(true);
    expect(readAutoOpenSuppressed('c2')).toBe(false);
    writeAutoOpenSuppressed('c1', false);
    expect(readAutoOpenSuppressed('c1')).toBe(false);
  });

  it('tolerates a malformed stored value', () => {
    window.localStorage.setItem(autoOpenSuppressedPreferenceKey('c1'), 'not-json{{{');
    expect(readAutoOpenSuppressed('c1')).toBe(false);
  });
});
