import path from 'node:path';
import { RESTRICTED_CODEX_CONFIG } from './codexRestrictedProfile';

export const NATIVE_CODEX_STARTUP_POLICY_VERSION = 'restricted-startup-policy-v1';
export type NativeCodexAuthentication = 'chatgpt' | 'api-key' | 'offline-inventory';
type Config = Record<string, unknown>;
const refused = (): never => { throw new Error('Native Codex startup configuration is unavailable.'); };

function offlineInventoryConfiguration(config: Config): Config {
  const providers = config.model_providers as { inventory?: { base_url?: unknown } } | undefined;
  const value = providers?.inventory?.base_url;
  if (config.model_provider !== 'inventory' || typeof value !== 'string') return refused();
  let url: URL;
  try { url = new URL(value); } catch { return refused(); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') return refused();
  // This credential-free loopback responder is only the binary inventory probe.
  return { model_provider: 'inventory', check_for_update_on_startup: false,
    analytics: { enabled: false }, features: { ...RESTRICTED_CODEX_CONFIG.features,
      enable_request_compression: false, unbounded_connection_retries: false },
    model_providers: { inventory: { name: 'Source offline inventory fixture', base_url: value,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      request_max_retries: 0, stream_max_retries: 0 } } };
}

/** Project fixed policy and verified paths, never bridge capabilities or headers. */
export function nativeCodexStartupArguments(input: {
  cwd: string; config: Config; authentication: NativeCodexAuthentication;
  neutralTrustOverrides?: readonly string[];
}): string[] {
  if (!path.isAbsolute(input.cwd)) return refused();
  const neutral = ['project_root_markers=[]', `projects.${JSON.stringify(input.cwd)}.trust_level="untrusted"`];
  if (input.neutralTrustOverrides && JSON.stringify(input.neutralTrustOverrides) !== JSON.stringify(neutral)) return refused();
  const { forced_login_method, ...capabilities } = RESTRICTED_CODEX_CONFIG;
  const projected: Config = { ...capabilities,
    ...(input.authentication === 'chatgpt' ? { forced_login_method } : {}) };
  const catalog = input.config.model_catalog_json;
  if (catalog !== undefined) {
    if (typeof catalog !== 'string' || !path.isAbsolute(catalog)) return refused();
    projected.model_catalog_json = catalog;
  }
  if (input.authentication === 'offline-inventory') {
    Object.assign(projected, offlineInventoryConfiguration(input.config));
  }
  const args = neutral.flatMap(value => ['-c', value]);
  const visit = (value: unknown, key: string) => {
    if (typeof value === 'string' || typeof value === 'boolean') {
      args.push('-c', `${key}=${JSON.stringify(value)}`);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      args.push('-c', `${key}=${value}`);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [child, entry] of Object.entries(value)) visit(entry, key ? `${key}.${child}` : child);
    } else return refused();
  };
  for (const [key, value] of Object.entries(projected)) visit(value, key);
  if (args.length > 256 || args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 32768) return refused();
  return args;
}

/** API-key Persona and unauthenticated inventory must keep their selected auth. */
export function nativeCodexThreadConfiguration(config: Config, authentication: NativeCodexAuthentication): Config {
  const { forced_login_method: omitted, ...rest } = config;
  const { forced_login_method, ...capabilities } = RESTRICTED_CODEX_CONFIG;
  void omitted;
  return { ...rest, ...capabilities,
    ...(authentication === 'chatgpt' ? { forced_login_method } : {}),
    ...(authentication === 'offline-inventory' ? offlineInventoryConfiguration(config) : {}) };
}
