/**
 * Built-in `bash` MCP server (issue #170).
 *
 * Cross-platform shell execution (grep, curl, …) on Windows/macOS/Linux. It
 * reuses the proven spawn + timeout + process-tree-kill primitives from the
 * legacy `terminal` tool (which this server replaces) and adds:
 *   - shell selection: PowerShell-first on Windows and `/bin/sh` on POSIX, or
 *     explicit `pwsh` / `bash` / `cmd` (failing before execution when invalid
 *     or unavailable),
 *   - optional CRLF→LF normalization of captured output,
 *   - background execution: start → status/wait → write_stdin → kill,
 *   - orphan cleanup: every live session is force-killed on FLUJO process exit,
 *     and idle finished sessions are swept after a TTL.
 *
 * Confinement + env hygiene (issue #175): the `cwd` is confined to the same
 * effective roots as the built-in `filesystem` server (a HARD CEILING from
 * `FLUJO_BASH_ROOTS`, falling back to `FLUJO_FS_ROOTS`, plus UI-persisted roots
 * that may only narrow within it). This is a best-effort guardrail — a shell can
 * `cd` elsewhere or use absolute paths, so `FLUJO_FS_ROOTS`/`FLUJO_BASH_ROOTS`
 * and OS permissions remain the real boundary. Spawned commands also DO NOT
 * inherit the full backend `process.env` by default (which would leak secrets);
 * only a minimal allow-list is passed. Set `FLUJO_BASH_INHERIT_ENV=1` to restore
 * full inheritance. Individual calls may pass explicit `env` overrides without
 * enabling full inheritance.
 *
 * Every tool returns a machine-readable JSON envelope in a single text content
 * block; failures come back as `isError: true` rather than thrown.
 *
 * MCP App contract (issue #330): the terminal View is a streaming,
 * line-oriented console over these existing piped child processes. It is not a
 * PTY and deliberately does not emulate curses/full-screen programs, cursor
 * positioning, alternate screens, or terminal resize negotiation.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ALLOW_PROTECTED_PATHS_ENV,
  createLogger,
  getDataDir,
  getHomeDir,
  isInside,
  isProtected,
  isProtectedPathsEnabled,
  killProcessTree,
  loadEffectiveRoots,
} from '@flujo-ai/mcp-shared';

const BASH_SERVER_NAME = 'bash';
export const BASH_TERMINAL_APP_URI = 'ui://bash/terminal';

const log = createLogger('backend/services/mcp/internal/bashTools');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_SESSIONS = 25;
/**
 * Lifecycle: live sessions end only by process exit, explicit kill, or Bash
 * server shutdown. Finished owner-scoped records remain readable for ten
 * minutes, then are reaped. An MCP View teardown may be an inline→dock handoff,
 * so it is not treated as an owner disconnect signal.
 */
const SESSION_TTL_MS = 10 * 60_000;

type ShellKind = 'default' | 'pwsh' | 'bash' | 'cmd';
type EffectiveShell = 'pwsh' | 'powershell' | 'bash' | 'cmd' | 'sh';

export interface BashToolProgress {
  progress: number;
  message?: string;
}

export interface BashExecutionContext {
  signal?: AbortSignal;
  onProgress?: (progress: BashToolProgress) => void | Promise<void>;
}

/**
 * Locate an executable by name on `PATH` ourselves (rather than relying on
 * `spawn`'s own resolution) so we can know in advance whether `pwsh`/`bash`
 * are actually available and return a deterministic error instead of failing
 * asynchronously with ENOENT (issue #225).
 */
function getEnvCaseInsensitive(name: string): string | undefined {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? process.env[key] : undefined;
}

function windowsExecutableExtensions(): string[] {
  const inherited = (getEnvCaseInsensitive('PATHEXT') ?? '')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean);
  const required = ['.COM', '.EXE', '.BAT', '.CMD'];
  return [...new Set([...required, ...inherited].map((extension) =>
    (extension.startsWith('.') ? extension : `.${extension}`).toUpperCase()
  ))];
}

function findExecutablesOnPath(name: string): string[] {
  const pathEnv = getEnvCaseInsensitive('PATH') ?? '';
  const dirs = pathEnv
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  const exts = process.platform === 'win32'
    ? windowsExecutableExtensions()
    : [''];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(candidate).isFile()) found.push(candidate);
      } catch {
        /* not found here, keep looking */
      }
    }
  }
  return [...new Set(found.map((candidate) => path.resolve(candidate)))];
}

function findExecutableOnPath(name: string): string | null {
  return findExecutablesOnPath(name)[0] ?? null;
}

function firstExistingFile(candidates: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  for (const rawCandidate of candidates) {
    if (!rawCandidate) continue;
    const candidate = path.resolve(rawCandidate);
    const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not found here, keep looking */
    }
  }
  return null;
}

/**
 * Well-known install locations for Git for Windows' `bash.exe`. These are
 * preferred over the legacy System32 WSL launcher, which may exist even when
 * its Linux `/bin/bash` does not (issues #225 and #327).
 */
