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
  const options = getInstallOptions(server);
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
}

/**
 * Resolve a registry entry by its exact name (falls back to best search hit).
 * Returns the full result (not just `.server`) so the caller can read the
 * `_meta … status` verification field.
 */
async function resolveEntry(registryName: string): Promise<RegistryServerResult | null> {
  const url = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '10');
  url.searchParams.set('search', registryName);
  const data = (await registryGetJson(url, REGISTRY_TIMEOUT_MS)) as RegistryListResponse;
  const results: RegistryServerResult[] = Array.isArray(data?.servers) ? data.servers : [];
  const exact = results.find((r) => r.server?.name === registryName);
  return exact ?? results[0] ?? null;
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
    result = await resolveEntry(registryName);
  } catch (err) {
    return { installed: false, error: `Registry lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const server: RegistryServer | null = result?.server ?? null;
  if (!server) {
    return { installed: false, error: `No registry entry found for "${registryName}"` };
  }

  const installOptions = getInstallOptions(server);
  const option: InstallOption | undefined = installOptions[0]; // packages first, same as the UI
  if (!option) {
    return { installed: false, error: `"${server.name}" has no install method FLUJO supports (stdio package or HTTP remote)` };
  }

  // Resolve-only / consent preview: exact command + args + required env NAMES,
  // never touching updateServerConfig. Available before any missing-env or
  // already-exists check so a caller can always show/log what would run.
  const verificationStatus = verificationStatusOf(result);
  const plan = resolvedPlanFrom(registryName, server, option, verificationStatus);
  if (options?.resolveOnly) {
    return { installed: false, serverName: plan.serverName, plan };
  }

  const missing = missingRequiredInputs(option, envOverrides);
  if (missing.length > 0) {
    return {
      installed: false,
      needsEnv: missing,
      plan,
      error: `"${server.name}" requires values for: ${missing.join(', ')}`,
    };
  }

  const config = applySpotlightEnvDefaults(buildConfigFromOption(server, option), envOverrides);
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
   * Audit hook invoked after each attempt with its plan + result, so a caller
   * (e.g. the authoring tool) can record every spawn to the SEP-1024 audit log.
   */
  onAttempt?: (plan: ResolvedInstallPlan | undefined, res: InstallResult) => Promise<void> | void;
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
    results = await fetchRegistryResults(query, 10);
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
    if (getInstallOptions(sc.candidate.server).length === 0) {
      attempts.push({ name, score: sc.score, reason: 'no supported install method' });
      continue;
    }
    if (tried >= maxAttempts) break;
    tried += 1;

    const res = await installRegistryServer(name, envOverrides, { worksGate: true });
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
