/**
 * Mapping layer between the official MCP Registry's server.json format
 * (https://registry.modelcontextprotocol.io, schema: server.schema.json)
 * and FLUJO's MCPServerConfig.
 *
 * A registry entry offers zero or more installation options:
 *  - packages: run locally via a package runner (npm→npx, pypi→uvx, oci→docker, nuget→dnx)
 *  - remotes:  connect to a hosted endpoint (streamable-http / sse)
 *
 * This module turns those into Partial<MCPServerConfig> objects that the
 * ServerModal's LocalServerTab can finalize (fill in required env vars, test,
 * save) — the same handoff the GitHub/Remote/Reference tabs use.
 */

import { MCPServerConfig, EnvVarValue } from '@/shared/types/mcp/mcp';

// ---------------------------------------------------------------------------
// Registry API shapes (subset of server.schema.json that we consume)
// ---------------------------------------------------------------------------

export interface RegistryKeyValueInput {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  choices?: string[];
  format?: string;
}

export interface RegistryArgument {
  type: 'positional' | 'named';
  name?: string;
  value?: string;
  default?: string;
  valueHint?: string;
  description?: string;
  isRequired?: boolean;
  isRepeated?: boolean;
}

export interface RegistryPackage {
  registryType: string;
  identifier: string;
  version?: string;
  registryBaseUrl?: string;
  runtimeHint?: string;
  transport?: { type?: string; url?: string };
  runtimeArguments?: RegistryArgument[];
  packageArguments?: RegistryArgument[];
  environmentVariables?: RegistryKeyValueInput[];
}

export interface RegistryRemote {
  type: string; // 'streamable-http' | 'sse'
  url: string;
  headers?: RegistryKeyValueInput[];
}

export interface RegistryRepository {
  url?: string;
  source?: string;
  subfolder?: string;
}

export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  websiteUrl?: string;
  repository?: RegistryRepository;
  packages?: RegistryPackage[];
  remotes?: RegistryRemote[];
}

export interface RegistryServerResult {
  server: RegistryServer;
  _meta?: {
    'io.modelcontextprotocol.registry/official'?: {
      status?: string;
      publishedAt?: string;
      updatedAt?: string;
      isLatest?: boolean;
    };
  };
}

export interface RegistryListResponse {
  servers: RegistryServerResult[];
  metadata?: {
    nextCursor?: string;
    count?: number;
  };
}

// ---------------------------------------------------------------------------
// Install options
// ---------------------------------------------------------------------------

export type InstallOption =
  | { kind: 'package'; label: string; pkg: RegistryPackage }
  | { kind: 'remote'; label: string; remote: RegistryRemote };

const PACKAGE_RUNNERS: Record<string, string> = {
  npm: 'npx',
  pypi: 'uvx',
  oci: 'docker',
  nuget: 'dnx'
};

const REGISTRY_TYPE_LABELS: Record<string, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  oci: 'Docker',
  nuget: 'NuGet',
  mcpb: 'MCPB',
  cargo: 'Cargo'
};

export function registryTypeLabel(registryType: string): string {
  return REGISTRY_TYPE_LABELS[registryType] || registryType;
}

function isPackageSupported(pkg: RegistryPackage): boolean {
  // A package we can only run if we know a runner for its registry type
  // (or the publisher told us one explicitly via runtimeHint).
  if (!pkg.identifier) return false;
  if (!PACKAGE_RUNNERS[pkg.registryType] && !pkg.runtimeHint) return false;
  // Packages that expose an HTTP endpoint when run locally (transport
  // streamable-http with a url template) need a run-then-connect flow FLUJO
  // doesn't have; only plain stdio packages are one-click installable.
  const transportType = pkg.transport?.type;
  if (transportType && transportType !== 'stdio') return false;
  return true;
}

function isRemoteSupported(remote: RegistryRemote): boolean {
  return Boolean(remote.url) && (remote.type === 'streamable-http' || remote.type === 'sse');
}

/**
 * All install options FLUJO can act on for a registry entry, packages first.
 * Unsupported entries (unknown package type, non-stdio package transport,
 * unknown remote type) are silently omitted.
 */
