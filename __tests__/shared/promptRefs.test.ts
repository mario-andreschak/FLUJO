/**
 * Tests for the prompt-authoring reference layer (issue #183 items 4 & 5).
 *
 * `promptRefs` is the RENDERING-facing superset of `mcpBinding`: it recognizes
 * `${res:NAME}` run-resource and `${global:NAME}` references (so authoring
 * surfaces can render them as pills) IN ADDITION to MCP pills — WITHOUT making
 * `${res:...}` visible to the compiler-facing `findBindings` (whose exact set the
 * flow compiler `stripPills` and validation depend on).
 */

import {
  findPromptRefs,
  parsePromptRefPill,
  encodePromptRefPill,
  promptRefLabel,
  extractResourceRefNames,
  encodeDynamicReference,
  parseDynamicReference,
} from '@/utils/shared/promptRefs';
import { findBindings } from '@/utils/shared/mcpBinding';

describe('findPromptRefs', () => {
  it('finds tool, resource, run-resource, and global refs in document order; ignores ${var:}', () => {
    const text =
      'A ${tool:files__read} B ${res:foo} C ${resource:docs__file:///a} D ${var:x} E ${res:bar} ${global:KEY}';
    const found = findPromptRefs(text);
    expect(found.map((r) => `${r.kind}:${r.server}:${r.name}`)).toEqual([
      'tool:files:read',
      'runres::foo',
      'resource:docs:file:///a',
      'runres::bar',
      'global::KEY',
    ]);
    // fullMatch round-trips to the exact substring at the reported index.
    found.forEach((r) => expect(text.slice(r.index, r.index + r.fullMatch.length)).toBe(r.fullMatch));
  });

  it('returns an empty array when there are no references', () => {
    expect(findPromptRefs('just prose and ${var:x} and ${global:} and ${global:missing')).toEqual([]);
  });

  it('finds dynamic @ references without matching email/npm/global substrings', () => {
    const text = 'Use @conversation.name, @flows[flow%201].updated and @file[C%3A%5Cwork%5Ca.txt].name';
    expect(findPromptRefs(text).filter((ref) => ref.kind === 'mention').map((ref) => ref.fullMatch)).toEqual([
      '@conversation.name',
      '@flows[flow%201].updated',
      '@file[C%3A%5Cwork%5Ca.txt].name',
    ]);
    expect(findPromptRefs('email@example.com @modelcontextprotocol/sdk ${global:@model}'))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mention' })]));
  });
});

describe('dynamic @ references', () => {
  it('parses default ids and explicit metadata fields', () => {
    expect(parseDynamicReference('@flows')).toEqual({
      kind: 'flows',
      target: undefined,
      field: 'id',
      fullMatch: '@flows',
    });
    expect(parseDynamicReference('@conversation[chat%201].created')).toEqual({
      kind: 'conversation',
      target: 'chat 1',
      field: 'created',
      fullMatch: '@conversation[chat%201].created',
    });
  });

  it('encodes selected ids and filesystem paths as one stable token', () => {
    const encoded = encodeDynamicReference('file', 'C:\\work folder\\a].txt', 'name');
    expect(encoded).toBe('@file[C%3A%5Cwork%20folder%5Ca%5D.txt].name');
    expect(parseDynamicReference(encoded)?.target).toBe('C:\\work folder\\a].txt');
  });
});

describe('compiler invariant: rendering-only refs stay INVISIBLE to findBindings', () => {
  it('findBindings never reports run-resource or global references', () => {
    const text = 'read ${res:foo}, ${global:KEY}, and ${tool:files__read}';
    const bindings = findBindings(text);
    expect(bindings.map((b) => b.kind)).toEqual(['tool']);
  });
});

describe('parsePromptRefPill', () => {
  it('parses run-resource, global, tool, and resource pills', () => {
    expect(parsePromptRefPill('${res:foo}')).toEqual({ kind: 'runres', server: '', name: 'foo' });
    expect(parsePromptRefPill('${global:API_HOST}')).toEqual({ kind: 'global', server: '', name: 'API_HOST' });
    expect(parsePromptRefPill('${tool:files__read}')).toEqual({ kind: 'tool', server: 'files', name: 'read' });
    expect(parsePromptRefPill('${resource:docs__file:///a}')).toEqual({
      kind: 'resource',
      server: 'docs',
      name: 'file:///a',
    });
    expect(parsePromptRefPill('@model[model-1].name')).toEqual({
      kind: 'mention',
      server: '',
      name: '@model[model-1].name',
    });
  });

  it('returns null for non-references (run vars, empty names, malformed refs, plain text)', () => {
    expect(parsePromptRefPill('${var:x}')).toBeNull();
    expect(parsePromptRefPill('${global:}')).toBeNull();
    expect(parsePromptRefPill('${global:KEY')).toBeNull();
    expect(parsePromptRefPill('${res:}')).toBeNull();
    expect(parsePromptRefPill('plain text')).toBeNull();
  });
});

describe('encodePromptRefPill / round-trip', () => {
  it('encodes a run-resource ref back to ${res:NAME}', () => {
    expect(encodePromptRefPill('runres', '', 'foo')).toBe('${res:foo}');
    expect(encodePromptRefPill('tool', 'files', 'read')).toBe('${tool:files__read}');
    expect(encodePromptRefPill('global', '', 'API_HOST')).toBe('${global:API_HOST}');
    expect(encodePromptRefPill('mention', '', '@date')).toBe('@date');
  });

  it('round-trips rendering-only references exactly (so saved templates never mutate)', () => {
    const pill = '${res:my_artifact-1}';
    const parsed = parsePromptRefPill(pill)!;
    expect(encodePromptRefPill(parsed.kind, parsed.server, parsed.name)).toBe(pill);
    const globalPill = '${global:my_key-1}';
    const parsedGlobal = parsePromptRefPill(globalPill)!;
    expect(encodePromptRefPill(parsedGlobal.kind, parsedGlobal.server, parsedGlobal.name)).toBe(globalPill);
  });
});

describe('promptRefLabel', () => {
  it('renders a readable chip label for each kind', () => {
    expect(promptRefLabel({ kind: 'runres', server: '', name: 'foo' })).toBe('res:foo');
    expect(promptRefLabel({ kind: 'global', server: '', name: 'API_HOST' })).toBe('global:API_HOST');
    expect(promptRefLabel({ kind: 'tool', server: 'files', name: 'read' })).toBe('tool:files__read');
    expect(promptRefLabel({ kind: 'resource', server: 'd', name: 'x' })).toBe('resource:d__x');
    expect(promptRefLabel({ kind: 'mention', server: '', name: '@flows[flow%201].name' })).toBe('flows:flow 1.name');
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
