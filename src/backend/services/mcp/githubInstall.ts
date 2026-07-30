import path from 'path';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import simpleGit from 'simple-git';
import { getDataDir } from '@/utils/paths';
import { isSafeRepoUrl } from '@/utils/git/validation';
import { mcpService } from '@/backend/services/mcp';
import type { MCPServerConfig, MCPServerSource } from '@/shared/types/mcp';

export interface GithubInstallInput {
  name: string;
  repositoryUrl: string;
  env: Record<string, string>;
  folder?: string;
}

export interface GithubInstallResult {
  installed: boolean;
  serverName?: string;
  alreadyExisted?: boolean;
  error?: string;
}

function repoSlug(repositoryUrl: string): string {
  return repositoryUrl
    .replace(/\.git$/i, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()!
    .replace(/[^A-Za-z0-9._-]/g, '-');
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * Backend counterpart of the GitHub Server tab's common one-click path.
 * Commands are derived from the cloned package.json, never accepted from the
 * package manifest, so a manifest cannot substitute an arbitrary executable.
 */
export async function installGithubServer(input: GithubInstallInput): Promise<GithubInstallResult> {
  if (!isSafeRepoUrl(input.repositoryUrl)) {
    return { installed: false, error: 'Unsafe or unsupported GitHub repository URL' };
  }
  const existing = await mcpService.loadServerConfigs();
  if (Array.isArray(existing) && existing.some((server: MCPServerConfig) => server.name === input.name)) {
    return { installed: true, alreadyExisted: true, serverName: input.name };
  }

  const cloneRoot = path.join(getDataDir(), 'mcp-servers');
  const repoPath = path.join(cloneRoot, repoSlug(input.repositoryUrl));
  try {
    await fs.mkdir(cloneRoot, { recursive: true });
    try {
      await fs.access(path.join(repoPath, '.git'));
    } catch {
      await simpleGit().clone(input.repositoryUrl, repoPath, { '--depth': 1 });
    }

    const packageJson = JSON.parse(await fs.readFile(path.join(repoPath, 'package.json'), 'utf8')) as {
      main?: string;
      bin?: string | Record<string, string>;
      scripts?: Record<string, string>;
    };
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await run(npm, ['install', '--include=dev'], repoPath);
    if (packageJson.scripts?.build) await run(npm, ['run', 'build'], repoPath);

    const binEntry =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin
          ? Object.values(packageJson.bin)[0]
          : undefined;
    const entry = packageJson.main || binEntry || 'dist/index.js';
    const source: MCPServerSource = { type: 'github', repositoryUrl: input.repositoryUrl };
    const config: Partial<MCPServerConfig> = {
      name: input.name,
      transport: 'stdio',
      command: 'node',
      args: [entry],
      rootPath: repoPath,
      env: input.env,
      disabled: false,
      folder: input.folder,
      source,
      _installCommand: 'npm install --include=dev',
      _buildCommand: packageJson.scripts?.build ? 'npm run build' : '',
    };
    const saved = await mcpService.updateServerConfig(input.name, config);
    if (!Array.isArray(saved) && saved && 'success' in saved && saved.success === false) {
      return { installed: false, error: saved.error ?? 'Saving the GitHub server failed' };
    }
    return { installed: true, serverName: input.name };
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }
}
