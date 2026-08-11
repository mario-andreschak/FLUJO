/**
 * Headless MCP-server install from the public registry (brain / self-improvement
 * track: FLUJO must be able to ACQUIRE capabilities without a human driving the
 * ServerModal).
 *
 * Today's marketplace install is frontend-orchestrated (Marketplace tab → config
 * prefill → Local tab test-run → save). This module is the backend equivalent as
 * one call: registry name → resolved entry → config (packages preferred, same
 * builders the UI uses) → save via mcpService.updateServerConfig (which connects)
 * → the new server's tools.
 *
 * Consent: callers gate this — the flow generator only exposes it behind the
 * per-generation `allowInstall` opt-in, and the /mcp-flows authoring tool carries
 * the warning in its description. Installing means DOWNLOADING AND RUNNING a
 * third-party package (npx/uvx/docker) on this machine.
 *
 * Secrets: a required env var / header with no default cannot be conjured — the
 * install reports `needsEnv` instead of installing, so the caller (LLM or human)
 * can either supply values, pick a keyless alternative, or surface it to the user.
 */
import { createLogger } from '@/utils/logger';
import { REGISTRY_ORIGIN, registryGetJson } from '@/backend/utils/registryClient';
import {
  RegistryListResponse,
  RegistryServerResult,
  RegistryServer,
  InstallOption,
  isAutoInstallable,
  ResolvedInstallPlan,
  getInstallOptions,
  buildConfigFromOption,
  applySpotlightEnvDefaults,
  missingRequiredInputs,
  resolvedPlanFrom,
  verificationStatusOf,
  QualitySummary,
} from '@/utils/mcp/registry';
import { mcpService } from '@/backend/services/mcp';
import { enrichAndRank } from '@/backend/services/mcp/quality/orchestrator';
import { ServerCandidate, ScoredCandidate } from '@/backend/services/mcp/quality/types';
import { GITHUB_PROVIDER_ID } from '@/backend/services/mcp/quality/providers/githubStars';
import { NPM_PROVIDER_ID } from '@/backend/services/mcp/quality/providers/npmDownloads';
import { REGISTRY_STATUS_PROVIDER_ID } from '@/backend/services/mcp/quality/providers/registryStatus';
import { loadQualitySettings } from '@/backend/services/mcp/quality/settings';
import type { MCPHeaderValue, MCPServerConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/registryInstall');

const REGISTRY_LIST_PATH = '/v0.1/servers';
const REGISTRY_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_LIMIT = 8;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface RegistrySearchHit {
  /** Registry name, e.g. "ai.keenable/web-search" — what install takes. */
  name: string;
  title?: string;
  description?: string;
  /** False when FLUJO has no supported way to run this entry. */
  installable: boolean;
  /** Required env vars / headers with no default — must be provided to install. */
  requiredEnv: string[];
  /** Quality ranking signals; absent only if enrichment was fully skipped. */
  quality?: QualitySummary;
}

/** Build a ServerCandidate (what the quality layer scores) from a registry result. */
function toCandidate(result: RegistryServerResult): ServerCandidate {
  return {
    registryName: result.server.name,
    server: result.server,
    verificationStatus: verificationStatusOf(result),
  };
}

/** Pull a compact, UI-friendly quality summary out of a scored candidate. */
function qualityFromScored(scored: ScoredCandidate): QualitySummary {
  const evidenceOf = (id: string) => scored.signals.find((s) => s.providerId === id)?.evidence;
  const gh = evidenceOf(GITHUB_PROVIDER_ID);
  const npm = evidenceOf(NPM_PROVIDER_ID);
  const status = evidenceOf(REGISTRY_STATUS_PROVIDER_ID);
  return {
    score: scored.score,
    ...(typeof gh?.stars === 'number' ? { stars: gh.stars } : {}),
    ...(typeof npm?.weeklyDownloads === 'number' ? { weeklyDownloads: npm.weeklyDownloads } : {}),
    ...(typeof status?.status === 'string' ? { status: status.status } : {}),
  };
}

/**
 * Search the public MCP registry, RANKED by blended quality (GitHub stars +
 * recency, npm downloads, registry status) so the best/most-working servers come
 * first — headless callers pick from the top, humans see the good ones up front.
 *
 * NOTE: the registry matches the SEARCH TERM against server NAMES only
 * (substring), not descriptions — callers should try several short terms
 * ("voice", "tts", "speech") rather than sentences.
 */
export async function searchRegistry(
  query: string,
  limit = DEFAULT_SEARCH_LIMIT
): Promise<RegistrySearchHit[]> {
  const results = await fetchRegistryResults(query, limit);
  const ranked = await enrichAndRank(query, results.map(toCandidate));
  return ranked.map((sc) => toSearchHit(sc.candidate.server, sc));
}

/**
 * Read-only capability discovery for callers that want ranked recommendations
 * without coupling research to installation. Unlike searchRegistry, this fans a
 * natural-language request into Registry-friendly name terms before ranking.
 */
export async function findBestRegistryServers(
  query: string,
  limit = DEFAULT_SEARCH_LIMIT,
): Promise<RegistrySearchHit[]> {
  if (!query || typeof query !== 'string') return [];
  const pages = await Promise.all(capabilitySearchTerms(query).map((term) => fetchRegistryResults(term, 10)));
  const byName = new Map<string, RegistryServerResult>();
  for (const result of pages.flat()) {
    if (!byName.has(result.server.name)) byName.set(result.server.name, result);
  }
  const ranked = await enrichAndRank(query, [...byName.values()].map(toCandidate));
  return ranked.slice(0, Math.min(Math.max(limit, 1), 30))
    .map((candidate) => toSearchHit(candidate.candidate.server, candidate));
}

/** Raw registry list fetch (no ranking), shared by search + resolve paths. */
async function fetchRegistryResults(query: string, limit: number): Promise<RegistryServerResult[]> {
  const url = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 30)));
  if (query) url.searchParams.set('search', query);

  const data = (await registryGetJson(url, REGISTRY_TIMEOUT_MS)) as RegistryListResponse;
  return Array.isArray(data?.servers) ? data.servers : [];
}

