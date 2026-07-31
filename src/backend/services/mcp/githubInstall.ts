import path from 'path';
import fs from 'fs/promises';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import simpleGit from 'simple-git';
import { getDataDir } from '@/utils/paths';
import { isSafeRepoUrl, isSafeBranchName } from '@/utils/git/validation';
import { killProcessTree } from '@/utils/process/killProcessTree';
import { mcpService } from '@/backend/services/mcp';
import type { EnvVarValue, MCPServerConfig, MCPServerSource } from '@/shared/types/mcp';
import type { McpArgTemplate } from '@/shared/types/package';

export interface GithubInstallInput {
  name: string;
  repositoryUrl: string;
  env: Record<string, string>;
  ref?: string;
  subdirectory?: string;
  installCommand?: string;
  buildCommand?: string;
  secretEnvNames?: string[];
  argTemplates?: McpArgTemplate[];
  disabled?: boolean;
  autoApprove?: string[];
  folder?: string;
}

export interface GithubInstallResult {
  installed: boolean;
  serverName?: string;
  alreadyExisted?: boolean;
  error?: string;
}


const INSTALL_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.FLUJO_GITHUB_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000,
);
const OUTPUT_TAIL_LIMIT = 8_000;

interface PackageJson {
  main?: string;
  bin?: string | Record<string, string>;
  packageManager?: string;
  scripts?: Record<string, string>;
}

interface ParsedRepositoryReference {
  repositoryUrl: string;
  ref?: string;
}
function normalizedRemoteUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

/**
 * Accept current package refs (repository URL + separate ref) and the legacy
 * owner/repo[@ref] or URL@ref form emitted by older package exporters.
 */
