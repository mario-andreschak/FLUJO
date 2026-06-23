/**
 * Tests for the MCP binding-pill codec (tool:/resource: pills + legacy dual-read).
 */

import {
  encodeBindingPill,
  parsePill,
  parseBindingBody,
  findBindings,
  splitServerName,
  bindingLabel,
} from '@/utils/shared/mcpBinding';
import { displayToolName } from '@/utils/shared/common';

describe('encodeBindingPill', () => {
  it('builds tool and resource pills in the canonical format', () => {
    expect(encodeBindingPill('tool', 'files', 'read')).toBe('${tool:files__read}');
    expect(encodeBindingPill('resource', 'files', 'file:///a/b.txt')).toBe(
      '${resource:files__file:///a/b.txt}'
    );
  });
});

describe('splitServerName', () => {
  it('splits on the FIRST `__` so the name may contain `__` or `://`', () => {
    expect(splitServerName('files__read')).toEqual({ server: 'files', name: 'read' });
    expect(splitServerName('db__weird__tool')).toEqual({ server: 'db', name: 'weird__tool' });
    expect(splitServerName('files__file:///x/y')).toEqual({ server: 'files', name: 'file:///x/y' });
  });

  it('rejects malformed input', () => {
    expect(splitServerName('noseparator')).toBeNull();
    expect(splitServerName('__noserver')).toBeNull();
    expect(splitServerName('noname__')).toBeNull();
  });
});

describe('parsePill / parseBindingBody', () => {
  it('parses new tool and resource pills', () => {
    expect(parsePill('${tool:files__read}')).toEqual({ kind: 'tool', server: 'files', name: 'read' });
    expect(parsePill('${resource:docs__https://x/y}')).toEqual({
      kind: 'resource',
      server: 'docs',
      name: 'https://x/y',
    });
  });

  it('dual-reads the legacy tool pill', () => {
    expect(parsePill('${_-_-_files_-_-_read}')).toEqual({ kind: 'tool', server: 'files', name: 'read' });
  });

  it('returns null for non-bindings (e.g. global vars)', () => {
    expect(parsePill('${global:API_KEY}')).toBeNull();
    expect(parseBindingBody('global:API_KEY')).toBeNull();
    expect(parsePill('plain text')).toBeNull();
  });
});

describe('findBindings', () => {
  it('finds tool, resource, and legacy pills in free text and ignores global vars', () => {
    const text =
      'Use ${tool:files__read} and ${resource:docs__file:///a} but not ${global:KEY}; legacy ${_-_-_old_-_-_tool} too.';
    const found = findBindings(text);
    expect(found.map((b) => `${b.kind}:${b.server}:${b.name}`)).toEqual([
      'tool:files:read',
      'resource:docs:file:///a',
      'tool:old:tool',
    ]);
    // fullMatch round-trips to the exact substring.
    found.forEach((b) => expect(text).toContain(b.fullMatch));
  });

  it('returns an empty array when there are no bindings', () => {
    expect(findBindings('just ${global:X} and prose')).toEqual([]);
  });
});

describe('bindingLabel', () => {
  it('renders readable chip labels, special-casing handoff', () => {
    expect(bindingLabel({ kind: 'tool', server: 'files', name: 'read' })).toBe('tool:files__read');
    expect(bindingLabel({ kind: 'resource', server: 'd', name: 'x' })).toBe('resource:d__x');
    expect(bindingLabel({ kind: 'tool', server: 'handoff', name: 'next' })).toBe('handoff:next');
  });
});

describe('displayToolName (SDK-facing names)', () => {
  it('handles legacy, hashed, and server__tool schemes', () => {
    expect(displayToolName('_-_-_files_-_-_read')).toBe('read');
    expect(displayToolName('mcp_read_ab12cd')).toBe('read');
    expect(displayToolName('files__read')).toBe('read');
    expect(displayToolName('files__weird__tool')).toBe('weird__tool');
    expect(displayToolName('handoff_to_node1')).toBe('handoff_to_node1'); // unchanged passthrough
  });
});
