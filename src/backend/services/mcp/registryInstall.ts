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
  getInstallOptions,
  buildConfigFromOption,
  applySpotlightEnvDefaults,
  missingRequiredInputs,
} from '@/utils/mcp/registry';
import { mcpService } from '@/backend/services/mcp';

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
}

/**
 * Search the public MCP registry. NOTE: the registry matches the SEARCH TERM
 * against server NAMES only (substring), not descriptions — callers should try
 * several short terms ("voice", "tts", "speech") rather than sentences.
 */
export async function searchRegistry(
  query: string,
  limit = DEFAULT_SEARCH_LIMIT
): Promise<RegistrySearchHit[]> {
  const url = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 30)));
  if (query) url.searchParams.set('search', query);

  const data = (await registryGetJson(url, REGISTRY_TIMEOUT_MS)) as RegistryListResponse;
  const results = Array.isArray(data?.servers) ? data.servers : [];
  return results.map((r) => toSearchHit(r.server));
}

function toSearchHit(server: RegistryServer): RegistrySearchHit {
  const options = getInstallOptions(server);
  const best = options[0];
  return {
    name: server.name,
    ...(server.title ? { title: server.title } : {}),
    ...(server.description ? { description: server.description } : {}),
    installable: options.length > 0,
    requiredEnv: best ? missingRequiredInputs(best) : [],
  };
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
  error?: string;
}

/** Resolve a registry entry by its exact name (falls back to best search hit). */
async function resolveEntry(registryName: string): Promise<RegistryServer | null> {
  const url = new URL(REGISTRY_ORIGIN + REGISTRY_LIST_PATH);
  url.searchParams.set('version', 'latest');
  url.searchParams.set('limit', '10');
  url.searchParams.set('search', registryName);
  const data = (await registryGetJson(url, REGISTRY_TIMEOUT_MS)) as RegistryListResponse;
  const results: RegistryServerResult[] = Array.isArray(data?.servers) ? data.servers : [];
  const exact = results.find((r) => r.server?.name === registryName);
  return (exact ?? results[0])?.server ?? null;
}

/**
 * Install a registry server end-to-end: resolve → build config → save (which
 * connects) → list tools. Idempotent-ish: an existing server of the same name is
 * left untouched and reported with its tools.
 */
export async function installRegistryServer(
  registryName: string,
  envOverrides?: Record<string, string>
): Promise<InstallResult> {
  if (!registryName || typeof registryName !== 'string') {
    return { installed: false, error: 'A registry server name is required' };
  }

  let server: RegistryServer | null;
  try {
    server = await resolveEntry(registryName);
  } catch (err) {
    return { installed: false, error: `Registry lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!server) {
    return { installed: false, error: `No registry entry found for "${registryName}"` };
  }

  const options = getInstallOptions(server);
  const option: InstallOption | undefined = options[0]; // packages first, same as the UI
  if (!option) {
    return { installed: false, error: `"${server.name}" has no install method FLUJO supports (stdio package or HTTP remote)` };
  }

  const missing = missingRequiredInputs(option, envOverrides);
  if (missing.length > 0) {
    return {
      installed: false,
      needsEnv: missing,
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
  return {
    installed: true,
    serverName,
    tools: (tools ?? []).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
    ...(error ? { error } : {}),
  };
}
