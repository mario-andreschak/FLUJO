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
 * ServerModal's ConfigureTab can finalize (fill in required env vars, test,
 * save) — the same handoff the GitHub/Remote/Reference tabs use.
 *
 * A third shape exists (#392): packages whose `transport.type` is
 * `streamable-http` / `sse` — you launch them locally but talk to them over
 * HTTP. FLUJO does not own that process lifecycle yet, so those surface as
 * `manual-launch` options: visible, with the exact command line to run and the
 * loopback URL to connect to, but never executed by FLUJO.
 */

import { MCPServerConfig, EnvVarValue, MCPServerIcon, MCPServerSource, MCPLaunchSpec } from '@/shared/types/mcp/mcp';

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

export interface RegistryIcon {
  src: string;
  sizes?: string[];
  mimeType?: string;
  /** 'light' | 'dark' — which UI theme the icon is intended for. */
  theme?: string;
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
  /** Optional server-provided icons (server.json `icons`); may be absent. */
  icons?: RegistryIcon[];
}

/**
 * Compact quality summary attached to a search/listing result by the ranking
 * layer (GitHub stars + recency, npm downloads, registry status). Present only
 * on results the quality layer actually enriched; absent otherwise.
 */
export interface QualitySummary {
  /** Blended 0..1 composite score the results are sorted by. */
  score: number;
  /** GitHub stars, when the repo was resolved. */
  stars?: number;
  /** npm last-week downloads, when the package was resolved. */
  weeklyDownloads?: number;
  /** Registry lifecycle status ('active' | 'unverified' | …). */
  status?: string;
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
  /** Blended quality signals; set by the ranking layer, absent when not enriched. */
  quality?: QualitySummary;
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

/**
 * A registry package that exposes an HTTP endpoint when run locally (#392).
 * FLUJO can describe it exactly — command line and loopback URL — but does not
 * start it (Phase 2). The UI renders these disabled-but-visible with a copyable
 * run command, so users can see the entry instead of it silently vanishing.
 */
export interface ManualLaunchOption {
  kind: 'manual-launch';
  label: string;
  pkg: RegistryPackage;
  /** How FLUJO would talk to it once the user has started it. */
  transport: 'streamable' | 'sse';
  /** Loopback-verified endpoint, absent when the template could not be resolved safely. */
  resolvedUrl?: string;
  /** Why `resolvedUrl` is absent, when it is. */
  urlError?: 'missing-url' | 'unresolved-placeholder' | 'non-loopback' | 'invalid-url';
  /** Human detail for `urlError` (unbound placeholder name, rejected host, …). */
  urlErrorDetail?: string;
  /** The exact command line the user must run themselves. Displayed, NEVER executed. */
  runLine: string;
}

export type InstallOption =
  | { kind: 'package'; label: string; pkg: RegistryPackage }
  | { kind: 'remote'; label: string; remote: RegistryRemote }
  | ManualLaunchOption;

/**
 * True for options FLUJO can install without the user starting anything by
 * hand. Headless install paths (registryInstall, the MCP assistant) filter on
 * this so a `manual-launch` entry is never silently chosen for them.
 */
export function isAutoInstallable(option: InstallOption): boolean {
  return option.kind !== 'manual-launch';
}

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

/**
 * Why FLUJO can (or cannot) one-click install a registry package. A bare
 * boolean loses the distinction between "we have no idea how to run this" and
 * "we know exactly how to run it, we just don't own the process yet" — and the
 * UI needs that distinction to degrade gracefully instead of hiding the entry.
 */
export type PackageSupport =
  | { supported: true }
  | {
      supported: false;
      reason:
        | 'no-identifier'
        | 'unknown-runner'
        /** Launch locally, connect over HTTP (#392) — describable, not yet spawnable. */
        | 'launch-and-connect'
        | 'unknown-transport';
    };

export function packageSupport(pkg: RegistryPackage): PackageSupport {
  // A package we can only run if we know a runner for its registry type
  // (or the publisher told us one explicitly via runtimeHint).
  if (!pkg.identifier) return { supported: false, reason: 'no-identifier' };
  if (!PACKAGE_RUNNERS[pkg.registryType] && !pkg.runtimeHint) {
    return { supported: false, reason: 'unknown-runner' };
  }
  const transportType = pkg.transport?.type;
  if (!transportType || transportType === 'stdio') return { supported: true };
  // Packages that expose an HTTP endpoint when run locally need a
  // spawn-then-poll flow FLUJO doesn't have yet; they are surfaced as
  // manual-launch options rather than dropped.
  if (transportType === 'streamable-http' || transportType === 'sse') {
    return { supported: false, reason: 'launch-and-connect' };
  }
  return { supported: false, reason: 'unknown-transport' };
}

/** Thin boolean wrapper over {@link packageSupport}. */
export function isPackageSupported(pkg: RegistryPackage): boolean {
  return packageSupport(pkg).supported;
}

function isRemoteSupported(remote: RegistryRemote): boolean {
  return Boolean(remote.url) && (remote.type === 'streamable-http' || remote.type === 'sse');
}

/**
 * Quote a token for display in a copyable shell command line. Anything outside
 * the conventional "safe" set is quoted — including `<`/`>`, which appear in the
 * `<PLACEHOLDER>` values we render and would otherwise be shell redirections.
 */
function shellToken(token: string): string {
  if (token !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `"${token.replace(/(["$`\\])/g, '\\$1')}"`;
}

