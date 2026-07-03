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

/** Human-facing display name: title if present, else the part after the namespace. */
export function displayName(server: RegistryServer): string {
  if (server.title) return server.title;
  const slug = server.name.split('/').pop() || server.name;
  return slug;
}

/**
 * FLUJO server name derived from the registry name: the segment after the
 * namespace, restricted to safe characters (it becomes a config key and a
 * directory-name candidate).
 */
export function sanitizeServerName(registryName: string): string {
  const slug = registryName.split('/').pop() || registryName;
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

  return {
    ...baseConfig(server),
    transport: remote.type === 'sse' ? 'sse' : 'streamable',
    serverUrl: remote.url,
    headers,
    rootPath: '/'
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

/**
 * Env vars (or remote headers) the user still has to provide before the
 * server can run — used by the UI to warn before handing off.
 */
export function missingRequiredInputs(option: InstallOption): string[] {
  if (option.kind === 'package') {
    return (option.pkg.environmentVariables ?? [])
      .filter(v => v.isRequired && !(v.value ?? v.default))
      .map(v => v.name);
  }
  return (option.remote.headers ?? [])
    .filter(h => h.isRequired && !(h.value ?? h.default))
    .map(h => h.name);
}
