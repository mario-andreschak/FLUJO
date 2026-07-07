import { slugifyFlowName, buildFlowToolNameMap } from '@/shared/utils/flowToolNaming';

// Flow-as-MCP-tool naming for the built-in FLUJO MCP server (issue #38, Item D).
describe('slugifyFlowName', () => {
  it('slugifies a normal flow name', () => {
    expect(slugifyFlowName('Web Research')).toBe('web_research');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugifyFlowName('Summarize & Translate!!')).toBe('summarize_translate');
  });

  it('falls back to "flow" when empty or only punctuation', () => {
    expect(slugifyFlowName('')).toBe('flow');
    expect(slugifyFlowName(undefined)).toBe('flow');
    expect(slugifyFlowName('!!!')).toBe('flow');
  });

  it('produces MCP-safe names (only [A-Za-z0-9_-])', () => {
    expect(slugifyFlowName('Ünïçödé (v2)')).toMatch(/^[a-z0-9_]+$/);
  });

  it('caps very long names', () => {
    expect(slugifyFlowName('a'.repeat(200)).length).toBeLessThanOrEqual(56);
  });
});

describe('buildFlowToolNameMap', () => {
  it('maps each flow id to its readable slug', () => {
    const map = buildFlowToolNameMap([
      { id: 'f1', name: 'Web Research' },
      { id: 'f2', name: 'Daily Digest' },
    ]);
    expect(map.get('f1')).toBe('web_research');
    expect(map.get('f2')).toBe('daily_digest');
  });

  it('disambiguates colliding slugs with a deterministic numeric suffix', () => {
    const map = buildFlowToolNameMap([
      { id: 'a', name: 'Research' },
      { id: 'b', name: 'Research' },
      { id: 'c', name: 'Research' },
    ]);
    expect(map.get('a')).toBe('research');
    expect(map.get('b')).toBe('research_2');
    expect(map.get('c')).toBe('research_3');
  });

  it('collapses duplicate ids to one name', () => {
    const map = buildFlowToolNameMap([
      { id: 'a', name: 'Research' },
      { id: 'a', name: 'Research' },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('a')).toBe('research');
  });

  it('keeps every generated name unique', () => {
    const map = buildFlowToolNameMap([
      { id: '1', name: 'Flow' },
      { id: '2', name: 'Flow' },
      { id: '3', name: '' },
    ]);
    const names = [...map.values()];
    expect(new Set(names).size).toBe(names.length);
  });
});
