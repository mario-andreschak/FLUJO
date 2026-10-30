import { PROVIDER_PROFILES } from '@/shared/types/model/provider';
import { groupProviderProfiles, providerGroupOf, providerMark, PROVIDER_GROUP_ORDER } from '@/shared/types/model/providerGroups';

describe('provider grouping (#1278)', () => {
  it('places every offered provider in exactly one vendor group, keeping each group in catalogue order', () => {
    const grouped = groupProviderProfiles(PROVIDER_PROFILES);
    expect(grouped.flatMap(entry => entry.profiles)).toHaveLength(PROVIDER_PROFILES.length);
    expect(grouped.map(entry => entry.group)).toEqual(PROVIDER_GROUP_ORDER.filter(group => grouped.some(entry => entry.group === group)));
    for (const { profiles } of grouped) {
      const positions = profiles.map(profile => PROVIDER_PROFILES.indexOf(profile));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
    }
  });

  it('groups the major vendors and leaves unknown profiles under Other', () => {
    expect(providerGroupOf('openai-responses')).toBe('openai');
    expect(providerGroupOf('claude-subscription')).toBe('anthropic');
    expect(providerGroupOf('gemini-native')).toBe('google');
    expect(providerGroupOf('openrouter-agent')).toBe('gateway');
    expect(providerGroupOf('ollama')).toBe('local');
    expect(providerGroupOf('some-new-provider')).toBe('other');
  });

  it('derives a two-letter mark', () => {
    expect(providerMark('OpenRouter Agent SDK')).toBe('OA');
    expect(providerMark('Ollama')).toBe('O');
  });
});
