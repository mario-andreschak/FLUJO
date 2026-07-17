/**
 * Tier 4 — persistent kv reference resolver (pure).
 *
 * Pins the `${kv:NAME}` substitution contract: known→value, unknown→'' (never
 * the raw token), trimming, totality, the scope-prefix parse, and the key/name
 * validity gate. Mirrors resolveRunVars.test.ts.
 */
import {
  resolveKvRefs,
  referencedKvKeys,
  hasKvRef,
  isValidKvName,
  parseKvRef,
} from '@/utils/shared/resolveKvRefs';

describe('resolveKvRefs (pure)', () => {
  it('substitutes known tokens and empties unknown', () => {
    expect(resolveKvRefs('a=${kv:counter} b=${kv:missing}', { counter: '5' })).toBe('a=5 b=');
  });

  it('trims token whitespace', () => {
    expect(resolveKvRefs('${kv: counter }', { counter: 'X' })).toBe('X');
  });

  it('fast-path returns the text unchanged when there are no refs', () => {
    expect(resolveKvRefs('nothing here', { a: '1' })).toBe('nothing here');
  });

  it('is total for empty / non-string input', () => {
    expect(resolveKvRefs('', {})).toBe('');
    // @ts-expect-error deliberately exercising totality
    expect(resolveKvRefs(undefined, {})).toBeUndefined();
  });
});

describe('parseKvRef', () => {
  it('defaults to the folder board', () => {
    expect(parseKvRef('counter')).toEqual({ scope: 'folder', key: 'counter' });
  });

  it('recognises scope prefixes', () => {
    expect(parseKvRef('global/x')).toEqual({ scope: 'global', key: 'x' });
    expect(parseKvRef('flow/y')).toEqual({ scope: 'flow', key: 'y' });
    expect(parseKvRef('folder/z')).toEqual({ scope: 'folder', key: 'z' });
  });

  it('treats an unknown prefix as a folder-scoped (later-rejected) key', () => {
    expect(parseKvRef('weird/z')).toEqual({ scope: 'folder', key: 'weird/z' });
  });
});

describe('referencedKvKeys / hasKvRef / isValidKvName', () => {
  it('collects unique, trimmed tokens', () => {
    expect(referencedKvKeys('${kv:a} ${kv: a } ${kv:global/b}').sort()).toEqual(['a', 'global/b']);
  });

  it('hasKvRef detects a reference', () => {
    expect(hasKvRef('x ${kv:a}')).toBe(true);
    expect(hasKvRef('x')).toBe(false);
  });

  it('isValidKvName accepts identifiers and rejects the rest', () => {
    expect(isValidKvName('foo_bar-1')).toBe(true);
    expect(isValidKvName('1foo')).toBe(false);
    expect(isValidKvName('a/b')).toBe(false);
    expect(isValidKvName('')).toBe(false);
  });
});
