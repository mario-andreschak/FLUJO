/**
 * Vendor grouping and a compact mark for provider profiles (#1278). Pickers
 * list providers under their vendor instead of one long flat list, and every
 * surface draws the same mark for a provider.
 */
export type ProviderGroupId = 'openai' | 'anthropic' | 'google' | 'gateway' | 'local' | 'other';

export const PROVIDER_GROUP_ORDER: readonly ProviderGroupId[] = ['openai', 'anthropic', 'google', 'gateway', 'local', 'other'];

const GROUP_BY_PROFILE: Readonly<Record<string, ProviderGroupId>> = {
  'openai-responses': 'openai', openai: 'openai', azure: 'openai', codex: 'openai',
  'anthropic-native': 'anthropic', 'anthropic-openai': 'anthropic', 'claude-subscription': 'anthropic',
  'gemini-native': 'google', 'gemini-openai': 'google', 'antigravity-cli': 'google',
  openrouter: 'gateway', 'openrouter-messages': 'gateway', 'openrouter-agent': 'gateway',
  orcarouter: 'gateway', requesty: 'gateway', litellm: 'gateway', 'litellm-chat-completions': 'gateway',
  ollama: 'local',
};

export function providerGroupOf(profileId: string): ProviderGroupId {
  return GROUP_BY_PROFILE[profileId] ?? 'other';
}

/** Profiles grouped by vendor, groups in a fixed order, profile order kept within a group. */
export function groupProviderProfiles<T extends { id: string }>(profiles: readonly T[]): Array<{ group: ProviderGroupId; profiles: T[] }> {
  return PROVIDER_GROUP_ORDER
    .map(group => ({ group, profiles: profiles.filter(profile => providerGroupOf(profile.id) === group) }))
    .filter(entry => entry.profiles.length > 0);
}

/** Two-letter mark from a provider label ("OpenRouter Agent SDK" -> "OA"). */
export function providerMark(label: string): string {
  return (label.match(/[a-z0-9]+/gi) ?? []).slice(0, 2).map(part => part[0]).join('').toUpperCase();
}

/** One accent per vendor so marks are recognizable at a glance. */
export const PROVIDER_GROUP_COLORS: Readonly<Record<ProviderGroupId, string>> = {
  openai: '#10a37f', anthropic: '#c96442', google: '#4285f4', gateway: '#7c4dff', local: '#546e7a', other: '#8d6e63',
};
