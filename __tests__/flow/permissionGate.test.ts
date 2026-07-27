/**
 * Tests for the per-call permission gate (issue #246).
 * Phase 3: allow/deny/ask evaluation for individual tool calls.
 */

import { evaluatePermission, extractResource } from '@/backend/execution/flow/permissionEngine';
import { PermissionRule, SavedPermissionRule } from '@/shared/types/permissions';

describe('extractResource', () => {
  it('returns * when no args', () => {
    expect(extractResource({})).toBe('*');
  });

  it('extracts path argument', () => {
    expect(extractResource({ path: '/tmp/foo.txt' })).toBe('/tmp/foo.txt');
  });

  it('extracts command argument', () => {
    expect(extractResource({ command: 'ls -la' })).toBe('ls -la');
  });

  it('extracts first string value as fallback', () => {
    expect(extractResource({ query: 'some text' })).toBe('some text');
  });

  it('prefers path over other keys', () => {
    expect(extractResource({ query: 'text', path: '/file' })).toBe('/file');
  });
});

describe('evaluatePermission', () => {
  const noRules: PermissionRule[] = [];
  const noSaved: SavedPermissionRule[] = [];

  it('defaults to ask when no rules', () => {
    expect(evaluatePermission(noRules, noSaved, 'my-server', 'bash', '*')).toBe('ask');
  });

  it('returns allow when allow rule matches', () => {
    const rules: PermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'allow' },
    ];
    expect(evaluatePermission(rules, noSaved, 'fs', 'read_file', '/tmp/x')).toBe('allow');
  });

  it('returns deny when deny rule matches', () => {
    const rules: PermissionRule[] = [
      { action: 'bash', resource: '*', effect: 'deny' },
    ];
    expect(evaluatePermission(rules, noSaved, 'shell', 'bash', 'rm -rf /')).toBe('deny');
  });

  it('deny beats saved allow', () => {
    const rules: PermissionRule[] = [
      { action: 'bash', resource: '*', effect: 'deny' },
    ];
    const saved: SavedPermissionRule[] = [
      { action: 'bash', resource: '*', effect: 'allow', savedAt: Date.now(), server: 'shell', tool: 'bash' },
    ];
    expect(evaluatePermission(rules, saved, 'shell', 'bash', 'ls')).toBe('deny');
  });

  it('saved allow overrides ask', () => {
    const rules: PermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'ask' },
    ];
    const saved: SavedPermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'allow', savedAt: Date.now(), server: 'fs', tool: 'read_file' },
    ];
    expect(evaluatePermission(rules, saved, 'fs', 'read_file', '/home')).toBe('allow');
  });

  it('uses last-match-wins for configured rules', () => {
    const rules: PermissionRule[] = [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read_file', resource: '*', effect: 'allow' },
    ];
    expect(evaluatePermission(rules, noSaved, 'fs', 'read_file', '/home')).toBe('allow');
    expect(evaluatePermission(rules, noSaved, 'fs', 'write_file', '/home')).toBe('deny');
  });

  it('wildcard action matches all tools', () => {
    const rules: PermissionRule[] = [
      { action: '*', resource: '*', effect: 'allow' },
    ];
    expect(evaluatePermission(rules, noSaved, 'any-server', 'any_tool', '*')).toBe('allow');
  });

  it('resource wildcard in saved rule matches specific resource', () => {
    const saved: SavedPermissionRule[] = [
      { action: 'read_file', resource: '*', effect: 'allow', savedAt: Date.now(), server: 'fs', tool: 'read_file' },
    ];
    expect(evaluatePermission(noRules, saved, 'fs', 'read_file', '/etc/passwd')).toBe('allow');
  });
});
