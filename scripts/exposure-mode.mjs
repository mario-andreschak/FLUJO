import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXPOSURE_MODE_ENV = 'FLUJO_EXPOSURE_MODE';
export const EXPOSURE_MODES = new Set(['localhost', 'network', 'public']);
// Escape hatch: when the persisted network setting is enabled, this env var is
// set so the MCP Apps sandbox and the browser live-view gateway relax their
// origin allowlists. Read by src/backend/mcpApps/sandboxServer.ts and
// mcp-servers/browser/src/gateway.ts.
export const SANDBOX_ALLOW_ALL_ENV = 'FLUJO_MCP_APP_SANDBOX_ALLOW_ALL';

function normalizedMode(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return EXPOSURE_MODES.has(normalized) ? normalized : undefined;
}

function legacyMode(env) {
  if (
    env.FLUJO_MCP_APP_SANDBOX_PUBLIC_URL?.trim()
    || env.FLUJO_MCP_APP_HOST_ORIGINS?.trim()
  ) return 'public';
  if (
    env.FLUJO_EXTRA_LOCAL_HOSTS
      ?.split(',')
      .some((entry) => entry.trim().length > 0 && entry.trim() !== '.')
  ) return 'network';
  return undefined;
}

/**
 * Read the one persisted Settings value before Next starts. Keeping this tiny
 * reader in the launcher gives proxy/route bundles a single immutable env value
 * and avoids filesystem access in the request hot path.
 */
export function readPersistedExposureMode(env = process.env, cwd = process.cwd()) {
  const dataDir = env.FLUJO_DATA_DIR?.trim()
    ? path.resolve(env.FLUJO_DATA_DIR)
    : path.resolve(cwd);
  const settingsFile = path.join(dataDir, 'db', 'speech_settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const persistedMode = normalizedMode(settings?.network?.exposure);
    if (persistedMode) return persistedMode;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      console.warn(`[FLUJO] Could not read network exposure setting from ${settingsFile}:`, error);
    }
  }

  return undefined;
}

export function readExposureMode(env = process.env, cwd = process.cwd()) {
  const explicitRuntimeMode = normalizedMode(env[EXPOSURE_MODE_ENV]);
  if (explicitRuntimeMode) return explicitRuntimeMode;
  return readPersistedExposureMode(env, cwd) || legacyMode(env) || 'localhost';
}

/**
 * Read the persisted `network.allowAllMcpAppContent` escape hatch before Next
 * starts. Mirrors readPersistedExposureMode so the launcher can expose a single
 * immutable env value to the sandbox and browser gateway. Missing/false => false.
 */
export function readPersistedAllowAll(env = process.env, cwd = process.cwd()) {
  const dataDir = env.FLUJO_DATA_DIR?.trim()
    ? path.resolve(env.FLUJO_DATA_DIR)
    : path.resolve(cwd);
  const settingsFile = path.join(dataDir, 'db', 'speech_settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return settings?.network?.allowAllMcpAppContent === true;
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      console.warn(`[FLUJO] Could not read allow-all MCP app setting from ${settingsFile}:`, error);
    }
  }
  return false;
}

function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split('%')[0];
  const ipv4 = normalized.split('.');
  if (ipv4.length === 4 && ipv4.every((part) => /^\d{1,3}$/.test(part))) {
    const [a, b] = ipv4.map(Number);
    return a === 10
      || a === 127
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254);
  }
  return normalized === '::1'
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab]/.test(normalized);
}

export function discoverLocalHostnames() {
  const names = new Set(['localhost', os.hostname().toLowerCase()]);
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.address && isPrivateAddress(address.address)) {
        names.add(address.address.toLowerCase().split('%')[0]);
      }
    }
  }
  return [...names].filter(Boolean).join(',');
}

export function applyExposureRuntimeEnv(env, cwd = process.cwd()) {
  const next = { ...env };
  const explicit = normalizedMode(env[EXPOSURE_MODE_ENV]);
  const persisted = explicit ? undefined : readPersistedExposureMode(env, cwd);
  const legacy = explicit || persisted ? undefined : legacyMode(env);
  next[EXPOSURE_MODE_ENV] = explicit || persisted || legacy || 'localhost';
  next.FLUJO_EXPOSURE_MODE_SOURCE = explicit
    ? 'runtime'
    : persisted
      ? 'settings'
      : legacy
        ? 'legacy'
        : 'default';
  next.FLUJO_RUNTIME_LOCAL_HOSTS = discoverLocalHostnames();
  // Escape hatch: propagate the persisted allow-all setting to the sandbox and
  // browser gateway as a single immutable env value. Explicit env always wins.
  if (env[SANDBOX_ALLOW_ALL_ENV] === undefined) {
    next[SANDBOX_ALLOW_ALL_ENV] = readPersistedAllowAll(env, cwd) ? '1' : '0';
  }
  return next;
}

function hasHostnameArg(args) {
  return args.some((arg, index) =>
    arg === '--hostname'
    || arg === '-H'
    || arg.startsWith('--hostname=')
    || (index > 0 && (args[index - 1] === '--hostname' || args[index - 1] === '-H')),
  );
}

export function withExposureHostname(args, env) {
  if (hasHostnameArg(args) || env.FLUJO_CONTAINER) return [...args];
  const hostname = env[EXPOSURE_MODE_ENV] === 'localhost' ? '127.0.0.1' : '0.0.0.0';
  return [...args, '-H', hostname];
}
