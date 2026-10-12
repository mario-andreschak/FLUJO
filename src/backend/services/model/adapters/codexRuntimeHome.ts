import path from 'path';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { synchronizeCodexAuth } from './codexAuth';
import { admitCodexDirectory, writeCodexRuntimeFile } from './codexRuntimeFiles';

const CONFIG_FILE = 'config.toml';

export interface CodexRuntimeEnvironment {
  home: string;
  /** Stable neutral cwd for Codex; user files remain reachable only through FLUJO tools. */
  workingDirectory: string;
  env: Record<string, string>;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Prepare the private Codex home used by FLUJO's SDK subprocesses.
 *
 * The Codex SDK otherwise inherits ~/.codex/config.toml, including personal
 * MCP servers, plugins, skills, and UI preferences. FLUJO supplies its own
 * runtime policy through SDK config overrides, so the child gets a managed,
 * persistent home instead. Persistence keeps Codex session files available to
 * the adapter's per-(conversation, node) resumeThread registry.
 *
 * ChatGPT-plan authentication still comes from the operator's normal Codex
 * login. Only auth.json is synchronized; config.toml is deliberately replaced
 * with an empty managed file so personal runtime capabilities cannot leak in.
 */
export async function prepareCodexRuntimeEnvironment(
  useUserLogin: boolean,
): Promise<CodexRuntimeEnvironment> {
  // Per workspace (#406): the Codex runtime home holds auth.json + config.toml,
  // which are workspace-owned credentials/settings, not installation-wide ones.
  const home = path.join(getWorkspaceDataDir(), 'db', 'codex-runtime');
  const guard = await admitCodexDirectory(home, true);
  const workingDirectory = path.join(home, 'workspace');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const configHome = path.join(home, '.config');
  const cache = path.join(home, '.cache');
  const data = path.join(home, '.local', 'share');
  const state = path.join(home, '.local', 'state');
  const runtime = path.join(home, '.runtime');
  const temp = path.join(home, 'tmp');
  await Promise.all(
    [workingDirectory, appData, localAppData, configHome, cache, data, state, runtime, temp]
      .map(directory => admitCodexDirectory(directory, true)),
  );

  await writeCodexRuntimeFile(home,
    path.join(home, CONFIG_FILE),
    '# Managed by FLUJO. Codex runtime settings are supplied per invocation.\ncli_auth_credentials_store = "file"\n',
    guard,
  );

  if (useUserLogin) {
    await guard();
    await synchronizeCodexAuth(home);
  }
  await guard();

  const env: Record<string, string> = {
    ...inheritedEnvironment(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: configHome,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CODEX_HOME: home,
  };
  if (useUserLogin) {
    // Subscription selection must not silently become API-billed execution.
    delete env.CODEX_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  if (process.platform === 'win32') {
    const parsed = path.parse(home);
    env.HOMEDRIVE = parsed.root.replace(/[\\/]$/, '');
    env.HOMEPATH = home.slice(parsed.root.length - 1);
  }

  return {
    home,
    workingDirectory,
    env,
  };
}
