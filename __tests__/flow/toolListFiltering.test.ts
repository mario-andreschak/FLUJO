/**
 * Tests for tool-list filtering based on permission rules (issue #246).
 * Phase 2: wholly-denied tools are dropped from the advertised list.
 */

import { wildcardMatch, isWhollyDenied } from '@/backend/execution/flow/permissionEngine';
import { PermissionRule } from '@/shared/types/permissions';

describe('wildcardMatch', () => {
  it('matches exact strings', () => {
    expect(wildcardMatch('read_file', 'read_file')).toBe(true);
    expect(wildcardMatch('read_file', 'write_file')).toBe(false);
  });

  it('matches wildcard *', () => {
    expect(wildcardMatch('*', 'anything')).toBe(true);
    expect(wildcardMatch('*', '')).toBe(true);
  });

  it('matches prefix wildcard', () => {
    expect(wildcardMatch('read_*', 'read_file')).toBe(true);
    expect(wildcardMatch('read_*', 'write_file')).toBe(false);
    expect(wildcardMatch('read_*', 'read_')).toBe(true);
  });

  it('matches suffix wildcard', () => {
    expect(wildcardMatch('*_file', 'read_file')).toBe(true);
    expect(wildcardMatch('*_file', 'read_dir')).toBe(false);
  });
});

describe('isWhollyDenied', () => {
  it('returns false when no rules', () => {
    expect(isWhollyDenied([], 'bash')).toBe(false);
  });

  it('returns true when deny rule with wildcard resource matches', () => {
    const rules: PermissionRule[] = [
      { action: 'bash', resource: '*', effect: 'deny' },
    ];
    expect(isWhollyDenied(rules, 'bash')).toBe(true);
  });

  it('returns false when allow rule matches', () => {
    const rules: PermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'allow' },
    ];
    expect(isWhollyDenied(rules, 'read_file')).toBe(false);
  });

  it('returns false for a tool not matched by any rule', () => {
    const rules: PermissionRule[] = [
      { action: 'bash', resource: '*', effect: 'deny' },
    ];
    expect(isWhollyDenied(rules, 'read_file')).toBe(false);
  });

  it('uses last-match-wins: allow after deny = not wholly denied', () => {
    const rules: PermissionRule[] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read_file', resource: '*', effect: 'allow' },
    ];
    expect(isWhollyDenied(rules, 'read_file')).toBe(false);
  });

  it('uses last-match-wins: deny after allow = wholly denied', () => {
    const rules: PermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'allow' },
      { action: '*', resource: '*', effect: 'deny' },
    ];
    expect(isWhollyDenied(rules, 'read_file')).toBe(true);
  });
});
