import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { getWorkspaceDataDir } from '@/utils/workspace';

const AUTH_FILE = 'auth.json';
const CONFIG_FILE = 'config.toml';

export interface CodexRuntimeEnvironment {
  home: string;
  /** Stable neutral cwd for Codex; user files remain reachable only through FLUJO tools. */
  workingDirectory: string;
  env: Record<string, string>;
}

function userCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured || path.join(os.homedir(), '.codex');
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
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  const workingDirectory = path.join(home, 'workspace');
  await fs.mkdir(workingDirectory, { recursive: true, mode: 0o700 });

  await fs.writeFile(
    path.join(home, CONFIG_FILE),
    '# Managed by FLUJO. Codex runtime settings are supplied per invocation.\n',
    { encoding: 'utf8', mode: 0o600 },
  );

  if (useUserLogin) {
    const source = path.join(userCodexHome(), AUTH_FILE);
    const destination = path.join(home, AUTH_FILE);
    if (path.resolve(source) !== path.resolve(destination)) {
      try {
        await fs.copyFile(source, destination);
        await fs.chmod(destination, 0o600).catch(() => undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Avoid silently retaining credentials after the operator logs out.
          await fs.rm(destination, { force: true }).catch(() => undefined);
        } else {
          throw error;
        }
      }
    }
  }

  return {
    home,
    workingDirectory,
    env: {
      ...inheritedEnvironment(),
      CODEX_HOME: home,
    },
  };
}