export function getInstallOptions(server: RegistryServer): InstallOption[] {
  const options: InstallOption[] = [];
  for (const pkg of server.packages ?? []) {
    if (isPackageSupported(pkg)) {
      options.push({
        kind: 'package',
        label: `${registryTypeLabel(pkg.registryType)}: ${pkg.identifier}`,
        pkg
      });
    }
  }
  for (const remote of server.remotes ?? []) {
    if (isRemoteSupported(remote)) {
      options.push({
        kind: 'remote',
        label: `Remote (${remote.type === 'sse' ? 'SSE' : 'Streamable HTTP'}): ${remote.url}`,
        remote
      });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

/**
 * Slugs so generic they identify nothing on their own. Many publishers name
 * their server literally "mcp" (com.googleapis.firestore/mcp, com.notion/mcp,
 * …) — without qualification every one of them would be called "mcp".
 */
const GENERIC_SLUGS = new Set(['mcp', 'server', 'mcp-server', 'mcpserver']);

/**
 * Qualify a generic slug with the most specific namespace segment:
 * "com.googleapis.firestore/mcp" → "firestore-mcp". Returns the slug
 * unchanged when it is distinctive enough by itself.
 */
function qualifiedSlug(registryName: string): string {
  const slashIndex = registryName.indexOf('/');
  const namespace = slashIndex >= 0 ? registryName.slice(0, slashIndex) : '';
  const slug = slashIndex >= 0 ? registryName.slice(slashIndex + 1) : registryName;
  if (!GENERIC_SLUGS.has(slug.toLowerCase()) || !namespace) return slug;
  const nsSegment = namespace.split('.').pop() || '';
  return nsSegment ? `${nsSegment}-${slug}` : slug;
}

/** Human-facing display name: title if present, else the part after the namespace. */
export function displayName(server: RegistryServer): string {
  if (server.title) return server.title;
  return qualifiedSlug(server.name);
}

/**
 * FLUJO server name derived from the registry name: the segment after the
 * namespace (qualified when it is a generic word like "mcp"), restricted to
 * safe characters (it becomes a config key and a directory-name candidate).
 */
export function sanitizeServerName(registryName: string): string {
  const slug = qualifiedSlug(registryName);
  const sanitized = slug.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'mcp-server';
}

// ---------------------------------------------------------------------------
// Argument / env formatting
// ---------------------------------------------------------------------------

/**
 * Render one server.json argument into command-line tokens.
 *
 * Values may contain `{variable}` templates the registry expects clients to
 * substitute interactively; we keep them verbatim (as with `<placeholders>`)
 * so the user sees and edits them in the arguments field before saving.
 */
function argumentToTokens(arg: RegistryArgument): string[] {
  const value = arg.value ?? arg.default;
  if (arg.type === 'named') {
    if (!arg.name) return [];
    if (value !== undefined && value !== '') return [arg.name, value];
    if (arg.isRequired && arg.valueHint) return [arg.name, `<${arg.valueHint}>`];
    if (arg.isRequired) return [arg.name];
    // Optional named argument with no value: omit rather than emit a bare
    // flag whose meaning we can't know.
    return [];
  }
  // positional
  if (value !== undefined && value !== '') return [value];
  if (arg.isRequired) return [`<${arg.valueHint || 'value'}>`];
  return [];
}

function argumentsToTokens(args?: RegistryArgument[]): string[] {
  return (args ?? []).flatMap(argumentToTokens);
}

function buildEnvRecord(vars?: RegistryKeyValueInput[]): Record<string, EnvVarValue> {
  const env: Record<string, EnvVarValue> = {};
  for (const v of vars ?? []) {
    if (!v.name) continue;
    const value = v.value ?? v.default ?? '';
    env[v.name] = v.isSecret ? { value, metadata: { isSecret: true } } : value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Config builders
// ---------------------------------------------------------------------------

function baseConfig(server: RegistryServer): Partial<MCPServerConfig> {
  return {
    name: sanitizeServerName(server.name),
    disabled: false,
    autoApprove: [],
    env: {},
    _buildCommand: '',
    _installCommand: ''
  };
}

function npmSpecifier(pkg: RegistryPackage): string {
  return pkg.version ? `${pkg.identifier}@${pkg.version}` : pkg.identifier;
}

function pypiSpecifier(pkg: RegistryPackage): string {
  return pkg.version ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
}

function ociImage(pkg: RegistryPackage): string {
  // identifier may already carry a tag or digest (e.g. "mcp/example:1.2.0");
  // only append the version as tag when it doesn't.
  const lastSegment = pkg.identifier.split('/').pop() || pkg.identifier;
  const hasTagOrDigest = lastSegment.includes(':') || lastSegment.includes('@');
  return !hasTagOrDigest && pkg.version ? `${pkg.identifier}:${pkg.version}` : pkg.identifier;
}

function buildPackageConfig(server: RegistryServer, pkg: RegistryPackage): Partial<MCPServerConfig> {
  const command = pkg.runtimeHint || PACKAGE_RUNNERS[pkg.registryType];
  const packageTokens = argumentsToTokens(pkg.packageArguments);
  const runtimeTokens = argumentsToTokens(pkg.runtimeArguments);
  const env = buildEnvRecord(pkg.environmentVariables);

  let args: string[];
  switch (pkg.registryType) {
    case 'npm':
      args = [...runtimeTokens, '-y', npmSpecifier(pkg), ...packageTokens];
      break;
    case 'pypi':
      args = [...runtimeTokens, pypiSpecifier(pkg), ...packageTokens];
      break;
    case 'oci': {
      // docker run -i --rm [runtime args] [-e VAR ...] image [package args]
      // Env vars are declared with bare -e flags so the values FLUJO passes to
      // the spawned docker process (from the config's env) reach the container.
      const envFlags = Object.keys(env).flatMap(name => ['-e', name]);
      const base = runtimeTokens[0] === 'run' ? [] : ['run', '-i', '--rm'];
      args = [...base, ...runtimeTokens, ...envFlags, ociImage(pkg), ...packageTokens];
      break;
    }
    case 'nuget':
      args = [...runtimeTokens, npmSpecifier(pkg), '--yes', ...packageTokens];
      break;
    default:
      // Unknown type but publisher provided a runtimeHint: best effort.
      args = [...runtimeTokens, npmSpecifier(pkg), ...packageTokens];
      break;
  }

  return {
    ...baseConfig(server),
    transport: 'stdio',
    command,
    args,
    env,
    // Package runners fetch published packages; no local checkout exists or is
    // needed, so run from the app root.
    rootPath: '.'
  } as Partial<MCPServerConfig>;
}

function buildRemoteConfig(server: RegistryServer, remote: RegistryRemote): Partial<MCPServerConfig> {
  const headers: Record<string, string> = {};
  for (const header of remote.headers ?? []) {
    if (!header.name) continue;
    headers[header.name] = header.value ?? header.default ?? '';
  }

  // Remote servers get a dedicated per-server folder as their root dir, matching the
  // stdio convention (mcp-servers/<name>) — never '/' (issue 52): rootPath feeds the
  // folder pickers, ServerCard actions and the git-update route, so a filesystem root
  // would be an overly wide default scope.
  const base = baseConfig(server);
  return {
    ...base,
    transport: remote.type === 'sse' ? 'sse' : 'streamable',
    serverUrl: remote.url,
    headers,
    rootPath: `mcp-servers/${base.name}`
  } as Partial<MCPServerConfig>;
}

/**
 * Build a FLUJO server config from a registry entry + chosen install option.
 * The result is a Partial<MCPServerConfig> meant to pre-fill LocalServerTab;
 * required-but-unknown values are left as visible `<placeholders>` / empty
 * env values for the user to fill in before saving.
 */
export function buildConfigFromOption(
  server: RegistryServer,
  option: InstallOption
): Partial<MCPServerConfig> {
  return option.kind === 'package'
    ? buildPackageConfig(server, option.pkg)
    : buildRemoteConfig(server, option.remote);
}

// ---------------------------------------------------------------------------
// Spotlight (curated servers)
// ---------------------------------------------------------------------------

/** One curated server, as resolved against the registry. */
export interface SpotlightEntry {
  /** The curated source URL (from the shipped spotlight list) */
  url: string;
  /**
   * Env-var defaults from the shipped spotlight list, merged into the
   * generated config at install time. Always copied from the current shipped
   * config on refresh — never carried forward from a previous cache.
   */
  env?: Record<string, string>;
  /** The resolved registry record; absent when resolution failed */
  result?: RegistryServerResult;
  /** Why resolution failed, when it did */
  error?: string;
}

/** The cached result of resolving the curated list, persisted in storage. */
export interface SpotlightCache {
  /** ISO timestamp of the last (attempted) refresh */
  updatedAt: string;
  entries: SpotlightEntry[];
}

/**
 * Resolve a curated spotlight URL into the registry API path (+query) that
 * yields exactly one server. Three forms are supported:
 *  - exact:    https://registry.modelcontextprotocol.io/v0.1/servers/<name>/versions/<version>
 *  - versions: https://registry.modelcontextprotocol.io/v0.1/servers/<name>/versions
 *              (no version specified — resolved to the latest version via search)
 *  - search:   https://registry.modelcontextprotocol.io/?q=<name>  (first result wins)
 * Returns null for anything else.
 */
export function spotlightRequestPath(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const query = parsed.searchParams.get('q');
  if (query) {
    return `/v0.1/servers?search=${encodeURIComponent(query)}&version=latest&limit=1`;
  }

  // Exact server-version path: pass through verbatim (name stays URL-encoded)
  if (/^\/v[\d.]+\/servers\/[^/]+\/versions\/[^/]+$/.test(parsed.pathname)) {
    return parsed.pathname;
  }

  // Server path without a version — plain (/servers/<name>) or the registry's
  // versions-list form (/servers/<name>/versions): resolve via search for the
  // latest version. Order matters: the exact-version regex above must run first
  // so /servers/<name>/versions/<version> keeps passing through verbatim.
  const serverMatch = parsed.pathname.match(/^\/v[\d.]+\/servers\/([^/]+)(?:\/versions)?\/?$/);
  if (serverMatch) {
    const name = decodeURIComponent(serverMatch[1]);
    return `/v0.1/servers?search=${encodeURIComponent(name)}&version=latest&limit=1`;
  }

  return null;
}

/**
 * Normalize a registry response body into a single server result. Handles
 * both the list shape ({ servers: [...] }, search form) and the single-server
 * shape ({ server: {...}, _meta }, exact-version form).
 */
export function firstServerFromResponse(body: unknown): RegistryServerResult | null {
  const data = body as { servers?: RegistryServerResult[]; server?: RegistryServer } | null;
  if (data?.servers && data.servers.length > 0) return data.servers[0];
  if (data?.server?.name) return data as RegistryServerResult;
  return null;
}

/**
 * Merge curated spotlight env defaults into a generated server config.
 *
 * Overrides add vars the registry record didn't declare and fill/replace the
 * default value of vars it did declare. When the registry declared a var as
 * secret, the secret shape ({ value, metadata: { isSecret: true } }) is
 * preserved so the value keeps flowing through the encrypted env handling.
 */
export function applySpotlightEnvDefaults(
  config: Partial<MCPServerConfig>,
  overrides?: Record<string, string>
): Partial<MCPServerConfig> {
  if (!overrides || Object.keys(overrides).length === 0) return config;
  const env: Record<string, EnvVarValue> = { ...(config.env ?? {}) };
  for (const [name, value] of Object.entries(overrides)) {
    const existing = env[name];
    if (existing && typeof existing === 'object' && existing.metadata?.isSecret) {
      env[name] = { value, metadata: { isSecret: true } };
    } else {
      env[name] = value;
    }
  }
  // Same cast the config builders above use: MCPServerConfig types env as an
  // intersection that a plain Record<string, EnvVarValue> can't satisfy.
  return { ...config, env } as Partial<MCPServerConfig>;
}

/**
 * Env vars (or remote headers) the user still has to provide before the
 * server can run — used by the UI to warn before handing off. A curated
 * spotlight env override counts as providing the value.
 */
export function missingRequiredInputs(
  option: InstallOption,
  envOverrides?: Record<string, string>
): string[] {
  if (option.kind === 'package') {
    return (option.pkg.environmentVariables ?? [])
      .filter(v => v.isRequired && !(v.value ?? v.default) && !envOverrides?.[v.name])
      .map(v => v.name);
  }
  return (option.remote.headers ?? [])
    .filter(h => h.isRequired && !(h.value ?? h.default))
    .map(h => h.name);
}
