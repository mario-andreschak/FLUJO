/**
 * By-reference packaging descriptors for MCP servers (issue #192).
 *
 * A package NEVER carries MCP server files or the `command`/`rootPath` of a
 * local folder. Instead it records WHERE to install the server from
 * (`McpInstallOrigin`) plus DECLARATIONS of the env vars / headers it needs
 * (names + `isSecret` flag only, never values). The live `MCPServerConfig`
 * (see `../mcp/mcp.ts`) has no such metadata today, so the package format
 * introduces its own; this stays package-only and does not modify the live
 * type (see the plan's open question #1).
 */

/** Where an MCP server is installed from. */
export type McpSourceType = 'github' | 'registry' | 'marketplace' | 'remote';

/**
 * Install instruction for one packaged MCP server.
 * - `github`: install from a GitHub repo (`ref` = owner/repo[@ref]).
 * - `registry`: install from the public MCP registry (`ref` = registry name,
 *   e.g. "ai.keenable/web-search").
 * - `marketplace`: install a curated Spotlight/marketplace entry (`name`/`ref`).
 * - `remote`: a remote transport server reached at `url` (no install step).
 */
export interface McpInstallOrigin {
  sourceType: McpSourceType;
  /** Registry name / GitHub ref / marketplace id, as appropriate for the source. */
  ref?: string;
  /** http(s):// or ws(s):// endpoint for a `remote` server. */
  url?: string;
  /** Human-readable / marketplace display name. */
  name?: string;
}

/**
 * Declaration of ONE environment variable a packaged MCP server expects.
 * Carries the variable NAME and whether it is secret — never a value. If the
 * value should come from a package secret or a host global var, that binding is
 * expressed via `secretRef` / `globalVar` (which reference declared keys).
 */
export interface EnvDeclaration {
  name: string;
  isSecret: boolean;
  /** Declared `secrets[]` key that supplies this value at install time. */
  secretRef?: string;
  /** Host `${global:VAR}` name that supplies this value at runtime. */
  globalVar?: string;
}

/** Declaration of ONE custom HTTP header (same shape/rules as EnvDeclaration). */
export type HeaderDeclaration = EnvDeclaration;
