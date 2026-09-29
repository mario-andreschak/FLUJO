import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { getWorkspaceDataDir } from '@/utils/workspace';

export const GEMINI_CLI_VERSION = '0.61.0';
export const GEMINI_LOGIN_INSTRUCTIONS = 'Enter a Gemini API key, or run `gemini` on the FLUJO server, choose Sign in with Google with a supported Code Assist Standard/Enterprise account, complete browser login, and configure its Google Cloud project. Personal Google accounts are no longer supported by Gemini CLI.';

// core: [] suppresses native registration, but also generates a deny-all policy
// above the MCP trusted/allowed settings. This explicit higher-priority allow
// admits only our bridge; FLUJO's handlers still enforce its approval policy.
export const GEMINI_FLUJO_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 900

[[rule]]
toolName = "*"
mcpName = "flujo"
decision = "allow"
priority = 950
`;

export interface GeminiCliRuntime {
  home: string;
  workingDirectory: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export function geminiCliSettings(model: string, maxTurns: number, apiKey: string, bridge?: { url: string; tools: string[] }): Record<string, unknown> {
  const authType = apiKey ? 'gemini-api-key' : 'oauth-personal';
  return {
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false, enableNotifications: false },
    tools: { core: [] },
    mcp: { allowed: bridge ? ['flujo'] : [], autoAllowInHeadless: false },
    ...(bridge ? { mcpServers: { flujo: { url: bridge.url, type: 'http', includeTools: bridge.tools } } } : {}),
    model: { name: model, maxSessionTurns: maxTurns },
    security: { disableYoloMode: true, auth: { selectedType: authType, enforcedType: authType } },
    admin: { extensions: { enabled: false }, skills: { enabled: false } },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    context: { fileName: [], includeDirectoryTree: false, loadMemoryFromIncludeDirectories: false },
    advanced: { ignoreLocalEnv: true },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
  };
}

async function assertNoForeignSystemPolicies(): Promise<void> {
  // The pinned CLI ignores the system-settings override for this directory.
  // Administrator policies override user policies, so fail closed rather than
  // inheriting an unknown admin allow rule or attempting to override it.
  const directory = process.platform === 'win32' ? 'C:\\ProgramData\\gemini-cli\\policies'
    : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/policies'
      : '/etc/gemini-cli/policies';
  try {
    const files = await fs.readdir(directory);
    if (files.some(file => file.endsWith('.toml'))) throw new Error('Foreign Gemini system policies are present. Run FLUJO on a host without system Gemini policies to preserve its flow tool isolation.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function copyLogin(sourceHome: string, destination: string): Promise<void> {
  const source = path.join(sourceHome, '.gemini', 'oauth_creds.json');
  let data: Buffer;
  try {
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    data = await fs.readFile(source);
    const after = await fs.lstat(source);
    if (stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error();
    const credentials: unknown = JSON.parse(data.toString('utf8'));
    if (!credentials || typeof credentials !== 'object'
      || typeof (credentials as { refresh_token?: unknown }).refresh_token !== 'string'
      || !(credentials as { refresh_token: string }).refresh_token.trim()) throw new Error();
  } catch {
    // Never expose JSON parser errors or the source cache in diagnostics.
    throw new Error(`A file-backed Gemini CLI Google login is required. ${GEMINI_LOGIN_INSTRUCTIONS}`);
  }
  await fs.writeFile(path.join(destination, 'oauth_creds.json'), data, { mode: 0o600 });
  const accounts = path.join(sourceHome, '.gemini', 'google_accounts.json');
  try {
    const stat = await fs.lstat(accounts);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024) {
      const bytes = await fs.readFile(accounts);
      JSON.parse(bytes.toString('utf8'));
      await fs.writeFile(path.join(destination, 'google_accounts.json'), bytes, { mode: 0o600 });
    }
  } catch { /* Account display metadata is optional; OAuth itself is authoritative. */ }
}

/** No host settings, instructions, hooks, extensions, or billing credentials enter the child. */
export async function prepareGeminiCliRuntime(options: {
  model: string;
  maxTurns: number;
  apiKey: string;
  bridge?: { url: string; tools: string[] };
}): Promise<GeminiCliRuntime> {
  await assertNoForeignSystemPolicies();
  const root = path.resolve(getWorkspaceDataDir(), 'db', 'gemini-cli-runtime');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const home = await fs.mkdtemp(path.join(root, 'invocation-'));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    // Only the exact mkdtemp child created above may be recursively removed.
    if (path.dirname(path.resolve(home)) !== root) throw new Error('Invalid Gemini runtime cleanup path.');
    await fs.rm(home, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    const geminiDir = path.join(home, '.gemini');
    const workingDirectory = path.join(home, 'workspace');
    const directories = {
      HOME: home, USERPROFILE: home, GEMINI_CLI_HOME: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_RUNTIME_DIR: path.join(home, '.runtime'),
      TMPDIR: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'),
    };
    await Promise.all([...new Set([...Object.values(directories), workingDirectory, geminiDir, path.join(geminiDir, 'policies')])]
      .map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await fs.writeFile(path.join(geminiDir, 'settings.json'), JSON.stringify(geminiCliSettings(options.model, options.maxTurns, options.apiKey, options.bridge)), { mode: 0o600 });
    // The trusted CLI always searches ancestor .gemini/.env files, even with
    // ignoreLocalEnv. This first private hit prevents loading any host env file.
    await fs.writeFile(path.join(geminiDir, '.env'), '', { mode: 0o600 });
    await fs.writeFile(path.join(geminiDir, 'policies', 'flujo.toml'), GEMINI_FLUJO_POLICY, { mode: 0o600 });
    const systemSettings = path.join(home, 'system-settings.json');
    const systemDefaults = path.join(home, 'system-defaults.json');
    await Promise.all([systemSettings, systemDefaults].map(file => fs.writeFile(file, '{}', { mode: 0o600 })));
    if (!options.apiKey) await copyLogin(process.env.GEMINI_CLI_HOME?.trim() || os.homedir(), geminiDir);
    const env = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/^(?:GOOGLE_|GEMINI_|GCLOUD_|CLOUDSDK_|NODE_OPTIONS$|NODE_PATH$|BROWSER$|NO_BROWSER$|OAUTH_CALLBACK_)/i.test(key)));
    // Licensed Code Assist OAuth accounts require explicit project routing.
    // These two ids select the project while enforced oauth-personal still
    // prevents a switch to inherited API-key, ADC, or Vertex authentication.
    if (!options.apiKey) {
      for (const key of ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID']) {
        if (process.env[key]?.trim()) env[key] = process.env[key]!;
      }
    }
    Object.assign(env, directories, {
      NO_BROWSER: 'true',
      GEMINI_CLI_NO_RELAUNCH: '1',
      // This cwd was freshly created by FLUJO and contains no host project
      // configuration. Headless CLI otherwise refuses its first invocation.
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettings,
      GEMINI_CLI_SYSTEM_DEFAULTS_PATH: systemDefaults,
    });
    if (options.apiKey) env.GEMINI_API_KEY = options.apiKey;
    if (process.platform === 'win32') {
      const parsed = path.parse(home);
      env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '');
      env.HOMEPATH = home.slice(parsed.root.length - 1);
    }
    return { home, workingDirectory, env, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
