import { capabilitySearchTerms } from '@/backend/services/mcp/registryInstall';

describe('capabilitySearchTerms', () => {
  it('turns a natural-language install request into Registry-friendly aliases', () => {
    const terms = capabilitySearchTerms('I want to connect with Notion for knowledge search');

    expect(terms).toContain('notion');
    expect(terms).toContain('knowledge');
    expect(terms.some((term) => term.includes('connect with'))).toBe(false);
    expect(terms.length).toBeGreaterThan(1);
  });
});
