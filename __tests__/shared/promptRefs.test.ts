/**
 * Tests for the prompt-authoring reference layer (issue #183 items 4 & 5).
 *
 * `promptRefs` is the RENDERING-facing superset of `mcpBinding`: it recognizes
 * `${res:NAME}` run-resource references (so the PromptBuilder can render them as
 * pills) IN ADDITION to `${tool:...}` / `${resource:...}` pills — WITHOUT making
 * `${res:...}` visible to the compiler-facing `findBindings` (whose exact set the
 * flow compiler `stripPills` and validation depend on).
 */

import {
  findPromptRefs,
  parsePromptRefPill,
  encodePromptRefPill,
  promptRefLabel,
  extractResourceRefNames,
} from '@/utils/shared/promptRefs';
import { findBindings } from '@/utils/shared/mcpBinding';

describe('findPromptRefs', () => {
  it('finds tool, resource, and run-resource refs in document order; ignores ${var:} / ${global:}', () => {
    const text =
      'A ${tool:files__read} B ${res:foo} C ${resource:docs__file:///a} D ${var:x} E ${res:bar} ${global:KEY}';
    const found = findPromptRefs(text);
    expect(found.map((r) => `${r.kind}:${r.server}:${r.name}`)).toEqual([
      'tool:files:read',
      'runres::foo',
      'resource:docs:file:///a',
      'runres::bar',
    ]);
    // fullMatch round-trips to the exact substring at the reported index.
    found.forEach((r) => expect(text.slice(r.index, r.index + r.fullMatch.length)).toBe(r.fullMatch));
  });

  it('returns an empty array when there are no references', () => {
    expect(findPromptRefs('just prose and ${var:x} and ${global:Y}')).toEqual([]);
  });
});

describe('compiler invariant: ${res:} stays INVISIBLE to findBindings', () => {
  it('findBindings never reports a run-resource reference (so stripPills preserves it)', () => {
    const text = 'read ${res:foo} and ${tool:files__read}';
    const bindings = findBindings(text);
    expect(bindings.map((b) => b.kind)).toEqual(['tool']); // no runres/resource for ${res:}
  });
});

describe('parsePromptRefPill', () => {
  it('parses run-resource, tool, and resource pills', () => {
    expect(parsePromptRefPill('${res:foo}')).toEqual({ kind: 'runres', server: '', name: 'foo' });
    expect(parsePromptRefPill('${tool:files__read}')).toEqual({ kind: 'tool', server: 'files', name: 'read' });
    expect(parsePromptRefPill('${resource:docs__file:///a}')).toEqual({
      kind: 'resource',
      server: 'docs',
      name: 'file:///a',
    });
  });

  it('returns null for non-references (run vars, global vars, empty name, plain text)', () => {
    expect(parsePromptRefPill('${var:x}')).toBeNull();
    expect(parsePromptRefPill('${global:KEY}')).toBeNull();
    expect(parsePromptRefPill('${res:}')).toBeNull();
    expect(parsePromptRefPill('plain text')).toBeNull();
  });
});

describe('encodePromptRefPill / round-trip', () => {
  it('encodes a run-resource ref back to ${res:NAME}', () => {
    expect(encodePromptRefPill('runres', '', 'foo')).toBe('${res:foo}');
    expect(encodePromptRefPill('tool', 'files', 'read')).toBe('${tool:files__read}');
  });

  it('round-trips ${res:NAME} exactly (so saved templates never mutate)', () => {
    const pill = '${res:my_artifact-1}';
    const parsed = parsePromptRefPill(pill)!;
    expect(encodePromptRefPill(parsed.kind, parsed.server, parsed.name)).toBe(pill);
  });
});

describe('promptRefLabel', () => {
  it('renders a readable chip label for each kind', () => {
    expect(promptRefLabel({ kind: 'runres', server: '', name: 'foo' })).toBe('res:foo');
    expect(promptRefLabel({ kind: 'tool', server: 'files', name: 'read' })).toBe('tool:files__read');
    expect(promptRefLabel({ kind: 'resource', server: 'd', name: 'x' })).toBe('resource:d__x');
  });
});

describe('extractResourceRefNames', () => {
  it('returns distinct, trimmed, alphabetically-sorted ${res:NAME} names across texts', () => {
    const texts = [
      'use ${res:beta} then ${res:alpha}',
      'again ${res:alpha} and ${res: beta }', // duplicate + padded → same names
      'no refs here, only ${var:x} and ${tool:s__t}',
      undefined,
      '',
    ];
    expect(extractResourceRefNames(texts)).toEqual(['alpha', 'beta']);
  });

  it('returns an empty array when there are no run-resource references', () => {
    expect(extractResourceRefNames(['just prose', '${var:x}', null, undefined])).toEqual([]);
  });
});