export function parseGithubRepositoryReference(
  value: string,
  explicitRef?: string,
): ParsedRepositoryReference {
  let repositoryUrl = value.trim();
  let ref = explicitRef?.trim() || undefined;

  if (!ref) {
    const lastAt = repositoryUrl.lastIndexOf('@');
    const lastPathSeparator = Math.max(
      repositoryUrl.lastIndexOf('/'),
      repositoryUrl.lastIndexOf(':'),
    );
    if (lastAt > lastPathSeparator) {
      ref = repositoryUrl.slice(lastAt + 1);
      repositoryUrl = repositoryUrl.slice(0, lastAt);
    }
  }

  if (!repositoryUrl.includes('://') && !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(repositoryUrl)) {
    const shorthand = repositoryUrl.match(/^([^/\s]+)\/([^/\s]+)$/);
    if (shorthand) repositoryUrl = `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  }

  if (!isSafeRepoUrl(repositoryUrl)) {
    throw new Error('Unsafe or unsupported GitHub repository URL');
  }
  if (ref && !isSafeBranchName(ref)) {
    throw new Error('Unsafe or unsupported Git ref');
  }
  return { repositoryUrl, ...(ref ? { ref } : {}) };
}

function repoSlug(repositoryUrl: string, ref?: string): string {
  const withoutSuffix = repositoryUrl.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const pathPart = withoutSuffix.includes('://')
    ? new URL(withoutSuffix).pathname
    : withoutSuffix.slice(withoutSuffix.indexOf(':') + 1);
  const readable = pathPart
    .split(/[\\/]/)
    .filter(Boolean)
    .slice(-2)
    .join('-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    || 'repository';
  const digest = createHash('sha256')
    .update(`${normalizedRemoteUrl(repositoryUrl)}\0${ref ?? ''}`)
    .digest('hex')
    .slice(0, 10);
  return `${readable}-${digest}`;
}

function redact(message: string, secretValues: string[]): string {
  return secretValues.reduce(
    (safe, value) => value ? safe.split(value).join('[REDACTED]') : safe,
    message,
  );
}

function run(
  command: string,
  cwd: string,
  secretValues: string[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = '';
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(error);
      return;
    }

    const append = (chunk: unknown) => {
      output = `${output}${String(chunk)}`.slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const cancelEscalation = killProcessTree(child);
      child.once('close', cancelEscalation);
      reject(new Error(`${command} timed out after ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = output.trim();
      finish(new Error(redact(
        `${command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
        secretValues,
      )));
    });
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkingDirectory(repoPath: string, subdirectory?: string): Promise<string> {
  const realRepoPath = await fs.realpath(repoPath);
  if (!subdirectory || subdirectory.trim() === '.') return realRepoPath;

  const portable = subdirectory.trim().replace(/\\/g, '/');
  if (
    path.isAbsolute(portable) ||
    portable.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('GitHub server subdirectory must stay inside the repository');
  }

  const realWorkingDirectory = await fs.realpath(path.resolve(realRepoPath, portable));
  const relative = path.relative(realRepoPath, realWorkingDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('GitHub server subdirectory resolves outside the repository');
  }
  return realWorkingDirectory;
}

async function detectPackageManager(packageJson: PackageJson, cwd: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  const declared = packageJson.packageManager?.split('@')[0];
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
    return declared;
  }
  if (await pathExists(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(path.join(cwd, 'yarn.lock'))) return 'yarn';
  if (
    await pathExists(path.join(cwd, 'bun.lock')) ||
    await pathExists(path.join(cwd, 'bun.lockb'))
  ) return 'bun';
  return 'npm';
}

function defaultInstallCommand(manager: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
  return manager === 'npm' ? 'npm install --include=dev' : `${manager} install`;
}

function defaultBuildCommand(
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun',
  scripts: Record<string, string> = {},
): string {
  const script = ['build', 'compile', 'dist'].find((name) => Boolean(scripts[name]));
  if (!script) return '';
  if (manager === 'yarn') return `yarn ${script}`;
  return `${manager} run ${script}`;
}

function checkedCommand(command: string | undefined, label: string): string | undefined {
  if (command === undefined) return undefined;
  const trimmed = command.trim();
  if (!trimmed) return '';
  if (trimmed.length > 4096 || /[\0]/.test(trimmed)) {
    throw new Error(`Invalid GitHub ${label} command`);
  }
  return trimmed;
}

function packageEntry(packageJson: PackageJson): string {
  const binEntry =
    typeof packageJson.bin === 'string'
      ? packageJson.bin
      : packageJson.bin
        ? Object.values(packageJson.bin)[0]
        : undefined;
  if (binEntry) return binEntry;
  if (packageJson.main) return packageJson.main;

  const start = packageJson.scripts?.start;
  const nodeEntry = start?.match(/(?:^|\s)node\s+["']?([^"'\s]+)["']?/);
  return nodeEntry?.[1] || 'dist/index.js';
}

function applyArgumentTemplates(entry: string, templates: McpArgTemplate[] = []): string[] {
  const args = [entry];
  for (const template of [...templates].sort((a, b) => a.index - b.index)) {
    if (template.index > args.length) {
      throw new Error(`argument template index ${template.index} cannot be reconstructed`);
    }
    if (template.index < args.length && args[template.index] !== template.value) {
      throw new Error(`argument template index ${template.index} cannot replace a static argument`);
    }
    args[template.index] = template.value;
  }
  return args;
}

async function prepareRepository(
  repositoryUrl: string,
  ref: string | undefined,
  repoPath: string,
): Promise<void> {
  const alreadyCloned = await pathExists(path.join(repoPath, '.git'));
  if (!alreadyCloned) {
    let contents: string[] = [];
    try {
      contents = await fs.readdir(repoPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (contents.length > 0) {
      throw new Error(`Refusing to clone into non-empty directory: ${repoPath}`);
    }
    await simpleGit().clone(repositoryUrl, repoPath, { '--depth': 1 });
  }

  const git = simpleGit({ baseDir: repoPath, timeout: { block: 120_000 } });
  const remoteUrl = String(await git.remote(['get-url', 'origin'])).trim();
  if (normalizedRemoteUrl(remoteUrl) !== normalizedRemoteUrl(repositoryUrl)) {
    throw new Error('Existing clone origin does not match the requested GitHub repository');
  }

  const status = await git.status();
  if (!status.isClean()) {
    throw new Error('Existing GitHub server clone has local changes; refusing to overwrite them');
  }

  if (alreadyCloned || ref) {
    await git.raw(['fetch', '--depth=1', 'origin', ref ?? 'HEAD']);
    await git.raw(['checkout', '--detach', 'FETCH_HEAD']);
  }
}

/**
 * Reproduce a reviewed GitHub server installation. The package's commands are
 * shown during consent; older manifests fall back to commands detected from
 * package.json. Package secrets are persisted in the server config but are
 * deliberately never exposed to the repository's install/build processes.
 */
export async function installGithubServer(input: GithubInstallInput): Promise<GithubInstallResult> {
  let parsed: ParsedRepositoryReference;
  try {
    parsed = parseGithubRepositoryReference(input.repositoryUrl, input.ref);
  } catch (error) {
    return { installed: false, error: error instanceof Error ? error.message : String(error) };
  }

  const secretNames = new Set(input.secretEnvNames ?? []);
  const secretValues = [...secretNames]
    .map((name) => input.env[name])
    .filter((value): value is string => Boolean(value));
  const cloneRoot = path.join(getDataDir(), 'mcp-servers');
  const repoPath = path.join(cloneRoot, repoSlug(parsed.repositoryUrl, parsed.ref));

  try {
    await fs.mkdir(cloneRoot, { recursive: true });
    await prepareRepository(parsed.repositoryUrl, parsed.ref, repoPath);
    const workingDirectory = await resolveWorkingDirectory(repoPath, input.subdirectory);

    const packageJsonPath = path.join(workingDirectory, 'package.json');
    if (!await pathExists(packageJsonPath)) {
      throw new Error(
        `GitHub package install currently requires package.json in ${input.subdirectory || 'the repository root'}`,
      );
    }
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as PackageJson;
    const manager = await detectPackageManager(packageJson, workingDirectory);
    const installCommand =
      checkedCommand(input.installCommand, 'install') ?? defaultInstallCommand(manager);
    const buildCommand =
      checkedCommand(input.buildCommand, 'build') ??
      defaultBuildCommand(manager, packageJson.scripts);

    if (installCommand) await run(installCommand, workingDirectory, secretValues);
    if (buildCommand) await run(buildCommand, workingDirectory, secretValues);

    const entry = packageEntry(packageJson);
    const entryPath = path.resolve(workingDirectory, entry);
    const relativeEntry = path.relative(workingDirectory, entryPath);
    if (relativeEntry.startsWith('..') || path.isAbsolute(relativeEntry)) {
      throw new Error('GitHub server entry point resolves outside its working directory');
    }
    if (!await pathExists(entryPath)) {
      throw new Error(`GitHub server entry point was not produced by the build: ${entry}`);
    }

    const source: MCPServerSource = {
      type: 'github',
      repositoryUrl: parsed.repositoryUrl,
      ...(parsed.ref ? { ref: parsed.ref } : {}),
      ...(input.subdirectory ? { subdirectory: input.subdirectory } : {}),
    };
    const persistedEnv: Record<string, EnvVarValue> = Object.fromEntries(
      Object.entries(input.env).map(([name, value]) => [
        name,
        secretNames.has(name) ? { value, metadata: { isSecret: true } } : value,
      ]),
    );
    const config = {
      name: input.name,
      transport: 'stdio',
      command: 'node',
      args: applyArgumentTemplates(entry, input.argTemplates),
      rootPath: workingDirectory,
      env: persistedEnv,
      disabled: input.disabled ?? false,
      autoApprove: input.autoApprove ?? [],
      folder: input.folder,
      source,
      _installCommand: installCommand,
      _buildCommand: buildCommand,
    } as unknown as Partial<MCPServerConfig>;
    const saved = await mcpService.updateServerConfig(input.name, config);
    if (!Array.isArray(saved) && saved && 'success' in saved && saved.success === false) {
      return { installed: false, error: saved.error ?? 'Saving the GitHub server failed' };
    }
    return { installed: true, serverName: input.name };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { installed: false, error: redact(message, secretValues) };
  }
}
