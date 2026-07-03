/**
 * Curated MCP servers shown in the ServerModal's "Spotlight" tab.
 *
 * Each entry is a URL into the official MCP Registry, in one of two forms:
 *  - exact version:
 *    https://registry.modelcontextprotocol.io/v0.1/servers/<url-encoded name>/versions/<version>
 *  - search (first result wins):
 *    https://registry.modelcontextprotocol.io/?q=<url-encoded name>
 *
 * The registry records behind these URLs are fetched once at FLUJO startup
 * (and via the Spotlight tab's Refresh button) and cached in
 * db/spotlight_servers.json — the tab itself never hits the registry.
 */
export const SPOTLIGHT_SERVER_URLS: string[] = [
  // Web search + page fetch (offers both a local npm package and a remote endpoint)
  'https://registry.modelcontextprotocol.io/?q=ai.keenable%2Fweb-search'
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
