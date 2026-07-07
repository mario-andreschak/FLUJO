import {
  slugifyHandoffTarget,
  buildHandoffToolNameMap,
  HANDOFF_TOOL_PREFIX,
} from '@/shared/utils/handoffNaming';

// Handoff tool naming — dropping the node UUID from the tool name (issue #38, Item A).
describe('slugifyHandoffTarget', () => {
  it('slugifies a normal node label', () => {
    expect(slugifyHandoffTarget('Finish Node', 'finish')).toBe('finish_node');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugifyHandoffTarget('Claude (opus)', 'process')).toBe('claude_opus');
  });

  it('falls back to the node type when the label is empty', () => {
    expect(slugifyHandoffTarget('', 'process')).toBe('process');
    expect(slugifyHandoffTarget(undefined, 'subflow')).toBe('subflow');
  });

  it('falls back to the type when the label is only punctuation', () => {
    expect(slugifyHandoffTarget('!!!', 'finish')).toBe('finish');
  });

  it('falls back to "node" when nothing usable is provided', () => {
    expect(slugifyHandoffTarget('', '')).toBe('node');
    expect(slugifyHandoffTarget(undefined, undefined)).toBe('node');
  });

  it('caps very long labels', () => {
    const slug = slugifyHandoffTarget('a'.repeat(200), 'process');
    expect(slug.length).toBeLessThanOrEqual(48);
  });
});

describe('buildHandoffToolNameMap', () => {
  it('produces readable, prefixed names keyed by node id (no UUID)', () => {
    const map = buildHandoffToolNameMap([
      { id: 'uuid-1', label: 'Finish Node', type: 'finish' },
      { id: 'uuid-2', label: 'Researcher', type: 'process' },
    ]);
    expect(map.get('uuid-1')).toBe('handoff_to_finish_node');
    expect(map.get('uuid-2')).toBe('handoff_to_researcher');
    // The prefix all handoff detection relies on is preserved.
    for (const name of map.values()) expect(name.startsWith(HANDOFF_TOOL_PREFIX)).toBe(true);
  });

  it('disambiguates colliding slugs with a deterministic numeric suffix', () => {
    const map = buildHandoffToolNameMap([
      { id: 'a', label: 'Claude (opus)', type: 'process' },
      { id: 'b', label: 'Claude (opus)', type: 'process' },
      { id: 'c', label: 'Claude (opus)', type: 'process' },
    ]);
    expect(map.get('a')).toBe('handoff_to_claude_opus');
    expect(map.get('b')).toBe('handoff_to_claude_opus_2');
    expect(map.get('c')).toBe('handoff_to_claude_opus_3');
  });

  it('collapses duplicate ids (two routes to the same node) to one name', () => {
    const map = buildHandoffToolNameMap([
      { id: 'a', label: 'Finish Node', type: 'finish' },
      { id: 'a', label: 'Finish Node', type: 'finish' },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe('handoff_to_finish_node');
  });

  it('keeps every generated name unique', () => {
    const map = buildHandoffToolNameMap([
      { id: '1', label: 'Node', type: 'process' },
      { id: '2', label: 'Node', type: 'process' },
      { id: '3', label: '', type: 'process' },
    ]);
    const names = [...map.values()];
    expect(new Set(names).size).toBe(names.length);
  });
});
