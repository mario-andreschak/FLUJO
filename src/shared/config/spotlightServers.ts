/**
 * Curated MCP servers shown in the ServerModal's "Spotlight" tab.
 *
 * Each entry is either a bare registry URL or a { url, env } object. The URL
 * points into the official MCP Registry, in one of three forms:
 *  - exact version:
 *    https://registry.modelcontextprotocol.io/v0.1/servers/<url-encoded name>/versions/<version>
 *  - version-less (versions list; resolved to the latest available version):
 *    https://registry.modelcontextprotocol.io/v0.1/servers/<url-encoded name>/versions
 *    (the plain /servers/<url-encoded name> form works too)
 *  - search (first result wins):
 *    https://registry.modelcontextprotocol.io/?q=<url-encoded name>
 *
 * The registry records behind these URLs are fetched once at FLUJO startup
 * (and via the Spotlight tab's Refresh button) and cached in
 * db/spotlight_servers.json — the tab itself never hits the registry.
 */

export interface SpotlightSource {
  /** Registry URL (same three accepted forms as before) */
  url: string;
  /**
   * Env-var defaults applied on top of the registry record at install time.
   * Plain, non-secret values only — these ship in code and are visible in the
   * repo. Secrets must keep going through the existing isSecret env flow.
   */
  env?: Record<string, string>;
}

export const SPOTLIGHT_SERVERS: (string | SpotlightSource)[] = [
  // Web search + page fetch (offers both a local npm package and a remote endpoint)
  'https://registry.modelcontextprotocol.io/?q=ai.keenable%2Fweb-search',
  // Web search + page fetch (remote)
  'https://registry.modelcontextprotocol.io/v0.1/servers/ai.parallel%2Fsearch-mcp/versions',
  'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.mario-andreschak%2Fmcp-abap-adt/versions',
  {
    url: 'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.microsoft%2Fplaywright-mcp/versions',
    // Playwright MCP defaults to Chromium, which needs a separate browser
    // download; Edge ships with Windows, so default to it for a
    // friction-free one-click install. Editable after install.
    env: { PLAYWRIGHT_MCP_BROWSER: 'msedge' }
  }
  // Up-to-date library docs for any prompt
  // 'https://registry.modelcontextprotocol.io/?q=io.github.upstash%2Fcontext7',
  // Exa web search & crawling
  // 'https://registry.modelcontextprotocol.io/?q=ai.exa%2Fexa',
  // Firecrawl scraping/crawling
  // 'https://registry.modelcontextprotocol.io/?q=io.github.firecrawl%2Ffirecrawl-mcp-server',
  // Official Notion server
  // 'https://registry.modelcontextprotocol.io/?q=com.notion%2Fmcp',
  // Linear project management
  // 'https://registry.modelcontextprotocol.io/?q=app.linear%2Flinear'
];

/** Bare-string entries are shorthand for { url } — normalize for consumers. */
export function normalizeSpotlightSource(source: string | SpotlightSource): SpotlightSource {
  return typeof source === 'string' ? { url: source } : source;
}
