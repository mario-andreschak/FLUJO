import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { readStableFile } from '@/utils/readStableFile';

export const ANTIGRAVITY_CLI_VERSION = '1.2.13';
export const ANTIGRAVITY_CLI_TIMEOUT_MS = 5 * 60 * 1000;
export const ANTIGRAVITY_LOGIN_INSTRUCTIONS = 'Run `flujo-agy` (or the standalone `agy`) as the FLUJO server or worker OS user and complete Google sign-in, then retry. Headless runs use that user’s native keyring or official local account cache. Alternatively, configure a Gemini API key in this connection.';
export const ANTIGRAVITY_NATIVE_DENIES = ['read_file(*)', 'write_file(*)', 'command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)'];

export interface AntigravityBridge {
  url: string;
  tools: string[];
  definitions?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
}
export interface AntigravityCliRuntime {
  home: string;
  workingDirectory: string;
  env: Record<string, string>;
  cleanup(): Promise<void>;
}

export function antigravityCliSettings(apiKey: string, bridge?: AntigravityBridge): Record<string, unknown> {
  return {
    ...(apiKey ? { modelProvider: 'gemini' } : {}),
    toolPermission: 'request-review', artifactReviewPolicy: 'asks-for-review',
    notifications: false, showTips: false, useG1Credits: false,
    permissions: { allow: (bridge?.tools ?? []).map(tool => `mcp(flujo/${tool})`), deny: ANTIGRAVITY_NATIVE_DENIES, ask: [] },
  };
}

export function antigravityCliAgent(bridge?: AntigravityBridge): string {
  // In the pinned runtime tools:[] excludes native executor components. MCP and
  // private task/resource housekeeping are injected separately by the harness;
  // naming call_mcp_tool in tools instead fails component resolution.
  return [
    '---', 'name: flujo', 'description: Execute only the tools selected for this FLUJO flow.',
    'mainAgent: true', 'subagent: false', 'inheritCustomizations: false', 'tools: []',
    'commandExecutionPolicy: off',
    ...(bridge ? ['mcpServers:', '  - name: flujo', `    serverUrl: ${JSON.stringify(bridge.url)}`] : ['mcpServers: []']),
    '---',
    'You are executing a FLUJO conversation. Follow the system instructions supplied in its conversation text.',
    'Only call the listed FLUJO tools through call_mcp_tool with ServerName="flujo", the exact ToolName, and Arguments matching its schema.',
    'Do not read files for tool discovery, use native tools, create subagents, or start background tasks. Tool approval is handled by FLUJO.',
    'Available FLUJO tools and their JSON schemas:',
    JSON.stringify(bridge?.definitions ?? (bridge?.tools ?? []).map(name => ({ name }))), '',
  ].join('\n');
}

async function seedAccountCache(destination: string): Promise<void> {
  const sourceHome = process.env.ANTIGRAVITY_CLI_HOME?.trim() || os.homedir();
  const source = path.join(sourceHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
  try {
    const bytes = await readStableFile(source, 64 * 1024);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    const token = parsed && typeof parsed === 'object' ? (parsed as { token?: unknown }).token : undefined;
    if (!token || typeof token !== 'object'
      || typeof (token as { access_token?: unknown }).access_token !== 'string'
      || !(token as { access_token: string }).access_token.trim()
      || typeof (token as { refresh_token?: unknown }).refresh_token !== 'string'
      || !(token as { refresh_token: string }).refresh_token.trim()) throw new Error();
    await fs.writeFile(path.join(destination, 'antigravity-oauth-token'), bytes, { mode: 0o600 });
  } catch (error) {
    // Other supported platforms may have only a native keyring profile. Do not
    // extract its secrets or infer absence from a missing file-backed cache.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`The local Antigravity account cache is invalid or unavailable. ${ANTIGRAVITY_LOGIN_INSTRUCTIONS}`);
  }
}

/** Only the official single account cache may enter otherwise private configuration. */
export async function prepareAntigravityCliRuntime(options: {
  model: string; maxTurns: number; apiKey: string; bridge?: AntigravityBridge;
}): Promise<AntigravityCliRuntime> {
  if (options.bridge) {
    const url = new URL(options.bridge.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || options.bridge.tools.some(tool => !/^[a-zA-Z0-9_-]{1,110}$/.test(tool))) {
      throw new Error('Invalid private Antigravity tool bridge configuration.');
    }
  }
  const root = path.resolve(getWorkspaceDataDir(), 'db', 'antigravity-cli-runtime');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const home = await fs.mkdtemp(path.join(root, 'invocation-'));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    if (path.dirname(path.resolve(home)) !== root) throw new Error('Invalid Antigravity runtime cleanup path.');
    await fs.rm(home, { recursive: true, force: true });
    cleaned = true;
  };
  try {
    const cliDir = path.join(home, '.gemini', 'antigravity-cli');
    const configDir = path.join(home, '.gemini', 'config');
    const workingDirectory = path.join(home, 'workspace');
    const agentsDir = path.join(workingDirectory, '.agents', 'agents');
    const gitDir = path.join(workingDirectory, '.git');
    const gitConfig = path.join(home, 'git-config');
    const directories = {
      HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_RUNTIME_DIR: path.join(home, '.runtime'),
      TMPDIR: path.join(home, 'tmp'), TMP: path.join(home, 'tmp'), TEMP: path.join(home, 'tmp'),
    };
    await Promise.all([...new Set([...Object.values(directories), cliDir, configDir, agentsDir, path.join(gitDir, 'objects'), path.join(gitDir, 'refs', 'heads')])]
      .map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    const mcpConfig = { mcpServers: options.bridge ? { flujo: { serverUrl: options.bridge.url } } : {} };
    await Promise.all([
      fs.writeFile(path.join(cliDir, 'settings.json'), JSON.stringify(antigravityCliSettings(options.apiKey, options.bridge)), { mode: 0o600 }),
      fs.writeFile(path.join(configDir, 'mcp_config.json'), '{"mcpServers":{}}', { mode: 0o600 }),
      fs.writeFile(path.join(workingDirectory, '.agents', 'mcp_config.json'), JSON.stringify(mcpConfig), { mode: 0o600 }),
      fs.writeFile(path.join(agentsDir, 'flujo.md'), antigravityCliAgent(options.bridge), { mode: 0o600 }),
      // Antigravity resolves MCP configuration from the repository root even
      // when agent customization inheritance is disabled. Own that boundary.
      fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/flujo\n', { mode: 0o600 }),
      fs.writeFile(path.join(gitDir, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\n', { mode: 0o600 }),
      fs.writeFile(gitConfig, '', { mode: 0o600 }),
    ]);
    if (!options.apiKey) await seedAccountCache(cliDir);
    const env = Object.fromEntries(Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .filter(([key]) => !/^(?:GOOGLE_|GEMINI_|GCLOUD_|CLOUDSDK_|AGY_|ANTIGRAVITY_|JETSKI_|GIT_|OPENAI_|ANTHROPIC_|AZURE_|VERTEX_|NODE_OPTIONS$|NODE_PATH$|BROWSER$|NO_BROWSER$|OAUTH_CALLBACK_)/i.test(key)));
    Object.assign(env, directories, { NO_BROWSER: 'true', AGY_CLI_DISABLE_AUTO_UPDATE: 'true', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitConfig, GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' });
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
