import { discoverySearchTerms, discoveryRelevance, hasKnownDiscoveryIntent } from '@/shared/mcpDiscoverySearch';

describe('deterministic capability discovery', () => {
  it('treats spaces and dashes alike without requiring a Registry name', () => {
    expect(discoverySearchTerms('web search')).toEqual(discoverySearchTerms('web-search'));
    expect(discoverySearchTerms('web search')).toContain('search');
    expect(discoveryRelevance('web search', { name: 'io.example/brave', description: 'Search the web' })).toBeGreaterThan(0);
  });

  it('finds capability synonyms in titles and descriptions but rejects unrelated hits', () => {
    expect(discoverySearchTerms('I want to read files')).toContain('filesystem');
    expect(discoveryRelevance('read files', { name: 'io.example/storage', title: 'Filesystem access' })).toBeGreaterThan(0);
    expect(discoveryRelevance('read files', { name: 'io.example/profile', description: 'User profiles' })).toBe(0);
    expect(discoverySearchTerms('turn text into speech')).toContain('tts');
    expect(discoveryRelevance('speech', { name: 'io.example/audio', description: 'Text to speech' })).toBeGreaterThan(0);
    expect(discoveryRelevance('turn text into speech', { name: 'io.example/tts' })).toBeGreaterThan(0);
    expect(discoveryRelevance('web search', { name: 'io.example/search', description: 'Search your local files' })).toBe(0);
  });

  it('keeps preference and request phrasing separate from capability matching', () => {
    expect(discoveryRelevance('I need a free server to search the web', { name: 'io.example/brave-search' })).toBeGreaterThan(0);
    expect(discoveryRelevance('work with local files', { name: 'io.example/filesystem' })).toBeGreaterThan(0);
    expect(discoveryRelevance('edit a spreadsheet', { name: 'io.example/office-excel' })).toBeGreaterThan(0);
    expect(discoverySearchTerms('edit a spreadsheet')).toContain('excel');
    expect(discoverySearchTerms('open a terminal')).toContain('bash');
  });

  it('keeps unknown distinctive intent rather than suggesting any software', () => {
    expect(discoveryRelevance('quantum gardening', { name: 'io.example/search', description: 'Web search' })).toBe(0);
    expect(discoveryRelevance('postgres database', { name: 'io.example/mysql', description: 'SQL database access' })).toBe(0);
    expect(discoverySearchTerms('please give me a useful MCP server')).toEqual([]);
  });

  it.each(['search the latest news', 'send email to customers', 'browser for lunar waves', 'postgres customer reports'])('requires interpretation when only part of the task is known: %s', query => {
    expect(hasKnownDiscoveryIntent(query)).toBe(false);
  });

  it.each(['', 'please give me a useful MCP server'])('does not treat empty meaningful intent as covered: %s', query => {
    expect(hasKnownDiscoveryIntent(query)).toBe(false);
  });

  it.each(['io.github.Acme/Server', 'connect my notion', 'postgres database', 'office-word', 'web search', 'turn text into speech', 'text-to-speech'])('preserves known complete capabilities and service identities: %s', query => {
    expect(hasKnownDiscoveryIntent(query)).toBe(true);
  });

  it('bounds expansion, keeps exact identities, and normalizes unicode accents', () => {
    expect(discoverySearchTerms('io.github.Acme/Server')).toEqual(['io.github.acme/server']);
    expect(discoverySearchTerms('FÍLES')).toContain('filesystem');
    expect(discoverySearchTerms('browser files database voice calendar email chat images')).toHaveLength(6);
    expect(discoveryRelevance('web search', { name: 'io.example/research', description: 'DNA research' })).toBe(0);
    expect(hasKnownDiscoveryIntent('edit a spreadsheet')).toBe(true);
    expect(hasKnownDiscoveryIntent('connect my notion')).toBe(true);
    expect(hasKnownDiscoveryIntent('retain arbitrary lunar waves')).toBe(false);
  });
});