/** The exact command line a user would type to start a manual-launch package. */
export function runCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(shellToken).join(' ');
}

/** Build the `manual-launch` option for a launch-and-connect package (#392). */
function manualLaunchOption(pkg: RegistryPackage): ManualLaunchOption {
  // Display form: the user's shell has none of the config env, so the command
  // line must carry the values itself (see `envFlags: 'inline'`).
  const { command, args } = packageCommandAndArgs(pkg, { envFlags: 'inline' });
  const transport: 'streamable' | 'sse' = pkg.transport?.type === 'sse' ? 'sse' : 'streamable';
  const template = pkg.transport?.url;
  const base: ManualLaunchOption = {
    kind: 'manual-launch',
    label: `${registryTypeLabel(pkg.registryType)}: ${pkg.identifier} (manual start)`,
    pkg,
    transport,
    runLine: runCommandLine(command, args)
  };
  if (!template) return { ...base, urlError: 'missing-url', urlErrorDetail: 'no transport.url declared' };
  const resolution = resolveTransportUrl(template, {
    env: environmentBindings(pkg.environmentVariables),
    args: {
      ...argumentBindings(pkg.runtimeArguments),
      ...argumentBindings(pkg.packageArguments)
    }
  });
  if ('url' in resolution) return { ...base, resolvedUrl: resolution.url };
  return { ...base, urlError: resolution.error, urlErrorDetail: resolution.detail };
}

/**
 * All install options for a registry entry: packages first, then hosted
 * remotes, then launch-and-connect packages the user must start themselves.
 * Entries FLUJO genuinely cannot describe (unknown package type, unknown
 * transport, unknown remote type) are still omitted.
 */
