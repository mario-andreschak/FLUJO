import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DiagnosticLogger = {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
};

function diagnostic(level: string, scope: string, message: string, detail?: unknown): void {
  const suffix = detail === undefined
    ? ''
    : ` ${detail instanceof Error ? detail.stack ?? detail.message : safeStringify(detail)}`;
  process.stderr.write(`[${scope}] ${level}: ${message}${suffix}\n`);
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function createLogger(scope: string): DiagnosticLogger {
  return {
    debug: (message, detail) => {
      if (process.env.FLUJO_MCP_DEBUG === '1') diagnostic('debug', scope, message, detail);
    },
    info: (message, detail) => diagnostic('info', scope, message, detail),
    warn: (message, detail) => diagnostic('warn', scope, message, detail),
    error: (message, detail) => diagnostic('error', scope, message, detail),
  };
}

export function getDataDir(): string {
  return path.resolve(process.env.FLUJO_DATA_DIR?.trim() || process.cwd());
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function envRoots(envVarNames: string | string[]): string[] | null {
  const names = Array.isArray(envVarNames) ? envVarNames : [envVarNames];
  for (const name of names) {
    const raw = process.env[name];
    if (!raw?.trim()) continue;
    const roots = raw.split(path.delimiter).map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
    if (roots.length > 0) return roots;
  }
  return null;
}

export type RootsProvider = () => Promise<Array<{ uri: string }>>;
let rootsProvider: RootsProvider | undefined;

export function configureRootsProvider(provider: RootsProvider | undefined): void {
  rootsProvider = provider;
}

async function clientRoots(dataDir: string): Promise<string[]> {
  if (!rootsProvider) return [];
  try {
    const roots = await rootsProvider();
    const resolved: string[] = [];
    for (const root of roots) {
      const raw = root?.uri?.trim();
      if (!raw) continue;
      if (raw.startsWith('file://')) {
        try {
          resolved.push(path.resolve(fileURLToPath(raw)));
        } catch {
          // Ignore malformed roots supplied by the client.
        }
      } else {
        resolved.push(path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw));
      }
    }
    return Array.from(new Set(resolved));
  } catch (error) {
    createLogger('mcp-shared/roots').debug('Client does not expose roots/list', error);
    return [];
  }
}

export async function loadEffectiveRoots(
  _serverName: string,
  envVarNames: string | string[],
  _callerNodeId?: string,
): Promise<string[]> {
  const dataDir = getDataDir();
  const ceiling = envRoots(envVarNames);
  const configured = await clientRoots(dataDir);
  if (!ceiling) return configured.length > 0 ? configured : [dataDir];
  const confined = configured.filter((candidate) => ceiling.some((root) => isInside(root, candidate)));
  return confined.length > 0 ? confined : ceiling;
}

export function killProcessTree(child: ChildProcess, graceMs = 2000): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => undefined;
  if (process.platform === 'win32') {
    try {
      // Wait for taskkill itself so the tree-termination request is complete.
      // Node may publish the child's close event later; callers that must
      // synchronize observable liveness use killProcessTreeAndWait below.
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: Math.max(graceMs, 5_000),
        windowsHide: true,
      });
    } catch {
      // The target is already gone or taskkill could not be started.
    }
    return () => undefined;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // The group is already gone.
  }
  const escalation = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }, graceMs);
  escalation.unref?.();
  return () => clearTimeout(escalation);
}

export interface ProcessTreeTerminationResult {
  pid?: number;
  /** True only after the ChildProcess close event has been observed. */
  exited: boolean;
  durationMs: number;
}

/**
 * Terminate a process tree and wait for Node to observe the tracked child as
 * closed. On Windows, synchronous taskkill completion is not sufficient: the
 * child close event (and inherited stdio handle release) can arrive later under
 * load. Subscribe before requesting termination so that transition cannot be
 * missed, then bound the final observation wait.
 */
export async function killProcessTreeAndWait(
  child: ChildProcess,
  graceMs = 2_000,
  finalWaitMs = 5_000,
): Promise<ProcessTreeTerminationResult> {
  const startedAt = Date.now();
  const pid = child.pid;
  if (pid === undefined) {
    return { pid, exited: false, durationMs: Date.now() - startedAt };
  }

  let closeObserved = false;
  let resolveClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = () => {
    closeObserved = true;
    resolveClose?.();
  };
  child.once('close', onClose);

  let cancelEscalation: () => void = () => undefined;
  try {
    cancelEscalation = killProcessTree(child, graceMs);
  } catch {
    child.removeListener('close', onClose);
    return { pid, exited: false, durationMs: Date.now() - startedAt };
  }

  // Windows taskkill already force-terminates the tree. POSIX may need the
  // grace interval before killProcessTree escalates from SIGTERM to SIGKILL.
  const observationMs = Math.max(0, finalWaitMs)
    + (process.platform === 'win32' ? 0 : Math.max(0, graceMs));
  let timeout: NodeJS.Timeout | undefined;
  if (!closeObserved) {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, observationMs);
      }),
    ]);
  }
  if (timeout) clearTimeout(timeout);
  if (!closeObserved) child.removeListener('close', onClose);
  cancelEscalation();

  return { pid, exited: closeObserved, durationMs: Date.now() - startedAt };
}
