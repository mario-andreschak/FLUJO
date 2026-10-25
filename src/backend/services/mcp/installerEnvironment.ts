import { withNpmDevDependencies } from '@/utils/mcp/npmEnvironment';

type InstallerBaseEnvironment = Readonly<Record<string, string | undefined>>;
type InstallerProfileSelection = { isolation?: unknown; trustedHost?: unknown };

export class McpHostInstallationError extends Error {
  constructor() {
    super('Protected MCP profiles require externally materialized reviewed source or a preinstalled immutable image. Host install/build is not supported by runtime execution grants.');
    this.name = 'McpHostInstallationError';
  }
}

/** Runtime profile consent never authorizes repository scripts on the host. */
export function assertMcpHostInstallationAllowed(
  selection?: InstallerProfileSelection,
  env: InstallerBaseEnvironment = process.env,
): void {
  if (
    ['FLUJO_OWNER_AUTH_FILE', 'FLUJO_MCP_TRUSTED_HOST_FILE', 'FLUJO_MCP_ISOLATION_FILE']
      .some(name => env[name] !== undefined)
    || env.FLUJO_WORKER_MODE === '1'
    || selection?.isolation !== undefined
    || selection?.trustedHost !== undefined
  ) {
    throw new McpHostInstallationError();
  }
}

// Keep this list explicit: credentials and controls such as NODE_OPTIONS,
// BASH_ENV, GIT_CONFIG_* and arbitrary npm_config_* must not reach install scripts.
const INSTALLER_ENVIRONMENT_NAMES = [
  'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMP', 'TEMP', 'TMPDIR',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'OS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432',
  // Native npm dependencies may build from a Windows developer shell.
  'INCLUDE', 'LIB', 'LIBPATH', 'VCINSTALLDIR', 'VCToolsInstallDir', 'VSINSTALLDIR',
  'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'UCRTVersion',
] as const;

/**
 * Scope ambient environment access for trusted-host MCP install/build commands.
 * This is not an OS sandbox: the command retains host filesystem/network access,
 * including tool configuration under HOME. Runtime server credentials belong in
 * the eventual server config, never in this environment.
 */
export function createMcpInstallerEnvironment(
  baseEnv: InstallerBaseEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const canonicalNames = new Map<string, string>(INSTALLER_ENVIRONMENT_NAMES.map(name => [
    platform === 'win32' ? name.toUpperCase() : name,
    name,
  ]));
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  // Node sorts Windows keys and keeps one case-insensitive match. Canonicalize
  // those names so PATH and Path cannot produce a second environment entry.
  for (const key of Object.keys(baseEnv).sort()) {
    const canonicalName = canonicalNames.get(platform === 'win32' ? key.toUpperCase() : key);
    if (!canonicalName || Object.hasOwn(env, canonicalName)) continue;
    const value = baseEnv[key];
    if (value !== undefined) env[canonicalName] = value;
  }
  // A production FLUJO process must still install a repository's build tools.
  return withNpmDevDependencies(env);
}
