import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

type ShellProbe = {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

function getEnvCaseInsensitive(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

function firstExistingFile(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // Keep looking. Missing executables must remain visible to the tests.
    }
  }
  return null;
}

function findExecutableOnPath(name: string): string | null {
  const extensions = process.platform === 'win32' ? ['.COM', '.EXE', '.BAT', '.CMD'] : [''];
  const directories = (getEnvCaseInsensitive('PATH') ?? '')
    .split(path.delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  return firstExistingFile(directories.flatMap((directory) =>
    extensions.map((extension) => path.join(directory, `${name}${extension}`))
  ));
}

function preferredShellProbe(): ShellProbe | null {
  if (process.platform !== 'win32') {
    return {
      executable: '/bin/sh',
      args: ['-c', 'exit 0'],
    };
  }

  const localAppData = getEnvCaseInsensitive('LocalAppData');
  const programFiles = getEnvCaseInsensitive('ProgramFiles');
  const pwsh = firstExistingFile([
    findExecutableOnPath('pwsh'),
    localAppData ? path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe') : undefined,
    programFiles ? path.join(programFiles, 'PowerShell', '7', 'pwsh.exe') : undefined,
    programFiles ? path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe') : undefined,
  ]);
  if (pwsh) {
    return {
      executable: pwsh,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
    };
  }

  const systemRoot = getEnvCaseInsensitive('SystemRoot') ?? getEnvCaseInsensitive('windir');
  const windowsPowerShell = firstExistingFile([
    findExecutableOnPath('powershell'),
    systemRoot
      ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : undefined,
  ]);
  if (windowsPowerShell) {
    return {
      executable: windowsPowerShell,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'],
    };
  }

  const cmd = firstExistingFile([
    findExecutableOnPath('cmd'),
    systemRoot ? path.join(systemRoot, 'System32', 'cmd.exe') : undefined,
  ]);
  return cmd
    ? {
        executable: cmd,
        args: ['/d', '/s', '/c', 'exit 0'],
        windowsVerbatimArguments: true,
      }
    : null;
}

function actualSpawn(
  executable: string,
  args: string[],
  options: SpawnOptions,
): ChildProcess {
  const childProcess = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  return childProcess.spawn(executable, args, options);
}

async function isDeniedByPolicy(probe: ShellProbe): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = actualSpawn(probe.executable, probe.args, {
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: probe.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve((error as NodeJS.ErrnoException).code === 'EPERM');
      return;
    }

    let settled = false;
    const finish = (denied: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      resolve(denied);
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      finish(error.code === 'EPERM');
    };
    const onClose = (): void => {
      finish(false);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } finally {
        finish(false);
      }
    }, 5_000);

    child.once('error', onError);
    child.once('close', onClose);
  });
}

export async function realShellUnavailableByPolicy(): Promise<boolean> {
  if (await isDeniedByPolicy({ executable: process.execPath, args: ['-e', ''] })) return true;
  const shell = preferredShellProbe();
  return shell ? isDeniedByPolicy(shell) : false;
}

class RealShellPolicyError extends Error {
  constructor() {
    super('Real shell launch denied by host policy (EPERM)');
    this.name = 'RealShellPolicyError';
  }
}

function isEpermLaunchMessage(message: string): boolean {
  return /^(?:Failed to start command|Command failed to start) \([^)]*\): .*\bEPERM\b/i.test(message);
}

function isEpermCallToolResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as {
    isError?: unknown;
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
  if (candidate.isError !== true) return false;
  const first = candidate.content?.[0];
  if (first?.type !== 'text' || typeof first.text !== 'string') return false;
  try {
    const payload = JSON.parse(first.text) as { error?: unknown };
    return typeof payload.error === 'string' && isEpermLaunchMessage(payload.error);
  } catch {
    return false;
  }
}

/**
 * Preserve the production CallToolResult contract, except for an exact async
 * shell-launch EPERM which the real-shell test wrapper may suppress.
 */
export async function requireRealShellResult<T>(result: Promise<T>): Promise<T> {
  const resolved = await result;
  if (isEpermCallToolResult(resolved)) throw new RealShellPolicyError();
  return resolved;
}

type RealShellTestBody = () => unknown | Promise<unknown>;

/**
 * Some managed test hosts forbid asynchronous shell child processes while
 * still allowing Jest and synchronous child probes to run. Suppress only
 * real-shell integration assertions after observing EPERM from the same async
 * launch path. Any other launch failure remains visible in the test body.
 */
export function itWithRealShell(
  name: string,
  body: RealShellTestBody,
  timeout?: number,
): ReturnType<typeof it> {
  return it(name, async () => {
    if (await realShellUnavailableByPolicy()) return;
    try {
      await body();
    } catch (error) {
      if (error instanceof RealShellPolicyError) return;
      throw error;
    }
  }, timeout);
}
