import { SPOTLIGHT_SERVERS, normalizeSpotlightSource } from '@/shared/config/spotlightServers';
import type { McpRecommendationCost, McpRecommendationSupportEvidence, McpRecommendationTier } from '@/shared/types/mcp/assistant';
import type { InstallOption, RegistryServer } from '@/utils/mcp/registry';
import { getInstallOptions, isAutoInstallable } from '@/utils/mcp/registry';
import { discoveryRelevance } from '@/shared/mcpDiscoverySearch';

// Capabilities describe shipped integrations, not a safety or price judgment of
// similarly named third-party entries. Exact identities are required below.
const CAPABILITIES: Record<string, readonly string[]> = {
  'ai.keenable/web-search': ['web search', 'search web', 'search engine', 'web-search', 'fetch page'],
  'ai.parallel/search-mcp': ['web search', 'search web', 'search engine', 'web-search', 'fetch page'],
  'io.github.mario-andreschak/mcp-abap-adt': ['abap', 'sap', 'adt'],
  'io.github.mario-andreschak/mcp-audio-studio': ['audio', 'music', 'sound'],
  'io.github.mario-andreschak/mcp-vscode': ['vscode', 'visual studio code', 'code editor'],
  'io.github.mario-andreschak/mcp-cad-studio': ['cad', '3d model', '3d modeling'],
  'io.github.microsoft/playwright-mcp': ['browser', 'playwright', 'browser automation'],
  'io.github.dosev-ai/mcp-office-word': ['word', 'docx', 'word document'],
  'io.github.dosev-ai/mcp-office-excel': ['excel', 'spreadsheet', 'xlsx'],
  'io.github.dosev-ai/mcp-office-powerpoint': ['powerpoint', 'presentation', 'pptx', 'slides'],
  'io.github.mario-andreschak/mcp-filesystem': ['filesystem', 'file system', 'local files', 'read files', 'write files'],
  'io.github.mario-andreschak/mcp-bash': ['bash', 'shell', 'terminal', 'execute command'],
  'io.github.mario-andreschak/mcp-browser': ['browser', 'browser automation'],
  'io.github.mario-andreschak/mcp-flujo': ['flujo', 'manage flows', 'manage agents'],
};

const CORE_PACKAGES = new Map(['filesystem', 'bash', 'browser', 'flujo'].map(name => [
  `@mario.andreschak/mcp-${name}`,
  `https://github.com/mario-andreschak/FLUJO/tree/main/mcp-servers/${name}`,
]));

function spotlightName(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://registry.modelcontextprotocol.io') return undefined;
    const match = parsed.pathname.match(/^\/v0\.1\/servers\/([^/]+)(?:\/versions(?:\/[^/]+)?)?\/?$/);
    return match ? decodeURIComponent(match[1]) : parsed.searchParams.get('q') ?? undefined;
  } catch { return undefined; }
}

function spotlightSources(): Map<string, string> {
  return new Map(SPOTLIGHT_SERVERS.flatMap(entry => {
    const source = normalizeSpotlightSource(entry);
    const name = spotlightName(source.url);
    return name ? [[name, source.url]] : [];
  }));
}

/** Discover relevant curated identities separately from popular Registry pages. */
export function supportedRegistrySearches(query: string): string[] {
  const supported = new Set([...spotlightSources().keys(), ...Object.keys(CAPABILITIES).filter(name => name.startsWith('io.github.mario-andreschak/mcp-') && ['filesystem', 'bash', 'browser', 'flujo'].some(core => name.endsWith(`mcp-${core}`)))]);
  return [...supported].filter(name => discoveryRelevance(query, { name, description: (CAPABILITIES[name] ?? []).join(' ') }) > 0).slice(0, 6);
}

export function recommendationSupport(
  server: RegistryServer,
  option?: InstallOption,
): McpRecommendationSupportEvidence | undefined {
  // Package name alone is insufficient: a third-party entry can mention or
  // wrap it. Require FLUJO's exact registry identity and exact npm package.
  if (option?.kind === 'package' && option.pkg.registryType === 'npm') {
    const source = CORE_PACKAGES.get(option.pkg.identifier);
    const core = option.pkg.identifier.split('/').at(-1);
    if (source && server.name === `io.github.mario-andreschak/${core}`) {
      return { kind: 'shipped-package', source };
    }
  }
  const source = spotlightSources().get(server.name);
  return source ? { kind: 'spotlight', source } : undefined;
}

export function recommendationCost(server: RegistryServer, option: InstallOption): McpRecommendationCost {
  const inputs = option.kind === 'remote' ? option.remote.headers ?? [] : option.pkg.environmentVariables ?? [];
  const keys = inputs.filter(input => input.isRequired === true && input.isSecret === true
    && /^(?:[A-Z][A-Z0-9]*_)*(?:API_KEY|API_TOKEN|PROVIDER_KEY)$/i.test(input.name.replace(/-/g, '_'))).map(input => input.name);
  if (keys.length) return {
    kind: 'byok',
    evidence: `The Registry declares required secret API credential${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}. Bring your own key; provider fees and pricing remain unverified.`,
    sourceUrl: `https://registry.modelcontextprotocol.io/?q=${encodeURIComponent(server.name)}`,
  };
  const support = recommendationSupport(server, option);
  if (support?.kind === 'shipped-package') return {
    kind: 'free',
    evidence: 'The bundled local core operation has no FLUJO per-call service charge. Model inference, connected services and infrastructure can still incur charges.',
    sourceUrl: support.source,
  };
  // No inference from OSS licensing, OAuth, empty headers, required secret
  // inputs, popularity or publisher-provided prose. Unsupported prices stay
  // unknown until maintained first-party evidence is available.
  return { kind: 'unknown', evidence: 'Service pricing has not been verified. Credentials and open-source connector licensing do not establish usage cost.' };
}

export function recommendationTier(server: RegistryServer, option: InstallOption): McpRecommendationTier {
  if (recommendationSupport(server, option)) return 'flujo-supported';
  // There is no durable repository trust-rating store today. A Registry
  // lifecycle status or private execution approval must not stand in for one.
  return option.kind === 'remote' ? 'remote' : 'local-unreviewed';
}

export interface McpRecommendationPreference {
  tier: McpRecommendationTier;
  cost: McpRecommendationCost['kind'];
  score: number;
  identity: string;
}

/** Lexicographic user preference outranks weak popularity/auth-friction scores. */
export function compareMcpRecommendationPreferences(left: McpRecommendationPreference, right: McpRecommendationPreference): number {
  const tier = { 'flujo-supported': 0, 'local-reviewed': 1, remote: 2, 'local-unreviewed': 3 };
  const cost = { free: 0, byok: 1, paid: 2, unknown: 3 };
  return tier[left.tier] - tier[right.tier]
    || cost[left.cost] - cost[right.cost]
    || right.score - left.score
    || left.identity.localeCompare(right.identity, 'en');
}

/** Rank fetched metadata before any popularity-only result limit is applied. */
export function bestMcpRecommendationPreference(server: RegistryServer, score = 0): McpRecommendationPreference {
  const options = getInstallOptions(server).filter(isAutoInstallable);
  const preferences = options.map(option => ({ tier: recommendationTier(server, option), cost: recommendationCost(server, option).kind, score, identity: server.name }));
  return preferences.sort(compareMcpRecommendationPreferences)[0]
    ?? { tier: 'local-unreviewed', cost: 'unknown', score, identity: server.name };
}