function windowsGitBashCandidates(): string[] {
  const roots = [
    getEnvCaseInsensitive('ProgramFiles'),
    getEnvCaseInsensitive('ProgramFiles(x86)'),
    getEnvCaseInsensitive('LocalAppData'),
  ]
    .filter((v): v is string => Boolean(v));
  const git = findExecutableOnPath('git');
  const gitRoot = git ? path.dirname(path.dirname(git)) : undefined;
  return [
    ...(gitRoot ? [
      path.join(gitRoot, 'bin', 'bash.exe'),
      path.join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ] : []),
    ...roots.flatMap((root) => [
      path.join(root, 'Git', 'bin', 'bash.exe'),
      path.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
      path.join(root, 'Programs', 'Git', 'bin', 'bash.exe'),
      path.join(root, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    ]),
  ];
}

function isWindowsWslBashLauncher(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const systemRoot = getEnvCaseInsensitive('SystemRoot') ?? getEnvCaseInsensitive('windir');
  if (!systemRoot) return false;
  return path.resolve(candidate).toLowerCase() === path.resolve(systemRoot, 'System32', 'bash.exe').toLowerCase();
}

let cachedBashPath: string | null | undefined;
function resolveBashExecutable(): string | null {
  if (cachedBashPath && firstExistingFile([cachedBashPath])) return cachedBashPath;
  const candidates = process.platform === 'win32'
    ? [
        ...windowsGitBashCandidates(),
        ...findExecutablesOnPath('bash').filter((candidate) => !isWindowsWslBashLauncher(candidate)),
      ]
    : findExecutablesOnPath('bash');
  cachedBashPath = firstExistingFile(candidates);
  return cachedBashPath;
}

function windowsPwshCandidates(): string[] {
  const localAppData = getEnvCaseInsensitive('LocalAppData');
  const programFiles = getEnvCaseInsensitive('ProgramFiles');
  return [
    ...(localAppData ? [path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')] : []),
    ...(programFiles ? [
      path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      path.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
    ] : []),
  ];
}

let cachedPwshPath: string | null | undefined;
function resolvePwshExecutable(): string | null {
  if (cachedPwshPath && firstExistingFile([cachedPwshPath])) return cachedPwshPath;
  cachedPwshPath = firstExistingFile([
    ...findExecutablesOnPath('pwsh'),
    ...(process.platform === 'win32' ? windowsPwshCandidates() : []),
  ]);
  return cachedPwshPath;
}

let cachedWindowsPowerShellPath: string | null | undefined;
function resolveWindowsPowerShellExecutable(): string | null {
  if (cachedWindowsPowerShellPath && firstExistingFile([cachedWindowsPowerShellPath])) {
    return cachedWindowsPowerShellPath;
  }
  const systemRoot = getEnvCaseInsensitive('SystemRoot') ?? getEnvCaseInsensitive('windir');
  cachedWindowsPowerShellPath = firstExistingFile([
    findExecutableOnPath('powershell'),
    ...(systemRoot
      ? [path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
      : []),
  ]);
  return cachedWindowsPowerShellPath;
}

function resolveCmdExecutable(): string | null {
  if (process.platform !== 'win32') return null;
  return firstExistingFile([
    getEnvCaseInsensitive('ComSpec'),
    findExecutableOnPath('cmd'),
    path.join(getEnvCaseInsensitive('SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
  ]);
}

/** Test-only: forget cached shell-executable lookups. */
export function _resetBashShellCacheForTests(): void {
  cachedBashPath = undefined;
  cachedPwshPath = undefined;
  cachedWindowsPowerShellPath = undefined;
}

interface BashSession {
  id: string;
  /** Host-derived caller/conversation scope; never selected by tool arguments. */
  ownerScope: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  output: string;
  truncated: boolean;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  cancelEscalation?: () => void;
  reapTimer?: NodeJS.Timeout;
}

// Process-global so all Next.js module-graph instances share one session table
// (same rationale as __mcp_clients in index.ts) and the exit-cleanup runs once.
declare global {
  // eslint-disable-next-line no-var
  var __flujo_bash_sessions: Map<string, BashSession> | undefined;
  // eslint-disable-next-line no-var
  var __flujo_bash_foreground_children: Set<ChildProcess> | undefined;
  // eslint-disable-next-line no-var
  var __flujo_bash_cleanup_registered: boolean | undefined;
}

function sessions(): Map<string, BashSession> {
  if (!global.__flujo_bash_sessions) global.__flujo_bash_sessions = new Map<string, BashSession>();
  return global.__flujo_bash_sessions;
}

function foregroundChildren(): Set<ChildProcess> {
  if (!global.__flujo_bash_foreground_children) global.__flujo_bash_foreground_children = new Set<ChildProcess>();
  return global.__flujo_bash_foreground_children;
}

const ANONYMOUS_OWNER_SCOPE = 'legacy:anonymous';

function effectiveOwnerScope(ownerScope?: string, callerNodeId?: string): string {
  const explicit = ownerScope?.trim();
  if (explicit) return explicit;
  const caller = callerNodeId?.trim();
  return caller ? `caller:${caller}` : ANONYMOUS_OWNER_SCOPE;
}

function ownedSession(id: string, ownerScope: string): BashSession | undefined {
  const session = sessions().get(id);
  return session?.ownerScope === ownerScope ? session : undefined;
}

function terminalMeta(): Tool['_meta'] {
  return { ui: { resourceUri: BASH_TERMINAL_APP_URI } };
}

/** Kill every live session's process tree — used on FLUJO process exit. */
export function shutdownBashSessions(): void {
  for (const child of foregroundChildren()) {
    try {
      killProcessTree(child);
    } catch {
      /* best-effort */
    }
  }
  for (const s of sessions().values()) {
    if (s.running) {
      try {
        killProcessTree(s.child);
      } catch {
        /* best-effort */
      }
    }
    if (s.reapTimer) clearTimeout(s.reapTimer);
  }
}

function registerExitCleanup(): void {
  if (global.__flujo_bash_cleanup_registered) return;
  global.__flujo_bash_cleanup_registered = true;
  const handler = () => shutdownBashSessions();
  process.on('exit', handler);
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

function textResult(payload: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Env var names that supply the bash confinement ceiling (checked in order). */
const BASH_ROOT_ENV_VARS = ['FLUJO_BASH_ROOTS', 'FLUJO_FS_ROOTS'];

/**
 * Resolve the working directory against the FLUJO data dir (for relative paths)
 * and enforce the effective confinement roots when present. Throws on a
 * confinement violation so callers surface a precise error (issue #175).
 */
async function resolveCwd(input: unknown, roots: string[]): Promise<string> {
  const dataDir = getDataDir();
  const raw = typeof input === 'string' ? input.trim() : '';
  const resolved = raw ? (path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dataDir, raw)) : dataDir;

  // Optional defense-in-depth layer (issue #260). Configured roots win by
  // default; users can opt into this stricter policy under Experimental Features.
  if (await isProtectedPathsEnabled()) {
    const prot = isProtected(resolved);
    if (prot.denied) {
      throw new Error(
        `cwd "${resolved}" is within a protected location (${prot.matchedRoot}) and is blocked by the FLUJO built-in server protected-path policy. ` +
          `Disable "Protect sensitive home-directory paths" in Experimental Features or set ${ALLOW_PROTECTED_PATHS_ENV}=1 to override.`
      );
    }
  }

  if (roots.length === 0 || !roots.some((root) => isInside(root, resolved))) {
    throw new Error(`cwd "${resolved}" is outside the configured bash roots.`);
  }
  return resolved;
}

/**
 * Best-effort advisory scan (issue #260, item 4) of a command string for
 * absolute-looking paths that point OUTSIDE the configured roots or INTO a
 * protected location. Returns human-readable warning strings; it NEVER blocks —
 * a shell can reach anywhere regardless, so this is honest advice, not a
 * boundary. Known limitation: shell variable expansions (e.g. `$HOME/AppData`)
 * are not resolved.
 */
function maskGlobOptionValues(command: string): string {
  const chars = [...command];
  const tokens = [...command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)];
  let maskNext = false;
  for (const match of tokens) {
    const raw = match[0];
    const start = match.index ?? 0;
    const unquoted = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw;
    let valueOffset = 0;
    if (maskNext) {
      maskNext = false;
    } else if (unquoted === '-g' || unquoted === '--glob' || unquoted === '--iglob') {
      maskNext = true;
      continue;
    } else {
      if (!/^(?:--glob|--iglob)=/.test(unquoted)) continue;
      valueOffset = raw.indexOf('=') + 1;
    }
    for (let i = start + valueOffset; i < start + raw.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

async function scanCommandForExternalPaths(command: string, cwd: string, roots: string[]): Promise<string[]> {
  const warnings: string[] = [];
  const protectedPathsEnabled = await isProtectedPathsEnabled();
  const seen = new Set<string>();
  // Ripgrep glob values are patterns, not filesystem paths. Mask only option
  // values so a real path elsewhere in the same command is still inspected.
  const commandForPathScan = maskGlobOptionValues(command);
  // Absolute-looking tokens: Windows drive (X:\ or X:/), UNC (\\host\share),
  // POSIX (/foo), and ~-prefixed home paths.
  const tokenRe = /(?:[A-Za-z]:[\\/][^\s"']*|\\\\[^\s"']+|~\/[^\s"']*|(?<![\w.])\/[^\s"']+)/g;
  const matches = (commandForPathScan.match(tokenRe) ?? []).filter(
    // A single-letter slash token is a Windows command switch, not a POSIX path.
    // Keep longer tokens so genuine POSIX absolute paths remain advisory notices.
    (token) => !(process.platform === 'win32' && /^\/[A-Za-z]$/.test(token))
  );
  const home = (() => {
    try {
      return getHomeDir();
    } catch {
      return '';
    }
  })();
  for (const rawToken of matches) {
    let token = rawToken;
    if (token.startsWith('~/') && home) token = path.join(home, token.slice(2));
    let resolved: string;
    try {
      resolved = path.isAbsolute(token) ? path.resolve(token) : path.resolve(cwd, token);
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const prot = protectedPathsEnabled ? isProtected(resolved) : { denied: false };
    if (prot.denied) {
      warnings.push(`Command references "${rawToken}", which is inside a protected location (${prot.matchedRoot}).`);
    } else if (roots.length > 0 && !roots.some((root) => isInside(root, resolved))) {
      warnings.push(`Command references "${rawToken}", which is outside the configured working roots.`);
    }
  }
  return warnings;
}

/**
 * A truthy env flag: "1", "true", "yes", "on" (case-insensitive).
 */
function isTruthyEnv(value: string | undefined): boolean {
  return typeof value === 'string' && /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Names of environment variables that are safe (and often necessary) to pass to
 * a spawned shell. Anything not on this list — notably API keys / secrets — is
 * withheld by default so a command like `env` / `printenv` / `Get-ChildItem Env:`
 * cannot read them back (issue #175). `LC_*` locale vars are allowed by prefix.
 */
const ENV_ALLOWLIST = new Set([
  'path',
  'home', 'userprofile', 'homedrive', 'homepath',
  'appdata', 'localappdata', 'programdata',
  'tmp', 'temp', 'tmpdir',
  'lang', 'lc_all', 'term', 'colorterm', 'no_color',
  'shell', 'user', 'username', 'logname',
  // Windows essentials so the default shell can even start.
  'systemroot', 'windir', 'comspec', 'pathext', 'systemdrive',
  'programfiles', 'programfiles(x86)',
  'number_of_processors', 'processor_architecture',
]);

/**
 * Returns the managed utilities directory path where Unix-like utilities
 * (BusyBox applets on Windows) are installed. This directory is prepended to
 * the child process PATH so that tools like grep, find, sed, awk are available.
 */
function getManagedUtilsDir(): string {
  return path.join(getDataDir(), 'bash-utils');
}

const CODEX_RIPGREP_TARGETS: Partial<Record<NodeJS.Platform, Partial<Record<string, [string, string]>>>> = {
  win32: {
    x64: ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
    arm64: ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
  },
  darwin: {
    x64: ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
    arm64: ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  },
  linux: {
    x64: ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
    arm64: ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  },
};

/** Resolve the ripgrep binary already bundled with FLUJO's Codex dependency. */
function getBundledRipgrepDir(): string | null {
  const target = CODEX_RIPGREP_TARGETS[process.platform]?.[process.arch];
  if (!target) return null;
  try {
    const packageJson = require.resolve(`${target[0]}/package.json`);
    const dir = path.join(path.dirname(packageJson), 'vendor', target[1], 'codex-path');
    const executable = path.join(dir, process.platform === 'win32' ? 'rg.exe' : 'rg');
    return fs.statSync(executable).isFile() ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Build the child process environment. By default only the minimal allow-list is
 * inherited (secrets never leave the backend). Explicit per-command overrides
 * are then applied. Setting `FLUJO_BASH_INHERIT_ENV` to a truthy value restores
 * full `process.env` inheritance for power users.
 */
function buildChildEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = isTruthyEnv(process.env.FLUJO_BASH_INHERIT_ENV)
    ? { ...process.env }
    : Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ENV_ALLOWLIST.has(key.toLowerCase()) || /^LC_/i.test(key)
        )
      ) as NodeJS.ProcessEnv;
  const currentPath = getEnvCaseInsensitive('PATH') ?? '';
  const utilityDirs = [getManagedUtilsDir(), getBundledRipgrepDir()]
    .filter((dir): dir is string => Boolean(dir))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });
  out.PATH = [...utilityDirs, currentPath].filter(Boolean).join(path.delimiter);
  if (process.platform === 'win32') {
    // Node de-duplicates Windows environment keys case-insensitively; retain a
    // single spelling so the augmented value is the one passed to the child.
    for (const key of Object.keys(out)) {
      if (key !== 'PATH' && key.toLowerCase() === 'path') delete out[key];
      if (key !== 'PATHEXT' && key.toLowerCase() === 'pathext') delete out[key];
    }
    out.PATHEXT = windowsExecutableExtensions().join(';');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(out)) {
        if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete out[existing];
      }
    }
    out[key] = value;
  }
  return out;
}

type EnvValidation =
  | { valid: true; env: Record<string, string> }
  | { valid: false; error: string };

function validateEnv(input: unknown): EnvValidation {
  if (input === undefined) return { valid: true, env: {} };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, error: '"env" must be an object whose values are strings.' };
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!key || key.includes('=') || key.includes('\0')) {
      return { valid: false, error: `Invalid environment variable name: ${JSON.stringify(key)}.` };
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      return { valid: false, error: `Environment variable ${JSON.stringify(key)} must be a string without NUL characters.` };
    }
    env[key] = value;
  }
  return { valid: true, env };
}

interface SpawnPlan {
  file: string;
  args: string[];
  useShell: boolean;
  effectiveShell: EffectiveShell;
  windowsVerbatimArguments?: boolean;
  /** Explicit shell lookup failed before any user command was executed. */
  unavailableShell?: Exclude<ShellKind, 'default'>;
  startError?: string;
}

/**
 * Build the spawn arguments for the requested shell. Returns the command, argv
 * and whether Node's `shell:true` wrapping applies. Shells are resolved
 * to a concrete executable path up front (checking Git for Windows' well-known
 * install locations for `bash` when it isn't on `PATH`). An unavailable
 * explicitly requested shell is reported before any user command is executed.
 */
function buildSpawn(command: string, shell: ShellKind): SpawnPlan {
  if (shell === 'pwsh') {
    const resolved = resolvePwshExecutable();
    if (resolved) {
      return { file: resolved, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], useShell: false, effectiveShell: 'pwsh' };
    }
    return { file: '', args: [], useShell: false, effectiveShell: 'pwsh', unavailableShell: 'pwsh' };
  }
  if (shell === 'bash') {
    const resolved = resolveBashExecutable();
    if (resolved) {
      return { file: resolved, args: ['-c', command], useShell: false, effectiveShell: 'bash' };
    }
    return { file: '', args: [], useShell: false, effectiveShell: 'bash', unavailableShell: 'bash' };
  }
  if (shell === 'cmd') {
    const resolved = resolveCmdExecutable();
    if (resolved) {
      return {
        file: resolved,
        args: ['/d', '/s', '/c', command],
        useShell: false,
        effectiveShell: 'cmd',
        windowsVerbatimArguments: true,
      };
    }
    return { file: '', args: [], useShell: false, effectiveShell: 'cmd', unavailableShell: 'cmd' };
  }
  if (process.platform === 'win32') {
    const pwsh = resolvePwshExecutable();
    if (pwsh) {
      return { file: pwsh, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], useShell: false, effectiveShell: 'pwsh' };
    }
    const windowsPowerShell = resolveWindowsPowerShellExecutable();
    if (windowsPowerShell) {
      return { file: windowsPowerShell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], useShell: false, effectiveShell: 'powershell' };
    }
    const cmd = resolveCmdExecutable();
    if (cmd) {
      return {
        file: cmd,
        args: ['/d', '/s', '/c', command],
        useShell: false,
        effectiveShell: 'cmd',
        windowsVerbatimArguments: true,
      };
    }
    return {
      file: '',
      args: [],
      useShell: false,
      effectiveShell: 'cmd',
      startError: 'No usable PowerShell or cmd executable was found.',
    };
  }
  const sh = firstExistingFile(['/bin/sh', findExecutableOnPath('sh')]);
  if (sh) return { file: sh, args: ['-c', command], useShell: false, effectiveShell: 'sh' };
  return {
    file: '',
    args: [],
    useShell: false,
    effectiveShell: 'sh',
    startError: 'No POSIX /bin/sh executable was found.',
  };
}

type ShellValidation =
  | { valid: true; shell: ShellKind }
  | { valid: false; requestedShell: unknown };

function safeRequestedShellValue(input: unknown): unknown {
  try {
    const serialized = JSON.stringify(input);
    if (serialized !== undefined) return JSON.parse(serialized);
  } catch {
    // Fall through to a non-throwing string representation.
  }
  try {
    return String(input);
  } catch {
    return '<unrepresentable>';
  }
}

function validateShell(input: unknown): ShellValidation {
  if (input === undefined) return { valid: true, shell: 'default' };
  if (input === 'default' || input === 'pwsh' || input === 'bash' || input === 'cmd') {
    return { valid: true, shell: input };
  }
  return { valid: false, requestedShell: safeRequestedShellValue(input) };
}

function invalidShellResult(requestedShell: unknown): CallToolResult {
  return textResult({
    error: 'Invalid shell request. Expected one of: "default", "pwsh", "bash", or "cmd".',
    requestedShell,
  }, true);
}

interface SpawnOutcome {
  child?: ChildProcess;
  startError?: string;
  effectiveShell: EffectiveShell;
  unavailableShell?: Exclude<ShellKind, 'default'>;
}

function startChild(command: string, cwd: string, shell: ShellKind, env: Record<string, string>): SpawnOutcome {
  const {
    file,
    args,
    useShell,
    effectiveShell,
    unavailableShell,
    startError,
    windowsVerbatimArguments,
  } = buildSpawn(command, shell);
  if (unavailableShell) return { effectiveShell, unavailableShell };
  if (startError) return { effectiveShell, startError };
  // POSIX: detached so killProcessTree can signal the whole group (see killProcessTree).
  const detached = process.platform !== 'win32';
  try {
    const child = spawn(file, args, {
      cwd,
      shell: useShell,
      env: buildChildEnv(env),
      detached,
      ...(windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return { child, effectiveShell };
  } catch (err) {
    return {
      startError: err instanceof Error ? err.message : String(err),
      effectiveShell,
    };
  }
}

function makeAppender(get: () => string, set: (v: string, truncated: boolean) => void) {
  return (chunk: string) => {
    let out = get();
    if (out.length >= MAX_OUTPUT_CHARS) {
      if (chunk) set(out, true);
      return;
    }
    out += chunk;
    let truncated = false;
    if (out.length > MAX_OUTPUT_CHARS) {
      out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…[output truncated]';
      truncated = true;
    }
    set(out, truncated);
  };
}

function createCommandProgressReporter(context?: BashExecutionContext): {
  push: (chunk: string) => void;
  stop: () => Promise<void>;
} {
  const report = context?.onProgress;
  if (!report) return { push: () => undefined, stop: async () => undefined };

  const startedAt = Date.now();
  const maxMessageChars = 4_000;
  let progress = 0;
  let pending = '';
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let forwardedChars = 0;
  let liveOutputTruncated = false;
  let chain = Promise.resolve();

  const deliver = (message: string) => {
    if (!message) return;
    const snapshot = progress;
    chain = chain
      .then(() => report({ progress: snapshot, message }))
      .catch((error) => {
        log.debug('Could not deliver bash progress notification', error);
      });
  };
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    while (pending.length > 0) {
      const message = pending.slice(0, maxMessageChars);
      pending = pending.slice(message.length);
      deliver(message);
    }
  };
  const heartbeat = setInterval(() => {
    if (stopped) return;
    if (pending) flush();
    else deliver(`[command still running: ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s]`);
  }, 10_000);
  heartbeat.unref?.();

  return {
    push: (chunk) => {
      if (stopped || !chunk) return;
      progress += Buffer.byteLength(chunk, 'utf8');
      const remaining = Math.max(0, MAX_OUTPUT_CHARS - forwardedChars);
      if (remaining > 0) {
        const accepted = chunk.slice(0, remaining);
        pending += accepted;
        forwardedChars += accepted.length;
      }
      if (chunk.length > remaining && !liveOutputTruncated) {
        liveOutputTruncated = true;
        pending += '\n…[live output truncated]';
      }
      if (pending.length >= maxMessageChars) {
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, 75);
        flushTimer.unref?.();
      }
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(heartbeat);
      flush();
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          chain,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1_000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export function bashToolDefinitions(): Tool[] {
  const shellProp = {
    type: 'string',
    enum: ['default', 'pwsh', 'bash', 'cmd'],
    description: 'Command parser. "default" uses PowerShell on Windows and /bin/sh elsewhere. Use "pwsh", "bash", or "cmd" for explicit syntax; unavailable explicit shells return an error.',
  };
  const cwdProp = { type: 'string', description: 'Working directory. Relative paths resolve from the FLUJO data directory; configured roots still apply.' };
  const envProp = {
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Environment variables to add or override for this command.',
  };
  return [
    {
      name: 'run',
      description:
        'Run one command to completion. Output is sent as live progress when supported and returned with the exit code; use start/status for a persistent background session.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command text in the selected shell\'s syntax.' },
          cwd: cwdProp,
          shell: shellProp,
          env: envProp,
          timeout: { type: 'number', description: 'Timeout in seconds (default 60, max 600).' },
          normalizeNewlines: { type: 'boolean', description: 'If true, CRLF/CR in the captured output are normalized to LF.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'start',
      description: 'Start an independent background command and return its sessionId. Multiple sessions may run in parallel; use status/wait, write_stdin, or kill.',
      _meta: terminalMeta(),
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute in the background.' },
          cwd: cwdProp,
          shell: shellProp,
          env: envProp,
        },
        required: ['command'],
      },
    },
    {
      name: 'status',
      description: 'Return the current state of a background session: { sessionId, running, exitCode, output, truncated }.',
      _meta: terminalMeta(),
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'The id returned by start.' } },
        required: ['sessionId'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for a background session, sending new output as live progress when supported. The wait timeout does not kill the session.',
      _meta: terminalMeta(),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The id returned by start.' },
          timeout: { type: 'number', description: 'Max seconds to wait (default 60, max 600).' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'write_stdin',
      description: 'Write a string to a running background session\'s stdin. Pass "newline": false to omit the trailing newline. Returns { sessionId, written }.',
      _meta: terminalMeta(),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The id returned by start.' },
          data: { type: 'string', description: 'Text to write to stdin.' },
          newline: { type: 'boolean', description: 'Append a trailing newline (default true).' },
        },
        required: ['sessionId', 'data'],
      },
    },
    {
      name: 'kill',
      description: 'Kill a background session (and its whole process tree). Returns { sessionId, killed }.',
      _meta: terminalMeta(),
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'The id returned by start.' } },
        required: ['sessionId'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List background sessions owned by this caller scope. Returns { sessions: [{ sessionId, command, running, exitCode, startedAt, endedAt }] }.',
      _meta: terminalMeta(),
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function maybeNormalize(text: string, normalize: boolean): string {
  return normalize ? text.replace(/\r\n?/g, '\n') : text;
}

async function runTool(
  args: Record<string, unknown>,
  roots: string[],
  context?: BashExecutionContext,
): Promise<CallToolResult> {
  const command = String(args?.command ?? '').trim();
  if (!command) return textResult({ error: 'Provide "command": a shell command line to run.' }, true);

  const shellValidation = validateShell(args.shell);
  if (!shellValidation.valid) return invalidShellResult(shellValidation.requestedShell);
  const requestedShell = shellValidation.shell;
  const envValidation = validateEnv(args.env);
  if (!envValidation.valid) return textResult({ error: envValidation.error }, true);
  if (context?.signal?.aborted) {
    return textResult({ error: 'Command cancelled before it started.', cancelled: true, requestedShell }, true);
  }

  const cwd = await resolveCwd(args.cwd, roots);
  const warnings = await scanCommandForExternalPaths(command, cwd, roots);
  const warn = warnings.length ? { warnings } : {};
  const normalize = args.normalizeNewlines === true;
  const timeoutSec = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = Math.min(timeoutSec * 1000, MAX_TIMEOUT_MS);
  registerExitCleanup();

  return await new Promise<CallToolResult>((resolve) => {
    let output = '';
    let truncated = false;
    let settled = false;

    const append = makeAppender(() => output, (v, t) => { output = v; truncated = t || truncated; });
    const progress = createCommandProgressReporter(context);

    const { child, startError, effectiveShell, unavailableShell } = startChild(
      command,
      cwd,
      requestedShell,
      envValidation.env,
    );
    if (unavailableShell) {
      void progress.stop().then(() => {
        resolve(textResult({ error: `Requested shell "${unavailableShell}" is unavailable or could not be resolved.`, cwd, shell: unavailableShell }, true));
      });
      return;
    }
    if (startError || !child) {
      void progress.stop().then(() => {
        resolve(textResult({ error: `Failed to start command (${effectiveShell}): ${startError ?? 'unknown error'}`, cwd, shell: effectiveShell }, true));
      });
      return;
    }
    foregroundChildren().add(child);

    let cancelEscalation: (() => void) | undefined;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      cancelEscalation = killProcessTree(child);
      const finalOut = maybeNormalize(output, normalize);
      void finish(textResult({
        error: 'Command cancelled.',
        cancelled: true,
        cwd,
        requestedShell,
        shell: effectiveShell,
        exitCode: null,
        truncated,
        output: finalOut,
        ...warn,
      }, true), true);
    };
    const finish = async (result: CallToolResult, keepKillEscalation = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);
      if (!keepKillEscalation) cancelEscalation?.();
      await progress.stop();
      resolve(result);
    };

    timer = setTimeout(() => {
      cancelEscalation = killProcessTree(child);
      const finalOut = maybeNormalize(output, normalize);
      void finish(textResult({
        timedOut: true,
        cwd,
        requestedShell,
        shell: effectiveShell,
        exitCode: null,
        truncated,
        output: `${finalOut}${finalOut ? '\n' : ''}[killed after ${timeoutMs / 1000}s timeout]`,
        ...warn,
      }, true), true);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      append(chunk);
      progress.push(maybeNormalize(chunk, normalize));
    });
    child.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString();
      append(chunk);
      progress.push(maybeNormalize(chunk, normalize));
    });

    child.on('error', (err: Error) => {
      // ENOENT here means the resolved executable vanished between resolution and spawn.
      foregroundChildren().delete(child);
      append(`\n${err.message}`);
      void finish(textResult({ error: `Command failed to start (${effectiveShell}): ${err.message}`, cwd, shell: effectiveShell, output: maybeNormalize(output, normalize) }, true));
    });

    child.on('close', (code: number | null) => {
      foregroundChildren().delete(child);
      cancelEscalation?.();
      if (settled) return;
      const finalOut = maybeNormalize(output, normalize);
      void finish(textResult({ exitCode: code, cwd, requestedShell, shell: effectiveShell, truncated, output: finalOut, ...warn }, code !== 0));
    });
    if (context?.signal?.aborted) onAbort();
    else context?.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function scheduleReap(session: BashSession): void {
  session.reapTimer = setTimeout(() => {
    sessions().delete(session.id);
  }, SESSION_TTL_MS);
  // Do not keep the event loop alive just to reap a session.
  session.reapTimer.unref?.();
}

async function startTool(
  args: Record<string, unknown>,
  roots: string[],
  ownerScope: string,
  context?: BashExecutionContext,
): Promise<CallToolResult> {
  const command = String(args?.command ?? '').trim();
  if (!command) return textResult({ error: 'Provide "command": a shell command line to run.' }, true);

  const shellValidation = validateShell(args.shell);
  if (!shellValidation.valid) return invalidShellResult(shellValidation.requestedShell);
  const requestedShell = shellValidation.shell;
  const envValidation = validateEnv(args.env);
  if (!envValidation.valid) return textResult({ error: envValidation.error }, true);
  if (context?.signal?.aborted) {
    return textResult({ error: 'Command cancelled before it started.', cancelled: true, requestedShell }, true);
  }

  // Sweep finished sessions before enforcing the cap so a long-lived process
  // doesn't get blocked by stale completed entries.
  const table = sessions();
  if (table.size >= MAX_SESSIONS) {
    for (const [id, s] of table) {
      if (!s.running) table.delete(id);
    }
  }
  if (table.size >= MAX_SESSIONS) {
    return textResult({ error: `Too many active background sessions (max ${MAX_SESSIONS}). Kill some first.` }, true);
  }

  registerExitCleanup();

  const cwd = await resolveCwd(args.cwd, roots);
  const warnings = await scanCommandForExternalPaths(command, cwd, roots);
  const warn = warnings.length ? { warnings } : {};
  const { child, startError, effectiveShell, unavailableShell } = startChild(
    command,
    cwd,
    requestedShell,
    envValidation.env,
  );
  if (unavailableShell) {
    return textResult({ error: `Requested shell "${unavailableShell}" is unavailable or could not be resolved.`, cwd, shell: unavailableShell }, true);
  }
  if (startError || !child) {
    return textResult({ error: `Failed to start command (${effectiveShell}): ${startError ?? 'unknown error'}`, cwd, shell: effectiveShell }, true);
  }

  const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: BashSession = {
    id,
    ownerScope,
    command,
    cwd,
    child,
    output: '',
    truncated: false,
    running: true,
    exitCode: null,
    startedAt: Date.now(),
  };
  table.set(id, session);

  const append = makeAppender(() => session.output, (v, t) => { session.output = v; session.truncated = t || session.truncated; });
  child.stdout?.on('data', (d: Buffer) => append(d.toString()));
  child.stderr?.on('data', (d: Buffer) => append(d.toString()));
  child.on('error', (err: Error) => {
    append(`\n${err.message}`);
    session.running = false;
    session.endedAt = Date.now();
    scheduleReap(session);
  });
  child.on('close', (code: number | null) => {
    session.running = false;
    session.exitCode = code;
    session.endedAt = Date.now();
    scheduleReap(session);
  });

  return textResult({ sessionId: id, cwd, requestedShell, shell: effectiveShell, ...warn });
}

function snapshot(session: BashSession, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: session.id,
    running: session.running,
    exitCode: session.exitCode,
    output: session.output,
    truncated: session.truncated,
    ...extra,
  };
}

function statusTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = ownedSession(id, ownerScope);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  return textResult(snapshot(session));
}

async function waitTool(
  args: Record<string, unknown>,
  ownerScope: string,
  context?: BashExecutionContext,
): Promise<CallToolResult> {
  const id = String(args?.sessionId ?? '');
  const session = ownedSession(id, ownerScope);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  if (!session.running) return textResult(snapshot(session, { timedOut: false }));
  if (context?.signal?.aborted) {
    return textResult(snapshot(session, { timedOut: false, cancelled: true }), true);
  }

  const timeoutSec = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = Math.min(timeoutSec * 1000, MAX_TIMEOUT_MS);
  const progress = createCommandProgressReporter(context);

  const outcome = await new Promise<'completed' | 'timedOut' | 'cancelled'>((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let outputOffset = 0;
    const finish = async (value: 'completed' | 'timedOut' | 'cancelled') => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      context?.signal?.removeEventListener('abort', onAbort);
      if (session.output.length > outputOffset) progress.push(session.output.slice(outputOffset));
      await progress.stop();
      resolve(value);
    };
    const onAbort = () => void finish('cancelled');
    const poll = () => {
      if (session.output.length > outputOffset) {
        progress.push(session.output.slice(outputOffset));
        outputOffset = session.output.length;
      }
      if (!session.running) {
        void finish('completed');
        return;
      }
      pollTimer = setTimeout(poll, 100);
    };
    timeoutTimer = setTimeout(() => void finish('timedOut'), timeoutMs);
    context?.signal?.addEventListener('abort', onAbort, { once: true });
    poll();
  });
  return textResult(
    snapshot(session, {
      timedOut: outcome === 'timedOut',
      ...(outcome === 'cancelled' ? { cancelled: true } : {}),
    }),
    outcome === 'cancelled',
  );
}

function writeStdinTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = ownedSession(id, ownerScope);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  if (!session.running) return textResult({ error: `Session "${id}" has already exited.` }, true);
  const data = typeof args.data === 'string' ? args.data : '';
  const withNewline = args.newline === false ? data : `${data}\n`;
  try {
    session.child.stdin?.write(withNewline);
  } catch (err) {
    return textResult({ error: `Failed to write to stdin: ${err instanceof Error ? err.message : String(err)}` }, true);
  }
  return textResult({ sessionId: id, written: Buffer.byteLength(withNewline, 'utf8') });
}

function killTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = ownedSession(id, ownerScope);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  if (session.running) {
    session.cancelEscalation = killProcessTree(session.child);
  }
  return textResult({ sessionId: id, killed: true });
}

function listSessionsTool(ownerScope: string): CallToolResult {
  const list = Array.from(sessions().values())
    .filter((s) => s.ownerScope === ownerScope)
    .map((s) => ({
      sessionId: s.id,
      command: s.command,
      running: s.running,
      exitCode: s.exitCode,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
    }));
  return textResult({ sessions: list });
}

export async function bashCallTool(
  toolName: string,
  args: Record<string, unknown>,
  callerNodeId?: string,
  ownerScope?: string,
  context?: BashExecutionContext,
): Promise<CallToolResult> {
  try {
    const scope = effectiveOwnerScope(ownerScope, callerNodeId);
    switch (toolName) {
      case 'run': {
        const roots = await loadEffectiveRoots(BASH_SERVER_NAME, BASH_ROOT_ENV_VARS, callerNodeId);
        return await runTool(args, roots, context);
      }
      case 'start': {
        const roots = await loadEffectiveRoots(BASH_SERVER_NAME, BASH_ROOT_ENV_VARS, callerNodeId);
        return await startTool(args, roots, scope, context);
      }
      case 'status':
        return statusTool(args, scope);
      case 'wait':
        return await waitTool(args, scope, context);
      case 'write_stdin':
        return writeStdinTool(args, scope);
      case 'kill':
        return killTool(args, scope);
      case 'list_sessions':
        return listSessionsTool(scope);
      default:
        return textResult({ error: `Unknown tool on the built-in bash server: ${toolName}` }, true);
    }
  } catch (err) {
    log.warn('bashCallTool failed', { toolName, err });
    return textResult({ error: `Tool failed: ${err instanceof Error ? err.message : String(err)}` }, true);
  }
}

/** Test-only: force-kill and clear all sessions. */
export function _resetBashSessionsForTests(): void {
  shutdownBashSessions();
  foregroundChildren().clear();
  sessions().clear();
}