export function getInstallOptions(server: RegistryServer): InstallOption[] {
  const options: InstallOption[] = [];
  const manual: InstallOption[] = [];
  for (const pkg of server.packages ?? []) {
    const support = packageSupport(pkg);
    if (support.supported) {
      options.push({
        kind: 'package',
        label: `${registryTypeLabel(pkg.registryType)}: ${pkg.identifier}`,
        pkg
      });
    } else if (support.reason === 'launch-and-connect') {
      manual.push(manualLaunchOption(pkg));
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
  // Manual-launch entries come last: every existing caller that just takes
  // options[0] keeps preferring something FLUJO can actually install.
  return [...options, ...manual];
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
  // Some publishers repeat the generic word in the namespace as well, e.g.
  // "com.paypal.mcp/mcp". Walk backwards to the first distinctive segment so
  // those entries become "paypal-mcp" instead of the meaningless "mcp-mcp".
  const nsSegment = namespace
    .split('.')
    .reverse()
    .find(segment => segment && !GENERIC_SLUGS.has(segment.toLowerCase())) || '';
  return nsSegment ? `${nsSegment}-${slug}` : slug;
}

/** Human-facing display name: title if present, else the part after the namespace. */
export function displayName(server: RegistryServer): string {
  if (server.title) return server.title;
  return qualifiedSlug(server.name);
}

/**
 * Best icon URL for a registry server, or null when none is usable. Prefers an
 * icon matching the given theme, falls back to any icon. Only http(s) sources
 * are returned (a registry entry is untrusted data — never render data: URIs or
 * other schemes as an <img> src). Returns null if the registry provides no
 * icons, in which case the UI falls back to the lettered avatar.
 */
export function serverIconUrl(
  server: RegistryServer,
  theme?: 'light' | 'dark'
): string | null {
  const icons = server.icons;
  if (!icons || icons.length === 0) return null;
  const usable = icons.filter(icon => {
    if (!icon?.src) return false;
    try {
      return /^https?:$/.test(new URL(icon.src).protocol);
    } catch {
      return false;
    }
  });
  if (usable.length === 0) return null;
  const themed = theme ? usable.find(icon => icon.theme === theme) : undefined;
  return (themed ?? usable[0]).src;
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

/**
 * Name → value map for NAMED arguments, preserving what `argumentsToTokens()`
 * necessarily destroys (it flattens `--port 8088` into a token vector). Needed
 * to resolve `{--port}` style URL templates. Deliberately a sibling: the token
 * function has callers and tests that depend on its exact behaviour.
 */
export function argumentBindings(args?: RegistryArgument[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const arg of args ?? []) {
    if (arg.type !== 'named' || !arg.name) continue;
    const value = arg.value ?? arg.default;
    if (value === undefined || value === '') continue;
    bindings[arg.name] = value;
  }
  return bindings;
}

/** Name → value map for declared environment variables (`value ?? default`). */
export function environmentBindings(vars?: RegistryKeyValueInput[]): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const v of vars ?? []) {
    if (!v.name) continue;
    const value = v.value ?? v.default;
    if (value === undefined || value === '') continue;
    bindings[v.name] = value;
  }
  return bindings;
}

export type TransportUrlResolution =
  | { url: string }
  | { error: 'unresolved-placeholder' | 'non-loopback' | 'invalid-url'; detail: string };

/**
 * Loopback per RFC 5735 / RFC 4291: `localhost`, the whole 127.0.0.0/8 block,
 * and `::1`. `URL.hostname` brackets IPv6 literals, so strip those first.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some(octet => octet > 255)) return false;
  return octets[0] === 127;
}

/**
 * Resolve a registry `Package.transport.url` template against the entry's own
 * declarations. `{DEVICESHELF_API_PORT}` binds against environment-variable
 * names, `{--host}` / `{--port}` against named-argument names.
 *
 * SECURITY (#392): a launch-and-connect entry means "FLUJO starts this process
 * on your machine". A live scan of the registry found publishers templating
 * this field to PUBLIC endpoints, which would point a config the user believes
 * is local at a third party. Any host that is not loopback is therefore
 * rejected outright; such entries fall back to the plain remote path, which
 * carries the marketplace trust gate.
 */
export function resolveTransportUrl(
  urlTemplate: string,
  bindings: { env: Record<string, string>; args: Record<string, string> }
): TransportUrlResolution {
  const unbound: string[] = [];
  const substituted = urlTemplate.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = bindings.args[name] ?? bindings.env[name];
    if (value === undefined || value === '') {
      unbound.push(name);
      return '';
    }
    return value;
  });
  if (unbound.length > 0) {
    return { error: 'unresolved-placeholder', detail: unbound.join(', ') };
  }

  let parsed: URL;
  try {
    parsed = new URL(substituted);
  } catch {
    return { error: 'invalid-url', detail: substituted };
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return { error: 'invalid-url', detail: substituted };
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return { error: 'non-loopback', detail: parsed.hostname };
  }
  return { url: parsed.toString() };
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
  // Registry entries are untrusted. Persist only web-hosted icon sources so a
  // saved config can never later inject a data:, javascript:, or file: URL.
  const icons: MCPServerIcon[] = (server.icons ?? []).flatMap(icon => {
    if (!icon?.src) return [];
    try {
      if (!/^https?:$/.test(new URL(icon.src).protocol)) return [];
    } catch {
      return [];
    }
    const safeIcon: MCPServerIcon = {
      src: icon.src,
      ...(icon.sizes ? { sizes: icon.sizes } : {}),
      ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
      ...(icon.theme === 'light' || icon.theme === 'dark' ? { theme: icon.theme } : {}),
    };
    return [safeIcon];
  });
  return {
    name: sanitizeServerName(server.name),
    disabled: false,
    autoApprove: [],
    env: {},
    _buildCommand: '',
    _installCommand: '',
    ...(icons.length > 0 ? { icons } : {}),
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

/**
 * The runner command + argument vector for a package, shared by the stdio
 * builder and the launch-and-connect builder so both describe the *same*
 * process (one FLUJO spawns, one the user spawns).
 */
/**
 * Env flags for a command line a HUMAN copies and runs (#392 manual launch).
 *
 * The pass-through form (`-e NAME`) only works when the process that runs
 * docker already has NAME in its environment — true when FLUJO spawns it with
 * the config env, false for a user pasting the line into a shell, where a bare
 * `-e PORT` silently never reaches the container. So the displayed line inlines
 * the value the registry declared, and shows an explicit `<NAME>` placeholder
 * where there is nothing to inline. Secrets are NEVER inlined: they are the
 * user's to supply, and a copyable command is a very easy way to leak one.
 */
function inlineEnvFlags(vars?: RegistryKeyValueInput[]): string[] {
  const flags: string[] = [];
  for (const v of vars ?? []) {
    if (!v.name) continue;
    const value = v.value ?? v.default;
    const inlineable = !v.isSecret && value !== undefined && value !== '';
    flags.push('-e', `${v.name}=${inlineable ? value : `<${v.name}>`}`);
  }
  return flags;
}

function packageCommandAndArgs(
  pkg: RegistryPackage,
  options: {
    /**
     * `passthrough` (default) names env vars only (`-e NAME`) so the values in
     * the server config — which the user can still edit afterwards — stay the
     * single source of truth for the process FLUJO spawns. `inline` renders a
     * self-contained line for display/copying.
     */
    envFlags?: 'passthrough' | 'inline';
  } = {}
): {
  command: string;
  args: string[];
  env: Record<string, EnvVarValue>;
} {
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
      const envFlags =
        options.envFlags === 'inline'
          ? inlineEnvFlags(pkg.environmentVariables)
          : Object.keys(env).flatMap(name => ['-e', name]);
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

  return { command, args, env };
}

function buildPackageConfig(server: RegistryServer, pkg: RegistryPackage): Partial<MCPServerConfig> {
  const { command, args, env } = packageCommandAndArgs(pkg);
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

/**
 * Launch-and-connect config (#392): an ordinary streamable/sse config whose
 * `launch` field records the process that has to be running behind it.
 *
 * Phase 1 produces and PERSISTS this shape; nothing spawns it. `serverUrl` is
 * empty when the registry's URL template could not be resolved to a verified
 * loopback endpoint — the user fills it in in the Configure tab, exactly as
 * with any other placeholder the registry left behind.
 */
function buildLaunchAndConnectConfig(
  server: RegistryServer,
  option: ManualLaunchOption
): Partial<MCPServerConfig> {
  const { command, args, env } = packageCommandAndArgs(option.pkg);
  const launch: MCPLaunchSpec = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {})
  };
  return {
    ...baseConfig(server),
    transport: option.transport,
    serverUrl: option.resolvedUrl ?? '',
    headers: {},
    env,
    launch,
    // The package runner fetches a published package; there is no checkout.
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
 * The result is a Partial<MCPServerConfig> meant to pre-fill ConfigureTab;
 * required-but-unknown values are left as visible `<placeholders>` / empty
 * env values for the user to fill in before saving.
 */
export function buildConfigFromOption(
  server: RegistryServer,
  option: InstallOption
): Partial<MCPServerConfig> {
  const config = option.kind === 'package'
    ? buildPackageConfig(server, option.pkg)
    : option.kind === 'manual-launch'
      ? buildLaunchAndConnectConfig(server, option)
      : buildRemoteConfig(server, option.remote);
  // Install-origin (#193): every server built from a registry entry carries a
  // `registry` source so package export can serialize it by reference. Both the
  // Marketplace and Spotlight tabs (and the headless installRegistryServer) funnel
  // through here, so setting it once covers all registry-backed install paths.
  const version = option.kind === 'remote'
    ? server.version
    : (option.pkg.version ?? server.version);
  const source: MCPServerSource = {
    type: 'registry',
    registryName: server.name,
    ...(version ? { version } : {}),
  };
  return { ...config, source } as Partial<MCPServerConfig>;
}

// ---------------------------------------------------------------------------
// Resolved install plan (SEP-1024 consent preview — issue #98)
// ---------------------------------------------------------------------------

/**
 * The exact, untruncated result of resolving a registry entry into something
 * FLUJO would run — WITHOUT running it. This is the SEP-1024 "consent preview":
 * the resolved command + args a caller must be able to show/log/approve before
 * any spawn. It carries env-var NAMES only, never values, per FLUJO's
 * secrets-never-to-the-frontend posture.
 */
export interface ResolvedInstallPlan {
  /** The name the caller asked to install. */
  registryName: string;
  /** The registry server.name actually resolved (may differ from the request). */
  resolvedName: string;
  /** Sanitized FLUJO server name the config would be saved under. */
  serverName: string;
  transport: 'stdio' | 'streamable' | 'sse' | 'websocket';
  /** Runner command for stdio packages, e.g. "npx" / "uvx" / "docker". */
  command?: string;
  /** Untruncated argument vector as it would be spawned. */
  args?: string[];
  /** Endpoint for remote transports. */
  serverUrl?: string;
  /**
   * Multi-command sources (notably GitHub) list every reviewed execution step.
   * Registry packages normally use the top-level command/args only.
   */
  steps?: Array<{ label: string; command: string; args?: string[]; cwd?: string }>;
  /** Required env-var / header NAMES this entry declares — NEVER values. */
  requiredEnvNames: string[];
  /**
   * Registry verification status (from `_meta … status`). 'unverified' when the
   * registry did not assert one — registry entries are self-asserted.
   */
  verificationStatus: string;
}

/** The registry only asserts a lifecycle status; treat only 'active' as vouched-for. */
export function isVerifiedStatus(status: string | undefined | null): boolean {
  return status === 'active';
}

/** Extract the registry verification status, defaulting to 'unverified' when absent. */
export function verificationStatusOf(result: RegistryServerResult | null | undefined): string {
  const status = result?._meta?.['io.modelcontextprotocol.registry/official']?.status;
  return typeof status === 'string' && status.length > 0 ? status : 'unverified';
}

/** Required env-var / header NAMES an option declares (regardless of whether a value exists). */
export function requiredInputNames(option: InstallOption): string[] {
  if (option.kind === 'remote') {
    return (option.remote.headers ?? []).filter(h => h.isRequired && h.name).map(h => h.name);
  }
  return (option.pkg.environmentVariables ?? []).filter(v => v.isRequired && v.name).map(v => v.name);
}

/**
 * Build the resolve-only plan for a registry entry + chosen option. Pure:
 * derives command/args from the same config builders the install/UI use, so the
 * preview is exactly what would be spawned.
 */
export function resolvedPlanFrom(
  registryName: string,
  server: RegistryServer,
  option: InstallOption,
  verificationStatus: string
): ResolvedInstallPlan & { transport: 'stdio' | 'streamable' | 'sse' } {
  // MCPServerConfig is a discriminated union (stdio | websocket | streamable | …);
  // read the transport-specific fields through a loose view rather than narrowing.
  const config = buildConfigFromOption(server, option) as Partial<MCPServerConfig> & {
    command?: string;
    args?: string[];
    serverUrl?: string;
  };
  const transport = (config.transport ?? 'stdio') as 'stdio' | 'streamable' | 'sse';
  return {
    registryName,
    resolvedName: server.name,
    serverName: (config.name as string) ?? sanitizeServerName(server.name),
    transport,
    ...(config.command ? { command: config.command } : {}),
    ...(Array.isArray(config.args) ? { args: config.args } : {}),
    ...(config.serverUrl ? { serverUrl: config.serverUrl } : {}),
    requiredEnvNames: requiredInputNames(option),
    verificationStatus,
  };
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
  if (option.kind === 'remote') {
    return (option.remote.headers ?? [])
      .filter(h => h.isRequired && !(h.value ?? h.default) && !envOverrides?.[h.name])
      .map(h => h.name);
  }
  return (option.pkg.environmentVariables ?? [])
    .filter(v => v.isRequired && !(v.value ?? v.default) && !envOverrides?.[v.name])
    .map(v => v.name);
}
