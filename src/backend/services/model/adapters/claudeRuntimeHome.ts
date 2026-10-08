import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getWorkspaceDataDir } from '@/utils/workspace';

export interface ClaudeRuntimeEnvironment {
  /** Persistent Claude Code state (including resumable transcripts). */
  home: string;
  /** Stable neutral cwd so project-local Claude settings never come from FLUJO's install tree. */
  workingDirectory: string;
  env: Record<string, string>;
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Prepare the private Claude Code runtime used by FLUJO's Agent SDK adapter.
 *
 * The SDK persists session transcripts beneath `CLAUDE_CONFIG_DIR`; leaving it
 * unset writes them to the operator's shared `~/.claude` tree. It also makes a
 * host-level secure-storage directory visible on Windows. Both locations are
 * forced into the selected workspace so two workspaces can never resume or
 * mutate the same durable Claude runtime state.
 *
 * Authentication is supplied separately through `CLAUDE_CODE_OAUTH_TOKEN`, so
 * no personal Claude credentials or settings need to be copied into this home.
 */
export async function prepareClaudeRuntimeEnvironment(): Promise<ClaudeRuntimeEnvironment> {
  const home = path.join(getWorkspaceDataDir(), 'db', 'claude-runtime');
  await fs.mkdir(home, { recursive: true, mode: 0o700 });

  const workingDirectory = path.join(home, 'workspace');
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  const config = path.join(home, '.config');
  const cache = path.join(home, '.cache');
  const data = path.join(home, '.local', 'share');
  const state = path.join(home, '.local', 'state');
  const runtime = path.join(home, '.runtime');
  const temp = path.join(home, 'tmp');
  await Promise.all(
    [workingDirectory, appData, localAppData, config, cache, data, state, runtime, temp]
      .map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })),
  );

  const env: Record<string, string> = {
    ...inheritedEnvironment(),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    CLAUDE_CONFIG_DIR: home,
    // The Agent SDK otherwise prefers an inherited host-global secure-storage
    // override on Windows even when CLAUDE_CONFIG_DIR itself is isolated.
    CLAUDE_SECURESTORAGE_CONFIG_DIR: home,
  };
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
