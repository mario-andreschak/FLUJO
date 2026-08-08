import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EXPOSURE_MODE_ENV = 'FLUJO_EXPOSURE_MODE';
export const EXPOSURE_MODES = new Set(['localhost', 'network', 'public']);
const WORKSPACE_LAYOUT_VERSION = 2;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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

function settingsCandidates(env, cwd) {
  const dataDir = env.FLUJO_DATA_DIR?.trim()
    ? path.resolve(env.FLUJO_DATA_DIR)
    : path.resolve(cwd);
  const workspaceSettings = path.join(
    dataDir,
    'workspaces',
    'default-workspace',
    'db',
    'speech_settings.json',
  );
  const legacySettings = path.join(dataDir, 'db', 'speech_settings.json');
  const markerFile = path.join(dataDir, 'workspaces', '.workspace-layout.json');

  try {
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    if (
      !marker
      || !Number.isInteger(marker.version)
      || marker.version < 1
      || marker.version > WORKSPACE_LAYOUT_VERSION
      || typeof marker.completedAt !== 'string'
      || !Number.isFinite(Date.parse(marker.completedAt))
      || marker.defaultWorkspace !== 'default-workspace'
      || !marker.subtrees
      || typeof marker.subtrees !== 'object'
      || (
        marker.version === WORKSPACE_LAYOUT_VERSION
        && (
          typeof marker.transactionId !== 'string'
          || !UUID_PATTERN.test(marker.transactionId)
          || typeof marker.manifestDigest !== 'string'
          || !SHA256_PATTERN.test(marker.manifestDigest)
        )
      )
    ) {
      console.warn(`[FLUJO] Workspace layout marker is invalid; using secure launcher defaults: ${markerFile}`);
      return { files: [], failClosed: true };
    }
    // A durable marker means the root db is retired. Never let an obsolete copy
    // silently re-enable network exposure if the workspace setting is absent.
    return { files: [workspaceSettings], failClosed: false };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // During the one upgrade launch before migration, prefer already-copied
      // workspace data and fall back to the legacy root only if it is absent.
      return { files: [workspaceSettings, legacySettings], failClosed: false };
    }
    console.warn(`[FLUJO] Could not validate workspace layout marker; using secure launcher defaults: ${markerFile}`, error);
    return { files: [], failClosed: true };
  }
}

function readPersistedSettings(env, cwd) {
  const candidates = settingsCandidates(env, cwd);
  for (const settingsFile of candidates.files) {
    try {
      return {
        settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
        failClosed: false,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      // A malformed/inaccessible preferred settings file is not permission to
      // consult a stale legacy copy that may broaden network access.
      console.warn(`[FLUJO] Could not read network settings from ${settingsFile}; using secure defaults:`, error);
      return { settings: undefined, failClosed: true };
    }
  }
  return { settings: undefined, failClosed: candidates.failClosed };
}

/**
 * Read the default workspace's persisted Settings value before Next starts.
 * Keeping this tiny reader in the launcher gives proxy/route bundles a single
 * immutable env value and avoids filesystem access in the request hot path.
 */
export function readPersistedExposureMode(env = process.env, cwd = process.cwd()) {
  return normalizedMode(readPersistedSettings(env, cwd).settings?.network?.exposure);
}

export function readExposureMode(env = process.env, cwd = process.cwd()) {
  const explicitRuntimeMode = normalizedMode(env[EXPOSURE_MODE_ENV]);
  if (explicitRuntimeMode) return explicitRuntimeMode;
  const persisted = readPersistedSettings(env, cwd);
  const persistedMode = normalizedMode(persisted.settings?.network?.exposure);
  if (persistedMode) return persistedMode;
  if (persisted.failClosed) return 'localhost';
  return legacyMode(env) || 'localhost';
}

/**
 * Read the persisted `network.allowAllMcpAppContent` escape hatch before Next
 * starts. Mirrors readPersistedExposureMode so the launcher can expose a single
 * immutable env value to the sandbox and browser gateway. Missing/false => false.
 */
export function readPersistedAllowAll(env = process.env, cwd = process.cwd()) {
  return readPersistedSettings(env, cwd).settings?.network?.allowAllMcpAppContent === true;
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
  const persistedState = readPersistedSettings(env, cwd);
  const persisted = explicit
    ? undefined
    : normalizedMode(persistedState.settings?.network?.exposure);
  const legacy = explicit || persisted || persistedState.failClosed ? undefined : legacyMode(env);
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
    next[SANDBOX_ALLOW_ALL_ENV] =
      persistedState.settings?.network?.allowAllMcpAppContent === true ? '1' : '0';
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
