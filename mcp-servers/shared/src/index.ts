import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
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

export function getHomeDir(): string {
  return path.resolve(process.env.FLUJO_HOME_DIR?.trim() || os.homedir());
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

function truthy(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

export const ALLOW_PROTECTED_PATHS_ENV = 'FLUJO_ALLOW_PROTECTED_PATHS';

export async function isProtectedPathsEnabled(): Promise<boolean> {
  if (truthy(process.env[ALLOW_PROTECTED_PATHS_ENV])) return false;
  return truthy(process.env.FLUJO_PROTECTED_PATHS_ENABLED);
}

function protectedPaths(): string[] {
  if (truthy(process.env[ALLOW_PROTECTED_PATHS_ENV])) return [];
  const home = getHomeDir();
  const underHome = (...segments: string[]) => path.resolve(home, ...segments);
  if (process.platform === 'win32') {
    return ['AppData', 'Downloads', 'Desktop', 'Documents', 'Pictures', 'Music', 'Videos', 'OneDrive'].map((item) => underHome(item));
  }
  if (process.platform === 'darwin') {
    return [
      'Downloads', 'Desktop', 'Documents', 'Pictures', 'Music', 'Movies',
      'Library/Mail', 'Library/Messages', 'Library/Safari', 'Library/Cookies',
      'Library/Calendars', 'Library/Application Support/AddressBook',
      'Library/Application Support/com.apple.TCC', 'Library/PersonalizationPortrait',
      'Library/Metadata/CoreSpotlight', 'Library/Suggestions',
    ].map((item) => underHome(item)).concat(['/.Spotlight-V100', '/.fseventsd', '/.DocumentRevisions-V100'].map((item) => path.resolve(item)));
  }
  return ['Documents', 'Downloads', 'Desktop', '.ssh', '.gnupg', '.aws', '.config'].map((item) => underHome(item));
}

export function isProtected(candidate: string): { denied: boolean; matchedRoot?: string } {
  const resolved = path.resolve(candidate);
  const exempt = [getDataDir(), os.tmpdir()].map((item) => path.resolve(item));
  if (exempt.some((root) => isInside(root, resolved))) return { denied: false };
  const matchedRoot = protectedPaths().find((root) => isInside(root, resolved));
  return matchedRoot ? { denied: true, matchedRoot } : { denied: false };
}

export function killProcessTree(child: ChildProcess, graceMs = 2000): () => void {
  const pid = child.pid;
  if (pid === undefined) return () => undefined;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F']);
      killer.on('error', () => undefined);
    } catch {
      // The target is already gone.
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
