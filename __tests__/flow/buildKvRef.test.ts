/**
 * buildKvRef (issue #203) — inverse of parseKvRef used by the FlowBuilder
 * capture editors to turn a {scope, key} pair back into the stored captureKv
 * string. Must round-trip losslessly with parseKvRef and keep the `folder`
 * scope as a bare key (the DSL default).
 */
import { buildKvRef, parseKvRef, KV_SCOPE_KINDS } from '@/utils/shared/resolveKvRefs';

describe('buildKvRef', () => {
  it('emits a bare key for the default folder scope', () => {
    expect(buildKvRef('folder', 'counter')).toBe('counter');
  });

  it('emits scope/key for flow and global scopes', () => {
    expect(buildKvRef('flow', 'cursor')).toBe('flow/cursor');
    expect(buildKvRef('global', 'seen')).toBe('global/seen');
  });

  it('returns empty string for an empty / whitespace key (so callers omit it)', () => {
    expect(buildKvRef('folder', '')).toBe('');
    expect(buildKvRef('flow', '   ')).toBe('');
  });

  it('trims the key before combining', () => {
    expect(buildKvRef('flow', '  cursor  ')).toBe('flow/cursor');
  });

  it('round-trips with parseKvRef across every scope', () => {
    for (const scope of KV_SCOPE_KINDS) {
      const built = buildKvRef(scope, 'k');
      const parsed = parseKvRef(built);
      expect(parsed.scope).toBe(scope);
      expect(parsed.key).toBe('k');
    }
  });

  it('parseKvRef of an empty token yields the folder default', () => {
    expect(parseKvRef('')).toEqual({ scope: 'folder', key: '' });
  });
});
