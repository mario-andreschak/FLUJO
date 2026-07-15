/**
 * Tier 2c — the pure ${var:NAME} resolver (resolveRunVars.ts).
 *
 * Pins the substitution contract: single/duplicate/unknown vars, trimming, the
 * empty-string policy for unknowns, and — critically — that it is crypto-free and
 * leaves `${global:...}` and `${tool:...}`/`${resource:...}` pills untouched so
 * run vars, config secrets, and tool pills never interfere.
 */
import {
  resolveRunVars,
  hasRunVarRef,
  referencedRunVars,
  isValidRunVarName,
} from '@/utils/shared/resolveRunVars';
import { findBindings } from '@/utils/shared/mcpBinding';

describe('resolveRunVars — substitution', () => {
  it('replaces a single ${var:NAME} with its value', () => {
    expect(resolveRunVars('plan: ${var:plan}', { plan: 'do X' })).toBe('plan: do X');
  });

  it('replaces every occurrence of a duplicated var', () => {
    expect(resolveRunVars('${var:x} and again ${var:x}', { x: 'Y' })).toBe('Y and again Y');
  });

  it('resolves multiple distinct vars in one pass', () => {
    expect(resolveRunVars('${var:a}/${var:b}', { a: '1', b: '2' })).toBe('1/2');
  });

  it('an UNKNOWN var resolves to empty string (never the literal token)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRunVars('x=${var:missing}=y', {})).toBe('x==y');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('trims whitespace inside the reference (${var: foo } → foo)', () => {
    expect(resolveRunVars('${var: foo }', { foo: 'bar' })).toBe('bar');
  });

  it('an empty value substitutes empty (not treated as unknown)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRunVars('[${var:e}]', { e: '' })).toBe('[]');
    expect(warn).not.toHaveBeenCalled(); // known var, no warning
    warn.mockRestore();
  });

  it('returns the text unchanged when there are no references', () => {
    expect(resolveRunVars('nothing here', { a: '1' })).toBe('nothing here');
  });

  it('tolerates an absent/empty vars map (unknowns collapse to empty)', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveRunVars('${var:x}', undefined)).toBe('');
    warn.mockRestore();
  });

  it('is stable across repeated calls (regex lastIndex is not leaked)', () => {
    const vars = { x: 'V' };
    expect(resolveRunVars('${var:x}', vars)).toBe('V');
    expect(resolveRunVars('${var:x}', vars)).toBe('V');
    expect(resolveRunVars('${var:x}', vars)).toBe('V');
  });
});

describe('resolveRunVars — coexistence with ${global:...} and pills (crypto-free, no interference)', () => {
  it('leaves ${global:VAR} untouched (that is a separate, decrypting resolver)', () => {
    expect(resolveRunVars('key=${global:API_KEY} plan=${var:p}', { p: 'go' })).toBe(
      'key=${global:API_KEY} plan=go'
    );
  });

  it('leaves ${tool:...} / ${resource:...} pills untouched and PILL_SCAN never sees a var', () => {
    const text = 'use ${tool:files__read} with ${var:path}';
    const resolved = resolveRunVars(text, { path: '/etc/hosts' });
    expect(resolved).toBe('use ${tool:files__read} with /etc/hosts');
    // The tool pill survives for the binding pass that runs later.
    const bindings = findBindings(resolved);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].name).toBe('read');
    expect(bindings[0].server).toBe('files');
  });

  it('the pill scanner never matches a ${var:...} token', () => {
    expect(findBindings('${var:anything} ${var:more}')).toHaveLength(0);
  });
});

describe('resolveRunVars — helpers', () => {
  it('hasRunVarRef detects references', () => {
    expect(hasRunVarRef('a ${var:x} b')).toBe(true);
    expect(hasRunVarRef('no refs')).toBe(false);
    expect(hasRunVarRef(undefined)).toBe(false);
  });

  it('referencedRunVars returns de-duplicated, trimmed names', () => {
    expect(referencedRunVars('${var:a} ${var: a } ${var:b}').sort()).toEqual(['a', 'b']);
    expect(referencedRunVars('none')).toEqual([]);
  });

  it('isValidRunVarName enforces a sane identifier', () => {
    expect(isValidRunVarName('plan')).toBe(true);
    expect(isValidRunVarName('my_var-2')).toBe(true);
    expect(isValidRunVarName('2bad')).toBe(false);
    expect(isValidRunVarName('has space')).toBe(false);
    expect(isValidRunVarName('')).toBe(false);
    expect(isValidRunVarName(undefined)).toBe(false);
  });
});