function toSearchHit(server: RegistryServer, scored?: ScoredCandidate): RegistrySearchHit {
  // Launch-and-connect entries (#392) are describable but not headlessly
  // installable, so they must not make a hit look installable.
  const options = getInstallOptions(server).filter(isAutoInstallable);
  const best = options[0];
  return {
    name: server.name,
    ...(server.title ? { title: server.title } : {}),
    ...(server.description ? { description: server.description } : {}),
    installable: options.length > 0,
    requiredEnv: best ? missingRequiredInputs(best) : [],
    ...(scored ? { quality: qualityFromScored(scored) } : {}),
  };
}

/**
 * Rank a page of raw registry results by blended quality and annotate each with
 * its `quality` summary — for the Marketplace proxy so the browser gets the same
 * ranking + badges the headless path uses. `quality` is attached only to results
 * the layer actually enriched (non-empty signals); the rest keep registry order
 * after the ranked ones. Best-effort: on any failure the input is returned as-is.
 */
export async function rankRegistryResults(
  query: string,
  results: RegistryServerResult[]
): Promise<RegistryServerResult[]> {
  try {
    const scored = await enrichAndRank(query, results.map(toCandidate));
    const byName = new Map(results.map((r) => [r.server.name, r]));
    const ranked: RegistryServerResult[] = [];
    for (const sc of scored) {
      const original = byName.get(sc.candidate.server.name);
      if (!original) continue;
      ranked.push(
        sc.signals.length > 0
          ? { ...original, quality: qualityFromScored(sc) }
          : original // not enriched → don't fabricate a quality summary
      );
    }
    return ranked.length === results.length ? ranked : results;
  } catch {
    return results;
  }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallResult {
  installed: boolean;
  /** FLUJO server name (sanitized) — what flows reference via boundServer. */
  serverName?: string;
  /** Tools reported by the server after connect. */
  tools?: Array<{ name: string; description?: string }>;
  /** True when a server of this name already existed (nothing was changed). */
  alreadyExisted?: boolean;
  /** Required env vars/headers the caller must provide; set when NOT installed. */
  needsEnv?: string[];
  /**
   * The resolved install plan (SEP-1024 consent preview): exact command/args +
   * required env NAMES + verification status. Populated on every path where an
   * entry resolved to a runnable option — including resolve-only, needsEnv and
   * the actual-install path — so any caller can preview/log what would run.
   */
  plan?: ResolvedInstallPlan;
  /**
   * True when the server was installed, connected, but the works-gate rejected
   * it (it exposed zero tools or failed to start) and it was rolled back. The
   * caller should try a different server rather than treat this as a config bug.
   */
  worksGateRejected?: boolean;
  error?: string;
}

export interface InstallOptions {
  /**
   * Resolve the entry and return the plan WITHOUT spawning (SEP-1024 dry-run).
   * `installed` is false and `plan` is populated; the server is not saved.
   */
  resolveOnly?: boolean;
  /**
   * Works-gate: after connecting, reject (and roll back) a server that exposes
   * zero tools / failed to start. Defaults to the mcpQuality `worksGate` setting;
   * pass false to force it off for a specific install.
   */
  worksGate?: boolean;
  /**
   * Package-provided replacements for existing stdio argument positions. Each
   * value must contain a portable `${global:NAME}` reference; raw commands and
   * unrelated arguments are never accepted through this channel.
   */
  argTemplates?: Array<{ index: number; value: string }>;
  /**
   * Transport recorded by a package export. Registry entries can expose both a
   * local package and a hosted endpoint; restore the same kind that was
   * exported instead of blindly taking the registry's first option.
   */
  preferredTransport?: 'stdio' | 'sse' | 'streamable' | 'websocket';
  /** Optional reviewed FLUJO config name (used by the assisted-install UI). */
  serverName?: string;
  /**
   * The hosted endpoint was probed and advertised OAuth dynamic client
   * registration. In this mode the OAuth provider owns Authorization, so a
   * Registry-declared static Authorization header must not be requested/saved.
   */
  oauthDynamicClientRegistration?: boolean;
  /**
   * Exact plan that was reviewed/audited immediately before this call. The
   * install is rejected before saving or spawning if a fresh Registry resolve
   * changes any security-relevant field.
   */
  expectedPlan?: ResolvedInstallPlan;
  /** Resolved package header declarations (including secret metadata). */
  headerOverrides?: Record<string, MCPHeaderValue>;
  /** Explicit approval to execute locally when the exported remote kind is unavailable. */
  allowLocalFallback?: boolean;
}

function optionTransport(option: InstallOption): 'stdio' | 'sse' | 'streamable' {
  if (option.kind === 'package') return 'stdio';
  if (option.kind === 'manual-launch') return option.transport;
  return option.remote.type === 'sse' ? 'sse' : 'streamable';
}

function chooseInstallOption(
  options: InstallOption[],
  preferred?: InstallOptions['preferredTransport'],
): InstallOption | undefined {
  if (!preferred) return options[0];
  const exact = options.find((option) => optionTransport(option) === preferred);
  if (exact) return exact;
  // A websocket package cannot be represented by the public registry today.
  // For all other remote transports, prefer another hosted option before ever
  // falling back to code execution on the local machine.
  if (preferred !== 'stdio') {
    return options.find((option) => option.kind === 'remote') ?? options[0];
  }
  return options.find((option) => option.kind === 'package') ?? options[0];
}

function headerLiteral(value: MCPHeaderValue): string {
  return typeof value === 'string' ? value : value.value;
}

function plansMatch(left: ResolvedInstallPlan, right: ResolvedInstallPlan): boolean {
  const comparable = (value: ResolvedInstallPlan) => ({
    registryName: value.registryName,
    resolvedName: value.resolvedName,
    serverName: value.serverName,
    transport: value.transport,
    command: value.command,
    args: value.args,
    serverUrl: value.serverUrl,
    steps: value.steps,
    requiredEnvNames: value.requiredEnvNames,
    verificationStatus: value.verificationStatus,
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function applyArgTemplates(
  config: ReturnType<typeof buildConfigFromOption>,
  templates: InstallOptions['argTemplates'],
): ReturnType<typeof buildConfigFromOption> | { error: string } {
  if (!templates?.length) return config;
  if (config.transport !== 'stdio' || !Array.isArray(config.args)) {
    return { error: 'Package argument templates require a stdio registry server' };
  }
  const args = [...config.args];
  for (const template of templates) {
    if (
      !Number.isInteger(template.index) ||
      template.index < 0 ||
      template.index > args.length ||
      (template.index < args.length &&
        !/\$\{global:[A-Za-z0-9_.-]+\}/.test(args[template.index])) ||
      !/\$\{global:[A-Za-z0-9_.-]+\}/.test(template.value)
    ) {
      return {
        error:
          `Invalid package argument template at index ${String(template.index)}; ` +
          'templates may append arguments or replace an existing global-backed argument',
      };
    }
    args[template.index] = template.value;
  }
  return { ...config, args };
}

/**
 * Resolve a registry entry by its exact name. Never substitute a fuzzy hit:
 * callers use this result to approve and execute a specific install plan.
 * Returns the full result (not just `.server`) so the caller can read the
 * `_meta … status` verification field.
 */
export async function resolveRegistryEntry(registryName: string): Promise<RegistryServerResult | null> {
  const url = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '10');
  url.searchParams.set('search', registryName);
  const data = (await registryGetJson(url, REGISTRY_TIMEOUT_MS)) as RegistryListResponse;
  const results: RegistryServerResult[] = Array.isArray(data?.servers) ? data.servers : [];
  return results.find((r) => r.server?.name === registryName) ?? null;
}

/**
 * Install a registry server end-to-end: resolve → build config → save (which
 * connects) → list tools. Idempotent-ish: an existing server of the same name is
 * left untouched and reported with its tools.
 */
export async function installRegistryServer(
  registryName: string,
  envOverrides?: Record<string, string>,
  options?: InstallOptions
): Promise<InstallResult> {
  if (!registryName || typeof registryName !== 'string') {
    return { installed: false, error: 'A registry server name is required' };
  }

  let result: RegistryServerResult | null;
  try {
    result = await resolveRegistryEntry(registryName);
  } catch (err) {
    return { installed: false, error: `Registry lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const server: RegistryServer | null = result?.server ?? null;
  if (!server) {
    return { installed: false, error: `No registry entry found for "${registryName}"` };
  }

  const allOptions = getInstallOptions(server);
  // #392: a launch-and-connect package is a process the USER starts; FLUJO does
  // not own that lifecycle yet, so the headless installer never picks one.
  const installOptions = allOptions.filter(isAutoInstallable);
  const option = chooseInstallOption(installOptions, options?.preferredTransport);
  if (!option) {
    const manualOnly = installOptions.length === 0 && allOptions.length > 0;
    return {
      installed: false,
      error: manualOnly
        ? `"${server.name}" must be started manually (it runs locally but speaks HTTP); add it from the MCP server dialog instead`
        : `"${server.name}" has no install method FLUJO supports (stdio package or HTTP remote)`,
    };
  }

  // Resolve-only / consent preview: exact command + args + required env NAMES,
  // never touching updateServerConfig. Available before any missing-env or
  // already-exists check so a caller can always show/log what would run.
  const requestedServerName = options?.serverName;
  if (
    requestedServerName !== undefined
    && (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(requestedServerName))
  ) {
    return {
      installed: false,
      error: 'The server name must be 1-64 characters and use only letters, numbers, hyphens, or underscores.',
    };
  }
  const omitOAuthAuthorization = option.kind === 'remote' && options?.oauthDynamicClientRegistration === true;
  const isAuthorization = (name: string) => name.trim().toLocaleLowerCase() === 'authorization';
  const verificationStatus = verificationStatusOf(result);
  const basePlan = resolvedPlanFrom(registryName, server, option, verificationStatus);
  const plan: ResolvedInstallPlan = {
    ...basePlan,
    ...(requestedServerName ? { serverName: requestedServerName } : {}),
    ...(omitOAuthAuthorization
      ? { requiredEnvNames: basePlan.requiredEnvNames.filter(name => !isAuthorization(name)) }
      : {}),
  };
  if (options?.expectedPlan && !plansMatch(plan, options.expectedPlan)) {
    return {
      installed: false,
      serverName: plan.serverName,
      plan,
      error: 'The Registry install plan changed after it was reviewed and audited. Resolve and approve the new exact plan before installing.',
    };
  }
  if (options?.resolveOnly) {
    return { installed: false, serverName: plan.serverName, plan };
  }

  const effectiveHeaderOverrides = Object.fromEntries(
    Object.entries(options?.headerOverrides ?? {})
      .filter(([name]) => !omitOAuthAuthorization || !isAuthorization(name)),
  );
  const providedHeaders = Object.fromEntries(
    Object.entries(effectiveHeaderOverrides).map(([name, value]) => [name, headerLiteral(value)]),
  );
  const missing = missingRequiredInputs(option, { ...envOverrides, ...providedHeaders })
    .filter(name => !omitOAuthAuthorization || !isAuthorization(name));
  if (missing.length > 0) {
    return {
      installed: false,
      needsEnv: missing,
      plan,
      error: `"${server.name}" requires values for: ${missing.join(', ')}`,
    };
  }

  const builtConfig = buildConfigFromOption(server, option);
  // #392 guard: a `launch` spec means "a local process must be running behind
  // this URL". Headless install cannot start it (Phase 2), so fail loudly here
  // instead of persisting a config that would never connect.
  if ('launch' in builtConfig && builtConfig.launch) {
    return {
      installed: false,
      plan,
      error: `"${server.name}" needs a locally launched process behind its HTTP endpoint, which FLUJO does not start yet. Add it from the MCP server dialog and start the process yourself.`,
    };
  }
  const builtHeaders = 'headers' in builtConfig
    ? (builtConfig.headers as Record<string, MCPHeaderValue> | undefined)
    : undefined;
  const policyHeaders = omitOAuthAuthorization
    ? Object.fromEntries(Object.entries(builtHeaders ?? {}).filter(([name]) => !isAuthorization(name)))
    : builtHeaders;
  const registryConfig = {
    ...builtConfig,
    ...(requestedServerName ? { name: requestedServerName } : {}),
    ...(requestedServerName
      ? { rootPath: `mcp-servers/${requestedServerName}` }
      : {}),
    ...(option.kind === 'remote' ? { headers: policyHeaders ?? {} } : {}),
  } as Partial<MCPServerConfig>;
  const currentHeaders =
    'headers' in registryConfig
      ? (registryConfig.headers as Record<string, MCPHeaderValue> | undefined)
      : undefined;
  const baseConfig = applySpotlightEnvDefaults(
    option.kind === 'remote' && Object.keys(effectiveHeaderOverrides).length > 0
      ? { ...registryConfig, headers: { ...(currentHeaders ?? {}), ...effectiveHeaderOverrides } }
      : registryConfig,
    envOverrides,
  );
  const templatedConfig = applyArgTemplates(baseConfig, options?.argTemplates);
  if ('error' in templatedConfig) {
    return { installed: false, plan, error: templatedConfig.error };
  }
  if (
    options?.preferredTransport &&
    options.preferredTransport !== 'stdio' &&
    option.kind === 'package' &&
    !options.allowLocalFallback
  ) {
    return {
      installed: false,
      error:
        `"${server.name}" was exported as ${options.preferredTransport}, but the registry now only offers ` +
        'a local executable install. Confirm local execution before using that fallback.',
    };
  }
  const config = templatedConfig;
  const serverName = config.name as string;

  // Never clobber an existing server: report it as available instead.
  const existing = await mcpService.loadServerConfigs();
  if (Array.isArray(existing) && existing.some((c) => c.name === serverName)) {
    log.info(`installRegistryServer: "${serverName}" already configured; reusing`);
    const { tools, error } = await mcpService.listServerTools(serverName);
    return {
      installed: true,
      alreadyExisted: true,
      serverName,
      plan,
      tools: (tools ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
      ...(error ? { error } : {}),
    };
  }

  log.info(`installRegistryServer: installing "${server.name}" as "${serverName}" (${option.kind})`);
  const saved = await mcpService.updateServerConfig(serverName, config);
  if (!Array.isArray(saved) && saved && 'success' in saved && saved.success === false) {
    return { installed: false, error: `Saving the server failed: ${saved.error ?? 'unknown error'}` };
  }

  // updateServerConfig connects synchronously; listServerTools self-heals with a
  // one-shot reconnect if the first call races the handshake (cold npx/uvx/docker
  // downloads happen inside this connect, so this can take a while).
  const { tools, error } = await mcpService.listServerTools(serverName);
  const toolList = (tools ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) }));

  // Works-gate: a freshly-installed server that failed to start or exposes zero
  // tools is useless (and often "trash" from the registry). Roll back what WE
  // just added and tell the caller to try another — never leave a dead server
  // configured. Only applies to servers this call created (the already-existed
  // path above is left untouched).
  const gate = options?.worksGate ?? (await loadQualitySettings()).worksGate;
  if (gate && toolList.length === 0) {
    log.warn(`installRegistryServer: "${serverName}" exposed no tools${error ? ` (${error})` : ''}; rolling back (works-gate)`);
    try {
      await mcpService.deleteServerConfig(serverName);
    } catch (rollbackErr) {
      log.error(`installRegistryServer: rollback of "${serverName}" failed`, rollbackErr);
    }
    return {
      installed: false,
      worksGateRejected: true,
      serverName,
      plan,
      error: error
        ? `"${server.name}" failed to start: ${error}`
        : `"${server.name}" connected but exposed no tools — rejected by the works-gate. Try a different server.`,
    };
  }

  return {
    installed: true,
    serverName,
    plan,
    tools: toolList,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------------------
// Capability-based headless install (ranked best→worst with the works-gate)
// ---------------------------------------------------------------------------

export interface BestInstallAttempt {
  name: string;
  score: number;
  reason: string;
}

export interface BestInstallResult extends InstallResult {
  /** Candidates tried/skipped before the winner (or before giving up), best-first. */
  attempts?: BestInstallAttempt[];
}

export interface BestInstallOptions {
  /** How many installable candidates to actually attempt. Default 3. */
  maxAttempts?: number;
  /** Minimum composite score to attempt. Defaults to the mcpQuality `minScore`. */
  minScore?: number;
  /**
   * Called with the exact resolve-only plan before any package can be spawned.
   * Return false to stop the ranked walk without executing that candidate.
   */
  beforeAttempt?: (plan: ResolvedInstallPlan) => Promise<boolean | void> | boolean | void;
  /**
   * Audit hook invoked after each attempt with its plan + result, so a caller
   * (e.g. the authoring tool) can record every spawn to the SEP-1024 audit log.
   */
  onAttempt?: (plan: ResolvedInstallPlan | undefined, res: InstallResult) => Promise<void> | void;
}

/**
 * Registry search is name-only, so a natural-language capability sentence is a
 * particularly poor query. Fan it into a few concrete aliases before quality
 * enrichment. The interactive AI path supplies better semantic aliases; this
 * lexical fallback also fixes the internal install_best_mcp_server tool.
 */
export function capabilitySearchTerms(query: string): string[] {
  const ignored = new Set(['connect', 'with', 'from', 'into', 'using', 'want', 'need', 'server', 'mcp', 'that', 'this', 'the', 'and', 'for']);
  const words = query.toLocaleLowerCase()
    .replace(/[^a-z0-9@._/-]+/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[-/@.]+|[-/@.]+$/g, ''))
    .filter((word) => word.length >= 2 && !ignored.has(word));
  const terms = [words.slice(0, 3).join(' '), ...words]
    .map((term) => term.trim().slice(0, 80))
    .filter(Boolean);
  return Array.from(new Set(terms)).slice(0, 6);
}

/**
 * Install the BEST WORKING server for a capability, unattended: search the
 * registry, rank by blended quality, then walk best→worst installing with the
 * works-gate on — the first candidate that boots with a non-empty tool list
 * wins; ones that need unavailable env, aren't installable, or fail the gate are
 * skipped. This is the fully-headless "give me a working X" entry (vs
 * installRegistryServer, which installs a specific named entry).
 */
export async function installBestForCapability(
  query: string,
  envOverrides?: Record<string, string>,
  options?: BestInstallOptions
): Promise<BestInstallResult> {
  if (!query || typeof query !== 'string') {
    return { installed: false, error: 'A capability search query is required' };
  }

  let results: RegistryServerResult[];
  try {
    const pages = await Promise.all(capabilitySearchTerms(query).map((term) => fetchRegistryResults(term, 10)));
    const byName = new Map<string, RegistryServerResult>();
    for (const result of pages.flat()) {
      if (!byName.has(result.server.name)) byName.set(result.server.name, result);
    }
    results = [...byName.values()];
  } catch (err) {
    return { installed: false, error: `Registry lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const ranked = await enrichAndRank(query, results.map(toCandidate));
  const settings = await loadQualitySettings();
  const threshold = options?.minScore ?? settings.minScore;
  const maxAttempts = options?.maxAttempts ?? 3;

  const attempts: BestInstallAttempt[] = [];
  let tried = 0;
  for (const sc of ranked) {
    const name = sc.candidate.registryName;
    // ranked is score-desc: once below threshold, everything after is too.
    if (sc.score < threshold) {
      attempts.push({ name, score: sc.score, reason: `below minScore ${threshold}` });
      break;
    }
    // Don't spend an attempt on entries FLUJO can't run at all.
    if (getInstallOptions(sc.candidate.server).filter(isAutoInstallable).length === 0) {
      attempts.push({ name, score: sc.score, reason: 'no supported install method' });
      continue;
    }
    if (tried >= maxAttempts) break;
    tried += 1;

    const preview = await installRegistryServer(name, undefined, { resolveOnly: true });
    if (!preview.plan) {
      attempts.push({ name, score: sc.score, reason: preview.error ?? 'could not resolve exact install plan' });
      continue;
    }
    if (options?.beforeAttempt) {
      try {
        const proceed = await options.beforeAttempt(preview.plan);
        if (proceed === false) {
          attempts.push({ name, score: sc.score, reason: 'blocked before execution' });
          break;
        }
      } catch (auditErr) {
        log.error('installBestForCapability: beforeAttempt hook failed', auditErr);
        attempts.push({ name, score: sc.score, reason: 'pre-install audit failed' });
        break;
      }
    }

    const res = await installRegistryServer(name, envOverrides, {
      worksGate: true,
      expectedPlan: preview.plan,
    });
    if (options?.onAttempt) {
      try {
        await options.onAttempt(res.plan, res);
      } catch (auditErr) {
        log.error('installBestForCapability: onAttempt hook failed', auditErr);
      }
    }
    if (res.installed) {
      return { ...res, attempts };
    }
    const reason = res.needsEnv?.length
      ? `needs env: ${res.needsEnv.join(', ')}`
      : res.worksGateRejected
        ? 'works-gate rejected (no tools / failed to start)'
        : res.error ?? 'install failed';
    attempts.push({ name, score: sc.score, reason });
  }

  return {
    installed: false,
    attempts,
    error: `No working server found for "${query}" among the top ${tried} installable candidate(s).`,
  };
}
