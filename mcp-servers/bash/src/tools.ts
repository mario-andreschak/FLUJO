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
 * MCP App contract (issue #330): ordinary run/background tools continue to use
 * pipes, while the interactive terminal View uses a real OS pseudoterminal
 * (ConPTY on Windows, forkpty on POSIX) with incremental reads, raw keyboard
 * input, ANSI/VT output, and resize negotiation.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { spawn as spawnPty, type IPty } from '@lydell/node-pty';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createLogger,
  getDataDir,
  isInside,
  killProcessTree,
  loadEffectiveRoots,
} from '@flujo-ai/mcp-shared';

const BASH_SERVER_NAME = 'bash';
export const BASH_TERMINAL_APP_URI = 'ui://bash/terminal';

const log = createLogger('backend/services/mcp/internal/bashTools');

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Foreground commands and `wait` calls may wrap builds, renders, migrations,
 * and other jobs that take far longer than the historical ten-minute ceiling.
 * Keep a finite default safety ceiling, aligned with the background-session
 * lifetime, while allowing deployments to lower or raise it. Passing -1
 * disables this Bash-side timer; cancellation and shutdown still clean up.
 */
const DEFAULT_MAX_TIMEOUT_MS = 12 * 60 * 60_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_SESSIONS = 25;
const MAX_TERMINAL_OUTPUT_CHARS = 2_000_000;
/**
 * Lifecycle (issue #413): a live session ends by process exit, explicit kill,
 * OWNER RELEASE when its run finishes, idle/max-lifetime expiry, or Bash server
 * shutdown. Finished owner-scoped records remain readable for ten minutes, then
 * are reaped. An MCP View teardown may be an inline-to-dock handoff, so it is
 * still not treated as an owner disconnect signal.
 *
 * Owner release is what closes the original leak: nothing used to tell this
 * server that the run which started a background command had ended, so a
 * `start`ed process (and its whole descendant tree) outlived its run and stayed
 * resident for the lifetime of the FLUJO process.
 */
const SESSION_TTL_MS = 10 * 60_000;
/**
 * Host-wide cap across background AND terminal sessions. The per-owner cap alone
 * could not bound the machine: N concurrent runs each stayed under their own
 * limit while together they forked an unbounded number of live trees.
 */
const MAX_LIVE_SESSIONS_HOST = 50;
/** A live session with no reads/writes/output for this long is expired. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60_000;
/** Absolute ceiling on a live session's age, idle or not. */
const SESSION_MAX_LIFETIME_MS = 12 * 60 * 60_000;
/** How often the expiry sweep runs. */
const SESSION_SWEEP_INTERVAL_MS = 60_000;

function positiveEnvNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function maxLiveSessionsHost(): number {
  return Math.floor(positiveEnvNumber('FLUJO_BASH_MAX_LIVE_SESSIONS', MAX_LIVE_SESSIONS_HOST));
}

function sessionIdleTimeoutMs(): number {
  return positiveEnvNumber('FLUJO_BASH_SESSION_IDLE_MS', SESSION_IDLE_TIMEOUT_MS);
}

function sessionMaxLifetimeMs(): number {
  return positiveEnvNumber('FLUJO_BASH_SESSION_MAX_LIFETIME_MS', SESSION_MAX_LIFETIME_MS);
}

function commandMaxTimeoutMs(): number {
  return positiveEnvNumber('FLUJO_BASH_COMMAND_MAX_TIMEOUT_MS', DEFAULT_MAX_TIMEOUT_MS);
}

/** `undefined` means no Bash-side timeout (the explicit timeout=-1 contract). */
function resolveCommandTimeoutMs(value: unknown): number | undefined {
  if (value === -1) return undefined;
  const requested = typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value * 1_000
    : DEFAULT_TIMEOUT_MS;
  return Math.min(requested, commandMaxTimeoutMs());
}

/** Test seam for the public timeout contract; not used by the runtime. */
export function _resolveCommandTimeoutMsForTests(value: unknown): number | undefined {
  return resolveCommandTimeoutMs(value);
}

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
  const resolved = path.resolve(candidate).toLowerCase();
  // The legacy WSL relay may be reached through System32, SysWOW64, or a
  // SystemRoot-relative shim. It is not a usable POSIX interpreter without a
  // provisioned distro, so never select it as the Bash MCP's `bash` shell.
  if (systemRoot && resolved.startsWith(`${path.resolve(systemRoot).toLowerCase()}${path.sep}`)
    && path.basename(resolved) === 'bash.exe') return true;
  return /[\\/]WindowsApps[\\/].*wsl.*[\\/]bash\.exe$/i.test(resolved);
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

function resolveShExecutable(): string | null {
  if (process.platform === 'win32') return findExecutableOnPath('sh');
  return firstExistingFile(['/bin/sh', findExecutableOnPath('sh')]);
}

/**
 * Interpreters and utilities probed by `shell_info` (issue #364) so a caller can
 * discover the machine up front instead of rediscovering it by failed commands.
 */
const PROBED_BINARIES = [
  'python', 'python3', 'node', 'npm', 'npx', 'git', 'rg',
  'ffmpeg', 'ffprobe', 'curl', 'tar', 'grep', 'sed', 'awk', 'head', 'tail',
];

export interface ShellInfoShellEntry {
  shell: string;
  available: boolean;
  path: string | null;
}

export interface ShellInfoBinaryEntry {
  name: string;
  found: boolean;
  path: string | null;
  /** Windows Store app-execution alias stub: present on PATH but not runnable. */
  alias?: boolean;
}

export interface ShellInfoPayload {
  platform: NodeJS.Platform;
  defaultShell: EffectiveShell;
  defaultShellPath: string | null;
  shells: ShellInfoShellEntry[];
  binaries: ShellInfoBinaryEntry[];
  notes: string[];
}

/**
 * A zero-byte Windows Store app-execution alias (typically `python3.exe` under
 * `WindowsApps`) resolves on PATH but only opens the Store when executed.
 */
function isWindowsStoreAliasStub(candidate: string | null): boolean {
  if (!candidate || process.platform !== 'win32') return false;
  if (!/[\\/]WindowsApps[\\/]/i.test(candidate)) return false;
  try {
    return fs.statSync(candidate).size === 0;
  } catch {
    return true;
  }
}

function shellEntry(shell: string, resolved: string | null): ShellInfoShellEntry {
  return { shell, available: Boolean(resolved), path: resolved };
}

let cachedShellInfo: ShellInfoPayload | undefined;

/** Describe the shells and interpreters actually available on this machine. */
export function collectShellInfo(): ShellInfoPayload {
  if (cachedShellInfo) return cachedShellInfo;
  const defaultPlan = buildSpawn('', 'default');
  const shells: ShellInfoShellEntry[] = [
    shellEntry('pwsh', resolvePwshExecutable()),
    shellEntry('powershell', resolveWindowsPowerShellExecutable()),
    shellEntry('bash', resolveBashExecutable()),
    shellEntry('cmd', resolveCmdExecutable()),
    shellEntry('sh', resolveShExecutable()),
  ];
  const binaries: ShellInfoBinaryEntry[] = PROBED_BINARIES.map((name) => {
    const resolved = findExecutableOnPath(name);
    if (isWindowsStoreAliasStub(resolved)) {
      return { name, found: false, path: resolved, alias: true };
    }
    return { name, found: Boolean(resolved), path: resolved };
  });
  const notes = [
    'Tool output merges stdout and stderr into one "output" field; "isError" reflects the process exit code only.',
    `The "default" shell on this machine is "${defaultPlan.effectiveShell}".`,
    'Pass shell:"bash" for POSIX syntax (&&, pipes into head/grep, $(…)); an unavailable explicit shell fails fast.',
  ];
  if (!shells.find((entry) => entry.shell === 'pwsh')?.available
    && shells.find((entry) => entry.shell === 'powershell')?.available) {
    notes.push('Only Windows PowerShell 5.1 is installed: "&&" and "||" are not valid statement separators there.');
  }
  cachedShellInfo = {
    platform: process.platform,
    defaultShell: defaultPlan.effectiveShell,
    defaultShellPath: defaultPlan.file || null,
    shells,
    binaries,
    notes,
  };
  return cachedShellInfo;
}

function availableShellNames(): string[] {
  return collectShellInfo().shells.filter((entry) => entry.available).map((entry) => entry.shell);
}

function unavailableShellHint(shell: Exclude<ShellKind, 'default'>): string {
  if (shell === 'bash' && process.platform === 'win32'
    && findExecutablesOnPath('bash').some(isWindowsWslBashLauncher)) {
    return 'Only the WSL bash launcher was found and no Linux distribution provides /bin/bash. Install Git for Windows (Git Bash) or a WSL distro.';
  }
  return 'Call "shell_info" to see which shells and interpreters exist on this machine.';
}

function shellInfoTool(): CallToolResult {
  return textResult(collectShellInfo());
}

/** Test-only: forget cached shell-executable lookups. */
export function _resetBashShellCacheForTests(): void {
  cachedBashPath = undefined;
  cachedPwshPath = undefined;
  cachedWindowsPowerShellPath = undefined;
  cachedShellInfo = undefined;
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
  /** Characters that arrived on stderr (logging volume, not failure).  */
  stderrChars?: number;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  cancelEscalation?: () => void;
  reapTimer?: NodeJS.Timeout;
  /** Preflight found a command head that cannot be resolved on PATH. */
  missingExecutableWarning?: boolean;
  /**
   * Explicit opt-in to surviving owner release (issue #413). Default false: a
   * session outliving its run must be a deliberate choice, not the accident that
   * made every `start` a permanent process.
   */
  detached?: boolean;
  /** Last output/read/write — drives idle expiry. */
  lastActivityAt: number;
}

interface TerminalSession {
  id: string;
  ownerScope: string;
  shell: EffectiveShell;
  cwd: string;
  pty: IPty;
  output: string;
  outputStart: number;
  nextCursor: number;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  reapTimer?: NodeJS.Timeout;
  /** Explicit opt-in to surviving owner release (issue #413). */
  detached?: boolean;
  /** Last output/read/write — drives idle expiry. */
  lastActivityAt: number;
}

// Process-global so all Next.js module-graph instances share one session table
// (same rationale as __mcp_clients in index.ts) and the exit-cleanup runs once.
declare global {
  var __flujo_bash_sessions: Map<string, BashSession> | undefined;
  var __flujo_terminal_sessions: Map<string, TerminalSession> | undefined;
  var __flujo_bash_foreground_children: Set<ChildProcess> | undefined;
  var __flujo_bash_cleanup_registered: boolean | undefined;
  var __flujo_bash_sweep_timer: NodeJS.Timeout | undefined;
}

function sessions(): Map<string, BashSession> {
  if (!global.__flujo_bash_sessions) global.__flujo_bash_sessions = new Map<string, BashSession>();
  return global.__flujo_bash_sessions;
}

function terminalSessions(): Map<string, TerminalSession> {
  if (!global.__flujo_terminal_sessions) global.__flujo_terminal_sessions = new Map<string, TerminalSession>();
  return global.__flujo_terminal_sessions;
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

/** Mark a session as active so the idle sweep leaves it alone. */
function touchSession(session: { lastActivityAt: number }): void {
  session.lastActivityAt = Date.now();
}

/** Live sessions across BOTH tables — the quantity the host cap bounds. */
function liveSessionCount(): number {
  let count = 0;
  for (const session of sessions().values()) if (session.running) count += 1;
  for (const terminal of terminalSessions().values()) if (terminal.running) count += 1;
  return count;
}

/** Live sessions for one owner across both tables. */
function ownerLiveSessionCount(ownerScope: string): number {
  let count = 0;
  for (const session of sessions().values()) {
    if (session.running && session.ownerScope === ownerScope) count += 1;
  }
  for (const terminal of terminalSessions().values()) {
    if (terminal.running && terminal.ownerScope === ownerScope) count += 1;
  }
  return count;
}

/** Terminate one background session's whole process tree and drop its timers. */
function terminateSession(session: BashSession): void {
  if (session.running) {
    try {
      session.cancelEscalation = killProcessTree(session.child);
    } catch {
      /* best-effort */
    }
  }
  if (session.reapTimer) {
    clearTimeout(session.reapTimer);
    session.reapTimer = undefined;
  }
}

/** Terminate one PTY session and drop its timers. */
function terminateTerminal(terminal: TerminalSession): void {
  try {
    if (terminal.running) {
      terminal.running = false;
      terminal.pty.kill();
    }
  } catch {
    /* best-effort */
  }
  if (terminal.reapTimer) {
    clearTimeout(terminal.reapTimer);
    terminal.reapTimer = undefined;
  }
}

export interface OwnerReleaseResult {
  ownerScope: string;
  /** Background session ids that were killed. */
  killedSessions: string[];
  /** PTY session ids that were closed. */
  closedTerminals: string[];
  /** Sessions deliberately left alive because they opted into `detached`. */
  retainedDetached: string[];
}

/**
 * Atomically remove and terminate every NON-DETACHED session of one owner.
 *
 * Called when the owning FLUJO run reaches a terminal state. Removing the map
 * entry BEFORE killing means a concurrent release (or a second call from a retry
 * path) cannot observe the same session twice, so the operation is idempotent -
 * repeated releases of the same scope are a no-op instead of a double kill
 * against a possibly-recycled pid.
 */
export function releaseOwnerScope(ownerScope: string): OwnerReleaseResult {
  const result: OwnerReleaseResult = {
    ownerScope,
    killedSessions: [],
    closedTerminals: [],
    retainedDetached: [],
  };

  for (const [id, session] of Array.from(sessions())) {
    if (session.ownerScope !== ownerScope) continue;
    if (session.detached) {
      if (session.running) result.retainedDetached.push(id);
      continue;
    }
    sessions().delete(id);
    if (session.running) result.killedSessions.push(id);
    terminateSession(session);
  }

  for (const [id, terminal] of Array.from(terminalSessions())) {
    if (terminal.ownerScope !== ownerScope) continue;
    if (terminal.detached) {
      if (terminal.running) result.retainedDetached.push(id);
      continue;
    }
    terminalSessions().delete(id);
    if (terminal.running) result.closedTerminals.push(id);
    terminateTerminal(terminal);
  }

  if (result.killedSessions.length || result.closedTerminals.length) {
    log.info('Released owner-scoped bash sessions', {
      ownerScope,
      killed: result.killedSessions.length,
      closedTerminals: result.closedTerminals.length,
      retainedDetached: result.retainedDetached.length,
    });
  }
  return result;
}

/**
 * Expire live sessions that exceeded the idle timeout or the absolute lifetime.
 *
 * Detached sessions are exempt from IDLE expiry (being idle is often the point of
 * a detached watcher) but NOT from the absolute lifetime ceiling - otherwise
 * `detached` would be an unbounded leak with extra steps.
 */
export function expireStaleSessions(now = Date.now()): string[] {
  const idleLimit = sessionIdleTimeoutMs();
  const lifetimeLimit = sessionMaxLifetimeMs();
  const expired: string[] = [];

  for (const [id, session] of Array.from(sessions())) {
    if (!session.running) continue;
    const tooOld = now - session.startedAt >= lifetimeLimit;
    const tooIdle = !session.detached && now - session.lastActivityAt >= idleLimit;
    if (!tooOld && !tooIdle) continue;
    sessions().delete(id);
    terminateSession(session);
    expired.push(id);
  }

  for (const [id, terminal] of Array.from(terminalSessions())) {
    if (!terminal.running) continue;
    const tooOld = now - terminal.startedAt >= lifetimeLimit;
    const tooIdle = !terminal.detached && now - terminal.lastActivityAt >= idleLimit;
    if (!tooOld && !tooIdle) continue;
    terminalSessions().delete(id);
    terminateTerminal(terminal);
    expired.push(id);
  }

  if (expired.length) log.info('Expired stale bash sessions', { count: expired.length });
  return expired;
}

/** Bounded per-session diagnostics: identity/state only, never output. */
export function bashSessionDiagnostics(): {
  liveSessions: number;
  maxLiveSessions: number;
  sessions: Array<{
    sessionId: string;
    type: 'background' | 'terminal';
    ownerScope: string;
    running: boolean;
    detached: boolean;
    ageMs: number;
    idleMs: number;
  }>;
} {
  const now = Date.now();
  const rows: Array<{
    sessionId: string;
    type: 'background' | 'terminal';
    ownerScope: string;
    running: boolean;
    detached: boolean;
    ageMs: number;
    idleMs: number;
  }> = [];
  for (const session of sessions().values()) {
    rows.push({
      sessionId: session.id,
      type: 'background',
      ownerScope: session.ownerScope,
      running: session.running,
      detached: session.detached === true,
      ageMs: now - session.startedAt,
      idleMs: now - session.lastActivityAt,
    });
  }
  for (const terminal of terminalSessions().values()) {
    rows.push({
      sessionId: terminal.id,
      type: 'terminal',
      ownerScope: terminal.ownerScope,
      running: terminal.running,
      detached: terminal.detached === true,
      ageMs: now - terminal.startedAt,
      idleMs: now - terminal.lastActivityAt,
    });
  }
  return {
    liveSessions: liveSessionCount(),
    maxLiveSessions: maxLiveSessionsHost(),
    sessions: rows,
  };
}

function terminalMeta(visibility: Array<'model' | 'app'> = ['model', 'app']): Tool['_meta'] {
  return { ui: { resourceUri: BASH_TERMINAL_APP_URI, visibility } };
}

/**
 * Kill every live session's process tree - used on Bash server shutdown and on
 * FLUJO process exit.
 *
 * Idempotent and DETACHED-INCLUSIVE: a detached session survives owner release,
 * but nothing survives the death of the server that owns its pipes. Timers are
 * cleared too, so a repeated call cannot leave a handle keeping the event loop
 * alive after "shutdown".
 */
export function shutdownBashSessions(): void {
  if (global.__flujo_bash_sweep_timer) {
    clearInterval(global.__flujo_bash_sweep_timer);
    global.__flujo_bash_sweep_timer = undefined;
  }
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
    if (s.reapTimer) {
      clearTimeout(s.reapTimer);
      s.reapTimer = undefined;
    }
  }
  for (const terminal of terminalSessions().values()) {
    try {
      if (terminal.running) {
        terminal.running = false;
        terminal.pty.kill();
      }
    } catch {
      /* best-effort */
    }
    if (terminal.reapTimer) {
      clearTimeout(terminal.reapTimer);
      terminal.reapTimer = undefined;
    }
  }
}

function registerExitCleanup(): void {
  if (!global.__flujo_bash_sweep_timer) {
    // Idle/max-lifetime expiry needs a periodic sweep: a session that simply
    // stops producing output never fires an event we could hang the check on.
    const timer = setInterval(() => {
      try {
        expireStaleSessions();
      } catch {
        /* a sweep failure must never crash the server */
      }
    }, SESSION_SWEEP_INTERVAL_MS);
    timer.unref?.();
    global.__flujo_bash_sweep_timer = timer;
  }
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

  if (roots.length === 0 || !roots.some((root) => isInside(root, resolved))) {
    throw new Error(`cwd "${resolved}" is outside the configured bash roots.`);
  }
  return resolved;
}

/**
 * Resolve an `outputFile` spool target under the same confinement rules as
 * `cwd` (issue #364) and make sure its parent directory exists.
 */
async function resolveOutputFile(input: unknown, cwd: string, roots: string[]): Promise<string> {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('"outputFile" must be a non-empty path.');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
  if (roots.length === 0 || !roots.some((root) => isInside(root, resolved))) {
    throw new Error(`outputFile "${resolved}" is outside the configured bash roots.`);
  }
  await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
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
  // Non-secret FLUJO installation-root marker. A command that launches FLUJO
  // must not reinterpret this Bash server's workspace-scoped FLUJO_DATA_DIR as
  // the parent of a second `workspaces/<workspace>` namespace.
  'flujo_parent_data_dir', 'flujo_workspace',
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
 * Read an env var case-insensitively, treating a blank value as absent. FLUJO
 * launches this server with an explicit `env`, so vars can arrive defined but
 * empty; an empty `ComSpec` is just as fatal as a missing one.
 */
function getNonEmptyEnv(name: string): string | undefined {
  const value = getEnvCaseInsensitive(name);
  return value && value.trim() !== '' ? value : undefined;
}

/**
 * Ensure a Windows env var the child toolchain needs is present exactly once.
 * A spelling that already carries a value wins, so a script reading `%windir%`
 * or `$SYSTEMROOT` keeps seeing the name it was given; blank spellings are
 * deleted first, because Node de-duplicates Windows env keys case-insensitively
 * and must not settle on the empty one.
 */
function ensureWindowsEnvDefault(
  target: NodeJS.ProcessEnv,
  key: string,
  value: string | undefined,
): void {
  if (!value) return;
  const spellings = Object.keys(target).filter(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  if (spellings.some((candidate) => (target[candidate] ?? '').trim() !== '')) return;
  for (const candidate of spellings) delete target[candidate];
  target[key] = value;
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
    // Windows essentials that must exist for the child to launch anything of
    // its own. FLUJO passes stdio servers an explicit `env` and the MCP SDK's
    // default Windows inherit list carries neither ComSpec nor windir, so these
    // are absent here even though ENV_ALLOWLIST would have kept them.
    // `npm run <script>` is the casualty: npm resolves its script shell from
    // `process.env.ComSpec` with no fallback of its own, so a blank one makes it
    // ask Node to spawn `undefined` and die with ERR_INVALID_ARG_TYPE — after
    // printing its banner but before emitting one line of diagnostics, which is
    // why `npm run test:mcp` looked like a silent, empty failure.
    const systemRoot = getNonEmptyEnv('SystemRoot') ?? getNonEmptyEnv('windir') ?? 'C:\\Windows';
    ensureWindowsEnvDefault(out, 'SystemRoot', systemRoot);
    ensureWindowsEnvDefault(out, 'windir', systemRoot);
    ensureWindowsEnvDefault(
      out,
      'SystemDrive',
      getNonEmptyEnv('SystemDrive') ?? path.parse(systemRoot).root.replace(/[\\/]$/, ''),
    );
    ensureWindowsEnvDefault(
      out,
      'ComSpec',
      resolveCmdExecutable() ?? path.join(systemRoot, 'System32', 'cmd.exe'),
    );
  }
  // Deterministic text encoding and number formatting for children (issue #364):
  // without this, interpreters emit locale-dependent decimal commas and non-UTF-8
  // bytes that come back as mojibake. Explicit per-call `env` still wins below.
  if (out.PYTHONIOENCODING === undefined) out.PYTHONIOENCODING = 'utf-8';
  if (process.platform !== 'win32') {
    if (!out.LANG) out.LANG = 'C.UTF-8';
    if (!out.LC_ALL) out.LC_ALL = 'C.UTF-8';
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

/**
 * PowerShell prelude (issue #364). It makes three platform traps go away for
 * every command we run:
 *   - stderr from a native binary no longer turns into a terminating error, so
 *     the reported exit code is the native process' own,
 *   - console output is forced to UTF-8 (otherwise logs come back as UTF-16 or
 *     OEM mojibake),
 *   - the culture is pinned to invariant, so numbers never use a decimal comma.
 * The epilogue re-surfaces the native exit code (`$LASTEXITCODE`), falling back
 * to `$?` when no native command ran.
 */
const POWERSHELL_PRELUDE = [
  "$ErrorActionPreference='Continue'",
  "$ProgressPreference='SilentlyContinue'",
  'try { [Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8 } catch {}',
  'try { [Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::InvariantCulture;'
    + ' [Threading.Thread]::CurrentThread.CurrentUICulture=[Globalization.CultureInfo]::InvariantCulture } catch {}',
].join('; ');

const POWERSHELL_EPILOGUE = 'exit $(if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 })';

export function wrapPowerShellCommand(command: string): string {
  return `${POWERSHELL_PRELUDE}\n${command}\n${POWERSHELL_EPILOGUE}`;
}

/** `chcp 65001` forces UTF-8 output for cmd.exe children (issue #364). */
export function wrapCmdCommand(command: string): string {
  return `chcp 65001>nul & ${command}`;
}

function powerShellArgs(command: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapPowerShellCommand(command)];
}

interface SpawnPlan {
  file: string;
  args: string[];
  useShell: boolean;
  effectiveShell: EffectiveShell;
  windowsVerbatimArguments?: boolean;
  /** Explicit shell lookup failed before any user command was executed. */
  unavailableShell?: Exclude<ShellKind, 'default'>;
  shellSubstitution?: { requested: 'pwsh'; used: 'powershell'; reason: string };
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
      return { file: resolved, args: powerShellArgs(command), useShell: false, effectiveShell: 'pwsh' };
    }
    const windowsPowerShell = resolveWindowsPowerShellExecutable();
    if (windowsPowerShell) {
      return {
        file: windowsPowerShell,
        args: powerShellArgs(command),
        useShell: false,
        effectiveShell: 'powershell',
        shellSubstitution: {
          requested: 'pwsh', used: 'powershell',
          reason: 'PowerShell 7 (pwsh) is not installed on this machine.',
        },
      };
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
        args: ['/d', '/s', '/c', wrapCmdCommand(command)],
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
      return { file: pwsh, args: powerShellArgs(command), useShell: false, effectiveShell: 'pwsh' };
    }
    const windowsPowerShell = resolveWindowsPowerShellExecutable();
    if (windowsPowerShell) {
      return { file: windowsPowerShell, args: powerShellArgs(command), useShell: false, effectiveShell: 'powershell' };
    }
    const cmd = resolveCmdExecutable();
    if (cmd) {
      return {
        file: cmd,
        args: ['/d', '/s', '/c', wrapCmdCommand(command)],
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
  shellSubstitution?: SpawnPlan['shellSubstitution'];
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
    shellSubstitution,
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
    return { child, effectiveShell, shellSubstitution };
  } catch (err) {
    return {
      startError: err instanceof Error ? err.message : String(err),
      effectiveShell,
    };
  }
}

export interface OutputAppender {
  (chunk: string): void;
  /** Total characters ever appended, including any omitted middle. */
  totalChars: () => number;
  /** Characters dropped from the middle because of the cap. */
  droppedChars: () => number;
}

/**
 * Bounded output accumulator (issue #364). Retention is head + tail rather than
 * head-only, so the command echo at the start AND the final result at the end
 * both survive an output flood (e.g. a 50k-line ffmpeg progress log); the
 * omitted middle is reported explicitly.
 */
function makeAppender(
  get: () => string,
  set: (v: string, truncated: boolean) => void,
  maxChars = MAX_OUTPUT_CHARS,
): OutputAppender {
  const limit = Math.max(1_000, Math.min(Math.floor(maxChars) || MAX_OUTPUT_CHARS, MAX_OUTPUT_CHARS));
  const headLimit = Math.max(1, Math.floor(limit * 0.3));
  const tailLimit = Math.max(1, limit - headLimit);
  let head = '';
  let tail = '';
  let dropped = 0;
  let total = 0;
  const compose = () => (dropped > 0
    ? head + '\n…[' + dropped + ' characters of output omitted]…\n' + tail
    : head + tail);
  const append = ((chunk: string) => {
    if (!chunk) return;
    total += chunk.length;
    let rest = chunk;
    if (head.length < headLimit) {
      const take = Math.min(headLimit - head.length, rest.length);
      head += rest.slice(0, take);
      rest = rest.slice(take);
    }
    if (rest) {
      tail += rest;
      if (tail.length > tailLimit) {
        const remove = tail.length - tailLimit;
        tail = tail.slice(remove);
        dropped += remove;
      }
    }
    set(compose(), dropped > 0);
  }) as OutputAppender;
  append.totalChars = () => total;
  append.droppedChars = () => dropped;
  // `get` is retained for call-site symmetry with the previous signature.
  void get;
  return append;
}

/**
 * Shell-dialect trap detection (issue #364). Commands are NEVER rewritten —
 * translating shell text between dialects is far riskier than executing what
 * the caller wrote — so every finding is returned as an advisory
 * `dialectWarnings` entry with a concrete suggested fix.
 */
const POSIX_ONLY_BINARIES = new Set([
  'head', 'tail', 'grep', 'sed', 'awk', 'wc', 'cat', 'cut', 'tr', 'uniq', 'sort', 'xargs', 'touch', 'which',
  'rg', 'jq', 'find', 'ls', 'pwd', 'less', 'du', 'df',
]);

const SHELL_BUILTINS = new Set([
  'cd', 'echo', 'exit', 'export', 'set', 'unset', 'if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done',
  'true', 'false', 'test', 'type', 'alias', 'function', 'return', 'shift', 'source', '.', 'dir', 'cls',
  'copy', 'del', 'erase', 'md', 'mkdir', 'rd', 'rmdir', 'move', 'ren', 'rename', 'pushd', 'popd',
]);

function isMissingCommandCandidate(head: string, shell: EffectiveShell): boolean {
  const name = path.basename(head).toLowerCase().replace(/\.exe$/, '');
  if (!name || SHELL_BUILTINS.has(name) || /^[-/$]/.test(head) || /^[A-Za-z_][\w-]*=/.test(head)) return false;
  if (/^[A-Za-z]+-[A-Za-z][A-Za-z-]*$/.test(head) && (shell === 'pwsh' || shell === 'powershell')) return false;
  return !/[\\/]/.test(head) && !/^\.?\.?$/.test(head);
}

/** Blank out quoted spans so operators inside string literals never trip us. */
function stripQuotedSegments(command: string): string {
  return command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (match) => ' '.repeat(match.length));
}

function commandSegmentHeads(stripped: string): string[] {
  return stripped
    .split(/&&|\|\||[|;\n]/)
    .map((segment) => segment.trim().split(/\s+/)[0] ?? '')
    .map((head) => head.replace(/^[('"`]+/, ''))
    .filter(Boolean);
}

/** True when the command relies on POSIX `&&` / `||` statement chaining. */
export function commandUsesPosixChaining(command: string): boolean {
  return /&&|\|\|/.test(stripQuotedSegments(command));
}

export function detectDialectMismatch(
  command: string,
  shell: EffectiveShell,
  isAvailable: (name: string) => boolean = (name) => Boolean(findExecutableOnPath(name)),
): string[] {
  const warnings: string[] = [];
  const stripped = stripQuotedSegments(command);
  const heads = commandSegmentHeads(stripped);
  const posixShell = shell === 'bash' || shell === 'sh';

  if (!posixShell) {
    for (const head of new Set(heads)) {
      const name = path.basename(head).toLowerCase().replace(/\.exe$/, '');
      if (!isMissingCommandCandidate(head, shell) || isAvailable(name)) continue;
      if (POSIX_ONLY_BINARIES.has(name)) {
        warnings.push(
          `"${name}" is a POSIX utility and is not available as an executable on this machine; `
          + `under ${shell} it resolves to nothing (or to an unrelated alias). Pass shell:"bash" or use the native equivalent.`
        );
      } else {
        warnings.push(
          `"${name}" was not found on PATH; under ${shell} this will fail with a "command not found" error. `
          + 'Install it, use the native equivalent, or call "shell_info".'
        );
      }
    }
  }

  if (shell === 'powershell' && /&&|\|\|/.test(stripped)) {
    warnings.push(
      '"&&" and "||" are not statement separators in Windows PowerShell 5.1 (they are a parse error). '
      + 'Use ";" for unconditional chaining, or pass shell:"bash" / shell:"pwsh".'
    );
  }

  if (shell === 'pwsh' || shell === 'powershell') {
    if (/\$\(\s*([A-Za-z_][\w-]*)/.test(stripped)) {
      const inner = /\$\(\s*([A-Za-z_][\w-]*)/.exec(stripped)?.[1] ?? '';
      if (POSIX_ONLY_BINARIES.has(inner.toLowerCase()) && !isAvailable(inner.toLowerCase())) {
        warnings.push(
          `"$(${inner} …)" is POSIX command substitution; PowerShell evaluates it as a subexpression `
          + 'and cannot run that utility. Pass shell:"bash".'
        );
      }
    }
    if ((stripped.match(/`/g) ?? []).length >= 2) {
      warnings.push(
        'Backticks are the line-continuation/escape character in PowerShell, not command substitution. '
        + 'Use "$(…)" for PowerShell, or pass shell:"bash".'
      );
    }
    if (/2>&1/.test(stripped)) {
      warnings.push(
        'No "2>&1" redirection is needed: this tool already merges stdout and stderr into one "output" field, '
        + 'and "isError" is derived from the exit code only.'
      );
    }
  }

  if (shell === 'cmd') {
    if (/'/.test(command.replace(/"(?:\\.|[^"\\])*"/g, ''))) {
      warnings.push('cmd.exe does not treat single quotes as string delimiters; use double quotes.');
    }
    if (/\$\(|`/.test(stripped)) {
      warnings.push('Command substitution ($(…) / backticks) is not supported by cmd.exe. Pass shell:"bash" or shell:"pwsh".');
    }
  }

  if (posixShell && /\b(?:Get|Set|New|Remove|Write|Select|Out|Format|Test|Invoke|Start|Stop)-[A-Z][A-Za-z]+\b/.test(stripped)) {
    warnings.push('This looks like a PowerShell cmdlet but the command is running under a POSIX shell. Pass shell:"pwsh".');
  }

  return warnings;
}

function missingExecutableHint(exitCode: number | null, warnings: string[]): Record<string, string> {
  if ((exitCode === 9009 || exitCode === 255 || exitCode === 1)
    && warnings.some((warning) => /not found on PATH|not available as an executable/.test(warning))) {
    return { hint: 'A referenced executable was not found — see dialectWarnings.' };
  }
  return {};
}

/** Commands that typically hang forever waiting on a pager or interactive prompt. */
export function detectInteractiveHangRisk(command: string): string[] {
  const hints: string[] = [];
  const stripped = stripQuotedSegments(command);
  if (/\bgit\b(?![^|;]*--no-pager)[^|;]*\b(?:log|diff|show|branch)\b/.test(stripped)) {
    hints.push('git paginates by default; use "git --no-pager …" (or append "| cat") for non-interactive runs.');
  }
  if (/(^|[|;\s])(?:less|more)(\s|$)/.test(stripped)) {
    hints.push('"less"/"more" are interactive pagers and will never exit here; drop them.');
  }
  if (/Format-(?:Table|List)\b/.test(stripped) && !/Out-String/.test(stripped)) {
    hints.push('Pipe Format-Table/Format-List into "| Out-String" so PowerShell does not wait on the host formatter.');
  }
  if (/(^|[|;\s])(?:npm|yarn|pnpm)\s+(?:init|login)(\s|$)/.test(stripped)) {
    hints.push('This command prompts interactively; add its non-interactive flag (e.g. "npm init -y").');
  }
  return hints;
}

export type OutputEncodingMode = 'utf8' | 'utf16le' | 'auto';

function validateEncoding(input: unknown): OutputEncodingMode | null {
  if (input === undefined) return 'auto';
  if (input === 'utf8' || input === 'utf16le' || input === 'auto') return input;
  return null;
}

function looksLikeUtf16le(buf: Buffer): boolean {
  const len = Math.min(buf.length, 64);
  if (len < 4) return false;
  let nuls = 0;
  for (let i = 0; i < len; i += 1) if (buf[i] === 0) nuls += 1;
  return nuls / len > 0.3;
}

/**
 * Decode child output deterministically (issue #364). Windows tooling happily
 * writes UTF-16LE (e.g. PowerShell redirection into a log) which the default
 * UTF-8 decode turns into NUL-riddled mojibake. `auto` sniffs a BOM or a high
 * NUL ratio in the first chunk and then stays with that choice.
 */
export function createStreamDecoder(mode: OutputEncodingMode = 'auto'): (chunk: Buffer | string) => string {
  let resolved: 'utf8' | 'utf16le' | null = mode === 'auto' ? null : mode;
  let first = true;
  return (chunk: Buffer | string): string => {
    if (typeof chunk === 'string') return chunk;
    let buf = chunk;
    if (first) {
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
        if (resolved === null) resolved = 'utf16le';
        if (resolved === 'utf16le') buf = buf.subarray(2);
      } else if (resolved === null) {
        resolved = looksLikeUtf16le(buf) ? 'utf16le' : 'utf8';
      }
      first = false;
    }
    let text = buf.toString(resolved ?? 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  };
}

interface PtySpawnPlan {
  file: string;
  args: string[];
  effectiveShell: EffectiveShell;
  unavailableShell?: Exclude<ShellKind, 'default'>;
  startError?: string;
}

/** Resolve an interactive shell executable without wrapping a command string. */
function buildPtySpawn(shell: ShellKind): PtySpawnPlan {
  if (shell === 'pwsh') {
    const file = resolvePwshExecutable();
    return file
      ? { file, args: ['-NoLogo'], effectiveShell: 'pwsh' }
      : { file: '', args: [], effectiveShell: 'pwsh', unavailableShell: 'pwsh' };
  }
  if (shell === 'bash') {
    const file = resolveBashExecutable();
    return file
      ? { file, args: ['--noprofile', '--norc', '-i'], effectiveShell: 'bash' }
      : { file: '', args: [], effectiveShell: 'bash', unavailableShell: 'bash' };
  }
  if (shell === 'cmd') {
    const file = resolveCmdExecutable();
    return file
      ? { file, args: ['/d', '/q'], effectiveShell: 'cmd' }
      : { file: '', args: [], effectiveShell: 'cmd', unavailableShell: 'cmd' };
  }
  if (process.platform === 'win32') {
    const pwsh = resolvePwshExecutable();
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], effectiveShell: 'pwsh' };
    const powershell = resolveWindowsPowerShellExecutable();
    if (powershell) return { file: powershell, args: ['-NoLogo'], effectiveShell: 'powershell' };
    const cmd = resolveCmdExecutable();
    if (cmd) return { file: cmd, args: ['/d', '/q'], effectiveShell: 'cmd' };
    return { file: '', args: [], effectiveShell: 'cmd', startError: 'No usable PowerShell or cmd executable was found.' };
  }
  const loginShell = getEnvCaseInsensitive('SHELL');
  const bash = resolveBashExecutable();
  const file = firstExistingFile([loginShell, bash, '/bin/sh', findExecutableOnPath('sh')]);
  if (!file) return { file: '', args: [], effectiveShell: 'sh', startError: 'No interactive POSIX shell was found.' };
  const isBash = path.basename(file).toLowerCase().startsWith('bash');
  return {
    file,
    args: isBash ? ['--noprofile', '--norc', '-i'] : ['-i'],
    effectiveShell: isBash ? 'bash' : 'sh',
  };
}

function createCommandProgressReporter(context?: BashExecutionContext, heartbeatMs = 10_000): {
  push: (chunk: string) => void;
  stop: () => Promise<void>;
} {
  const report = context?.onProgress;
  if (!report) return { push: () => undefined, stop: async () => undefined };

  const startedAt = Date.now();
  const maxMessageChars = 4_000;
  // MCP requires `progress` to increase with every notification. It is a
  // notification sequence here (not a byte count), because silent-command
  // heartbeats must advance it too.
  let progress = 0;
  let pending = '';
  let flushTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let forwardedChars = 0;
  let liveOutputTruncated = false;
  let chain = Promise.resolve();

  const deliver = (message: string) => {
    if (!message) return;
    const snapshot = ++progress;
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
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    push: (chunk) => {
      if (stopped || !chunk) return;
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
      // The tool result must not overtake its final progress notification.
      // `chain` already catches reporter failures, so awaiting it cannot turn a
      // notification failure into a hung command. The previous one-second
      // escape hatch let the client tear down its progress handler first,
      // intermittently dropping the final output chunk (issue #457).
      await chain;
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
  const encodingProp = {
    type: 'string',
    enum: ['auto', 'utf8', 'utf16le'],
    description: 'How to decode child output. "auto" (default) detects UTF-16LE (BOM or NUL-heavy) and otherwise uses UTF-8.',
  };
  const maxOutputCharsProp = {
    type: 'number',
    description: 'Cap the returned output (default and hard maximum 100000 characters). When exceeded, the head and tail are kept and the omitted middle is reported.',
  };
  const outputFileProp = {
    type: 'string',
    description: 'Spool the full merged output to this file (confined to the configured roots) while the result stays bounded.',
  };
  return [
    {
      name: 'shell_info',
      description:
        'Describe this machine before running anything: platform, which shell "default" resolves to, which of pwsh/powershell/bash/cmd/sh are available, and whether common interpreters (python, node, git, ffmpeg, …) are on PATH. Call this instead of discovering the environment through failed commands.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'open_terminal',
      description: 'Open a real interactive pseudoterminal (PTY/ConPTY) and display its MCP App. Returns an owner-scoped terminal sessionId.',
      _meta: terminalMeta(['model', 'app']),
      inputSchema: {
        type: 'object',
        properties: {
          cwd: cwdProp,
          shell: shellProp,
          env: envProp,
          cols: { type: 'number', description: 'Initial terminal columns (20-400, default 100).' },
          rows: { type: 'number', description: 'Initial terminal rows (5-200, default 30).' },
          detached: {
            type: 'boolean',
            description:
              'Keep the terminal alive after the run that opened it finishes (default false). Still bounded by the host session cap and the absolute max lifetime.',
          },
        },
      },
    },
    {
      name: 'terminal_read',
      description: 'Read incremental ANSI/VT output from an owner-scoped interactive terminal session.',
      _meta: terminalMeta(['app']),
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          cursor: { type: 'number', description: 'Output cursor returned by the previous read.' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'terminal_write',
      description: 'Write raw keyboard or pasted input to an owner-scoped interactive terminal PTY.',
      _meta: terminalMeta(['app']),
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, data: { type: 'string' } },
        required: ['sessionId', 'data'],
      },
    },
    {
      name: 'terminal_resize',
      description: 'Resize an owner-scoped interactive terminal PTY.',
      _meta: terminalMeta(['app']),
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' }, cols: { type: 'number' }, rows: { type: 'number' } },
        required: ['sessionId', 'cols', 'rows'],
      },
    },
    {
      name: 'terminal_close',
      description: 'Close an owner-scoped interactive terminal PTY.',
      _meta: terminalMeta(['app']),
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
    },
    {
      name: 'terminal_list',
      description: 'List interactive terminal PTY sessions owned by this MCP App scope.',
      _meta: terminalMeta(['app']),
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'run',
      description:
        'Run one command to completion. "output" is stdout and stderr MERGED (no 2>&1 needed) and "isError" reflects the process exit code only — text on stderr is not a failure. '
        + 'On an unknown machine call "shell_info" first; prefer shell:"bash" for POSIX syntax (&&, pipes into head/grep). Output is UTF-8 decoded and PowerShell runs with invariant culture, so numbers and text are stable. '
        + 'Use start/status for a persistent background session.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command text in the selected shell\'s syntax.' },
          cwd: cwdProp,
          shell: shellProp,
          env: envProp,
          timeout: {
            type: 'number',
            description:
              'Bash-side timeout in seconds (default 60; -1 disables it; positive values are capped at 12 hours by default). '
              + 'While running, output and 10-second liveness heartbeats are sent as MCP progress. On timeout the whole process tree is killed.',
          },
          normalizeNewlines: { type: 'boolean', description: 'If true, CRLF/CR in the captured output are normalized to LF.' },
          encoding: encodingProp,
          maxOutputChars: maxOutputCharsProp,
          outputFile: outputFileProp,
        },
        required: ['command'],
      },
    },
    {
      name: 'start',
      description: 'Start an independent background command and return its sessionId. Output is stdout and stderr merged, decoded as UTF-8. Multiple sessions may run in parallel; use status/wait, write_stdin, or kill.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute in the background.' },
          cwd: cwdProp,
          shell: shellProp,
          env: envProp,
          encoding: encodingProp,
          maxOutputChars: maxOutputCharsProp,
          outputFile: outputFileProp,
          detached: {
            type: 'boolean',
            description:
              'Survive the end of the run that started it (default false). Detached sessions are still bounded by the host session cap and the absolute max lifetime, and are always killed when the bash server shuts down.',
          },
        },
        required: ['command'],
      },
    },
    {
      name: 'status',
      description: 'Return the current state of a background session: { sessionId, running, exitCode, output, truncated }.',
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'The id returned by start.' } },
        required: ['sessionId'],
      },
    },
    {
      name: 'wait',
      description:
        'Wait until a background session completes or the maximum timeout elapses, sending new output as live progress when supported. '
        + 'The timeout does not kill the session. A finite wait that completes early reports the remaining duration and points to sleep for fixed delays.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The id returned by start.' },
          timeout: {
            type: 'number',
            description:
              'Max seconds to wait (default 60; -1 waits until completion or cancellation; positive values are capped at 12 hours by default).',
          },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'sleep',
      description:
        'Wait for a fixed duration independent of background-session state. Use this instead of wait when the full delay must elapse even if a command finishes early.',
      inputSchema: {
        type: 'object',
        properties: {
          seconds: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Fixed positive number of seconds to sleep. Values above the configured Bash timeout ceiling are rejected rather than shortened.',
          },
        },
        required: ['seconds'],
      },
    },
    {
      name: 'write_stdin',
      description: 'Write a string to a running background session\'s stdin. Pass "newline": false to omit the trailing newline. Returns { sessionId, written }.',
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
      inputSchema: {
        type: 'object',
        properties: { sessionId: { type: 'string', description: 'The id returned by start.' } },
        required: ['sessionId'],
      },
    },
    {
      name: 'list_sessions',
      description: 'List background sessions owned by this caller scope. Returns { sessions: [{ sessionId, command, running, exitCode, detached, startedAt, endedAt }] }.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'release_owner',
      description:
        'Kill and forget every non-detached background and terminal session owned by this caller scope. Idempotent. Sessions started with "detached": true are retained. FLUJO calls this when a run finishes; the scope is host-derived, so a caller can only release its own sessions. Returns { ownerScope, killedSessions, closedTerminals, retainedDetached }.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function maybeNormalize(text: string, normalize: boolean): string {
  return normalize ? text.replace(/\r\n?/g, '\n') : text;
}

interface ShellSelection {
  shell: ShellKind;
  autoSelected: boolean;
}

/**
 * Only when the caller said `shell: "default"` may we pick a different shell
 * (issue #364): a command chained with POSIX `&&`/`||` cannot even parse under
 * Windows PowerShell 5.1, so prefer a shell that can run it. An explicitly
 * requested shell is never overridden.
 */
function selectShell(command: string, requested: ShellKind): ShellSelection {
  if (requested !== 'default') return { shell: requested, autoSelected: false };
  const plan = buildSpawn(command, 'default');
  if (plan.effectiveShell === 'powershell' && commandUsesPosixChaining(command)) {
    if (resolvePwshExecutable()) return { shell: 'pwsh', autoSelected: true };
    if (resolveBashExecutable()) return { shell: 'bash', autoSelected: true };
  }
  return { shell: 'default', autoSelected: false };
}

/** Optional per-call output limits shared by `run` and `start`. */
function resolveMaxOutputChars(input: unknown): number {
  return typeof input === 'number' && input > 0
    ? Math.min(Math.floor(input), MAX_OUTPUT_CHARS)
    : MAX_OUTPUT_CHARS;
}

/** Spool the full merged output to a file while the tool result stays bounded. */
function createOutputSpool(file: string | undefined): {
  write: (chunk: string) => void;
  close: () => void;
  bytes: () => number;
  error: () => string | undefined;
} {
  if (!file) return { write: () => undefined, close: () => undefined, bytes: () => 0, error: () => undefined };
  let bytes = 0;
  let failure: string | undefined;
  let stream: fs.WriteStream | undefined;
  try {
    stream = fs.createWriteStream(file, { encoding: 'utf8' });
    stream.on('error', (err) => { failure = err instanceof Error ? err.message : String(err); });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  return {
    write: (chunk: string) => {
      if (!stream || failure || !chunk) return;
      try {
        stream.write(chunk);
        bytes += Buffer.byteLength(chunk, 'utf8');
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    },
    close: () => {
      try {
        stream?.end();
      } catch {
        /* best-effort */
      }
    },
    bytes: () => bytes,
    error: () => failure,
  };
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

  const encodingMode = validateEncoding(args.encoding);
  if (!encodingMode) {
    return textResult({ error: '"encoding" must be one of "utf8", "utf16le", or "auto".' }, true);
  }

  const cwd = await resolveCwd(args.cwd, roots);
  const normalize = args.normalizeNewlines === true;
  const timeoutMs = resolveCommandTimeoutMs(args.timeout);
  const maxOutputChars = resolveMaxOutputChars(args.maxOutputChars);
  let outputFilePath: string | undefined;
  if (args.outputFile !== undefined) {
    try {
      outputFilePath = await resolveOutputFile(args.outputFile, cwd, roots);
    } catch (err) {
      return textResult({ error: err instanceof Error ? err.message : String(err), cwd }, true);
    }
  }
  const selection = selectShell(command, requestedShell);
  registerExitCleanup();
  const startedAt = Date.now();

  return await new Promise<CallToolResult>((resolve) => {
    let output = '';
    let truncated = false;
    let settled = false;
    let stderrChars = 0;

    const append = makeAppender(
      () => output,
      (v, t) => { output = v; truncated = t || truncated; },
      maxOutputChars,
    );
    const spool = createOutputSpool(outputFilePath);
    const decodeStdout = createStreamDecoder(encodingMode);
    const decodeStderr = createStreamDecoder(encodingMode);
    const progress = createCommandProgressReporter(context);

    const { child, startError, effectiveShell, unavailableShell, shellSubstitution } = startChild(
      command,
      cwd,
      selection.shell,
      envValidation.env,
    );
    const dialectWarnings = detectDialectMismatch(command, effectiveShell);
    const dialect = dialectWarnings.length ? { dialectWarnings } : {};
    const auto = selection.autoSelected ? { shellAutoSelected: true } : {};
    const substitution = shellSubstitution ? { shellSubstitution } : {};
    const spoolInfo = () => (outputFilePath
      ? { outputFile: outputFilePath, outputBytes: spool.bytes(), ...(spool.error() ? { outputFileError: spool.error() } : {}) }
      : {});
    const outputStats = () => ({
      truncated,
      stderrChars,
      outputChars: append.totalChars(),
      ...(append.droppedChars() > 0 ? { omittedChars: append.droppedChars() } : {}),
    });
    if (unavailableShell) {
      spool.close();
      void progress.stop().then(() => {
        resolve(textResult({
          error: `Requested shell "${unavailableShell}" is unavailable or could not be resolved.`,
          cwd,
          requestedShell,
          shell: unavailableShell,
          availableShells: availableShellNames(),
          hint: unavailableShellHint(unavailableShell),
        }, true));
      });
      return;
    }
    if (startError || !child) {
      spool.close();
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
        output: finalOut,
        ...outputStats(),
        ...spoolInfo(),
        ...dialect,
        ...substitution,
        ...auto,
      }, true), true);
    };
    const finish = async (result: CallToolResult, keepKillEscalation = false) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);
      if (!keepKillEscalation) cancelEscalation?.();
      spool.close();
      await progress.stop();
      resolve(result);
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        cancelEscalation = killProcessTree(child);
        const finalOut = maybeNormalize(output, normalize);
        const hangHints = detectInteractiveHangRisk(command);
        void finish(textResult({
          timedOut: true,
          cwd,
          requestedShell,
          shell: effectiveShell,
          exitCode: null,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          killedProcessTree: true,
          suggestion: `Command exceeded ${timeoutMs / 1000}s and its process tree was killed. `
            + `Raise "timeout" (positive values cap at ${commandMaxTimeoutMs() / 1000}s), pass -1, or use "start" + "wait" for a persistent job.`,
          output: `${finalOut}${finalOut ? '\n' : ''}[killed after ${timeoutMs / 1000}s timeout]`,
          ...outputStats(),
          ...spoolInfo(),
          ...(hangHints.length ? { hangHints } : {}),
          ...dialect,
          ...substitution,
          ...auto,
        }, true), true);
      }, timeoutMs);
    }
    child.stdout?.on('data', (d: Buffer) => {
      const chunk = decodeStdout(d);
      append(chunk);
      spool.write(chunk);
      progress.push(maybeNormalize(chunk, normalize));
    });
    child.stderr?.on('data', (d: Buffer) => {
      const chunk = decodeStderr(d);
      stderrChars += chunk.length;
      append(chunk);
      spool.write(chunk);
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
      void finish(textResult({
        exitCode: code,
        cwd,
        requestedShell,
        shell: effectiveShell,
        output: finalOut,
        ...outputStats(),
        ...spoolInfo(),
        ...dialect,
        ...missingExecutableHint(code, dialectWarnings),
        ...substitution,
        ...auto,
      }, code !== 0));
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
  // Issue #413: the HOST-wide live cap spans background and terminal sessions.
  // A per-owner limit alone let N concurrent runs each stay legal while together
  // forking an unbounded number of live process trees on one machine. Expire
  // stale sessions first so the cap is measured against genuinely live work.
  expireStaleSessions();
  const hostLimit = maxLiveSessionsHost();
  if (liveSessionCount() >= hostLimit) {
    return textResult({
      error: `Too many live sessions on this host (max ${hostLimit} across background and terminal sessions). Wait for one to finish or kill one first.`,
      liveSessions: liveSessionCount(),
    }, true);
  }
  if (ownerLiveSessionCount(ownerScope) >= MAX_SESSIONS) {
    return textResult({ error: `Too many live sessions for this caller (max ${MAX_SESSIONS}). Kill some first.` }, true);
  }

  // Surviving the owning run must be an explicit choice (see releaseOwnerScope).
  const detached = args.detached === true || args.persistAfterRun === true;

  registerExitCleanup();

  const encodingMode = validateEncoding(args.encoding);
  if (!encodingMode) {
    return textResult({ error: '"encoding" must be one of "utf8", "utf16le", or "auto".' }, true);
  }

  const cwd = await resolveCwd(args.cwd, roots);
  const maxOutputChars = resolveMaxOutputChars(args.maxOutputChars);
  let outputFilePath: string | undefined;
  if (args.outputFile !== undefined) {
    try {
      outputFilePath = await resolveOutputFile(args.outputFile, cwd, roots);
    } catch (err) {
      return textResult({ error: err instanceof Error ? err.message : String(err), cwd }, true);
    }
  }
  const selection = selectShell(command, requestedShell);
  const { child, startError, effectiveShell, unavailableShell, shellSubstitution } = startChild(
    command,
    cwd,
    selection.shell,
    envValidation.env,
  );
  if (unavailableShell) {
    return textResult({
      error: `Requested shell "${unavailableShell}" is unavailable or could not be resolved.`,
      cwd,
      requestedShell,
      shell: unavailableShell,
      availableShells: availableShellNames(),
      hint: unavailableShellHint(unavailableShell),
    }, true);
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
    lastActivityAt: Date.now(),
    ...(detached ? { detached: true } : {}),
  };
  table.set(id, session);

  const append = makeAppender(
    () => session.output,
    (v, t) => { session.output = v; session.truncated = t || session.truncated; },
    maxOutputChars,
  );
  const spool = createOutputSpool(outputFilePath);
  const decodeStdout = createStreamDecoder(encodingMode);
  const decodeStderr = createStreamDecoder(encodingMode);
  child.stdout?.on('data', (d: Buffer) => {
    const chunk = decodeStdout(d);
    touchSession(session);
    append(chunk);
    spool.write(chunk);
  });
  child.stderr?.on('data', (d: Buffer) => {
    const chunk = decodeStderr(d);
    session.stderrChars = (session.stderrChars ?? 0) + chunk.length;
    touchSession(session);
    append(chunk);
    spool.write(chunk);
  });
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
    spool.close();
    scheduleReap(session);
  });

  const dialectWarnings = detectDialectMismatch(command, effectiveShell);
  session.missingExecutableWarning = dialectWarnings.some((warning) => /not found on PATH|not available as an executable/.test(warning));
  return textResult({
    sessionId: id,
    cwd,
    requestedShell,
    shell: effectiveShell,
    ...(detached ? { detached: true } : {}),
    ...(shellSubstitution ? { shellSubstitution } : {}),
    ...(selection.autoSelected ? { shellAutoSelected: true } : {}),
    ...(dialectWarnings.length ? { dialectWarnings } : {}),
    ...(outputFilePath ? { outputFile: outputFilePath } : {}),
  });
}

function snapshot(session: BashSession, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: session.id,
    running: session.running,
    exitCode: session.exitCode,
    output: session.output,
    truncated: session.truncated,
    stderrChars: session.stderrChars ?? 0,
    ...(session.missingExecutableWarning && (session.exitCode === 9009 || session.exitCode === 255 || session.exitCode === 1)
      ? { hint: 'A referenced executable was not found — see dialectWarnings.' } : {}),
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
  const timeoutMs = resolveCommandTimeoutMs(args.timeout);
  const timing = (
    outcome: 'completed' | 'timedOut' | 'cancelled',
    waitedMs: number,
  ): Record<string, unknown> => {
    const finite = timeoutMs !== undefined;
    const returnedEarly = finite && outcome === 'completed' && waitedMs < timeoutMs;
    const remainingSeconds = returnedEarly
      ? Math.ceil(Math.max(0, timeoutMs - waitedMs)) / 1_000
      : 0;
    return {
      timedOut: outcome === 'timedOut',
      waitedMs,
      ...(finite ? { requestedTimeoutMs: timeoutMs, returnedEarly } : {}),
      ...(returnedEarly
        ? {
            remainingSeconds,
            hint:
              '`wait.timeout` is a maximum, so wait returned when the background session completed. '
              + `To wait the full requested duration, call sleep with {"seconds": ${remainingSeconds}}.`,
          }
        : {}),
      ...(outcome === 'cancelled' ? { cancelled: true } : {}),
    };
  };
  if (!session.running) return textResult(snapshot(session, timing('completed', 0)));
  if (context?.signal?.aborted) {
    return textResult(snapshot(session, timing('cancelled', 0)), true);
  }

  const startedAt = Date.now();
  const progress = createCommandProgressReporter(context);

  const outcome = await new Promise<{
    kind: 'completed' | 'timedOut' | 'cancelled';
    waitedMs: number;
  }>((resolve) => {
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
      const waitedMs = Date.now() - startedAt;
      await progress.stop();
      resolve({ kind: value, waitedMs });
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
    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => void finish('timedOut'), timeoutMs);
    }
    context?.signal?.addEventListener('abort', onAbort, { once: true });
    poll();
  });
  return textResult(
    snapshot(session, timing(outcome.kind, outcome.waitedMs)),
    outcome.kind === 'cancelled',
  );
}

async function sleepTool(
  args: Record<string, unknown>,
  context?: BashExecutionContext,
): Promise<CallToolResult> {
  const seconds = args.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return textResult({ error: 'Provide "seconds" as a finite number greater than 0.' }, true);
  }
  const requestedMs = seconds * 1_000;
  const ceilingMs = Math.min(commandMaxTimeoutMs(), 2 ** 31 - 1);
  if (requestedMs > ceilingMs) {
    return textResult({
      error: `Requested sleep exceeds the configured maximum of ${ceilingMs / 1_000} seconds.`,
      requestedSeconds: seconds,
      maxSeconds: ceilingMs / 1_000,
    }, true);
  }
  if (context?.signal?.aborted) {
    return textResult({ slept: false, cancelled: true, requestedSeconds: seconds, elapsedMs: 0 }, true);
  }

  const startedAt = Date.now();
  // A one-second heartbeat keeps finite MCP request timers alive even when the
  // requested fixed delay is longer than the caller's ordinary silent window.
  const progress = createCommandProgressReporter(context, 1_000);
  progress.push(`[sleeping for ${seconds}s]`);
  const outcome = await new Promise<{ slept: boolean; elapsedMs: number }>((resolve) => {
    let settled = false;
    const finish = (slept: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context?.signal?.removeEventListener('abort', onAbort);
      resolve({ slept, elapsedMs: Date.now() - startedAt });
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), requestedMs);
    if (context?.signal?.aborted) onAbort();
    else context?.signal?.addEventListener('abort', onAbort, { once: true });
  });
  await progress.stop();
  return textResult({
    slept: outcome.slept,
    requestedSeconds: seconds,
    elapsedMs: outcome.elapsedMs,
    ...(!outcome.slept ? { cancelled: true } : {}),
  }, !outcome.slept);
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
  touchSession(session);
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
      detached: s.detached === true,
      startedAt: new Date(s.startedAt).toISOString(),
      endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
    }));
  return textResult({ sessions: list });
}

/**
 * Release every non-detached session of the CALLING scope.
 *
 * The scope is host-derived (`_meta.flujo.ownerScope`), never a tool argument, so
 * a caller can only ever release its own sessions - releasing by arbitrary scope
 * would be a cross-run kill primitive.
 */
function releaseOwnerTool(ownerScope: string): CallToolResult {
  const released = releaseOwnerScope(ownerScope);
  return textResult({
    ownerScope: released.ownerScope,
    killedSessions: released.killedSessions,
    closedTerminals: released.closedTerminals,
    retainedDetached: released.retainedDetached,
  });
}

function terminalSnapshot(session: TerminalSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    shell: session.shell,
    cwd: session.cwd,
    running: session.running,
    exitCode: session.exitCode,
    cursor: session.nextCursor,
  };
}

function scheduleTerminalReap(session: TerminalSession): void {
  session.reapTimer = setTimeout(() => terminalSessions().delete(session.id), SESSION_TTL_MS);
  session.reapTimer.unref?.();
}

function appendTerminalOutput(session: TerminalSession, chunk: string): void {
  if (!chunk) return;
  session.output += chunk;
  session.nextCursor += chunk.length;
  if (session.output.length > MAX_TERMINAL_OUTPUT_CHARS) {
    const remove = session.output.length - MAX_TERMINAL_OUTPUT_CHARS;
    session.output = session.output.slice(remove);
    session.outputStart += remove;
  }
}

async function openTerminalTool(
  args: Record<string, unknown>,
  roots: string[],
  ownerScope: string,
): Promise<CallToolResult> {
  const shellValidation = validateShell(args.shell);
  if (!shellValidation.valid) return invalidShellResult(shellValidation.requestedShell);
  const envValidation = validateEnv(args.env);
  if (!envValidation.valid) return textResult({ error: envValidation.error }, true);

  const ownedRunning = Array.from(terminalSessions().values())
    .filter((session) => session.ownerScope === ownerScope && session.running);
  if (ownedRunning.length >= MAX_SESSIONS) {
    return textResult({ error: `Too many active terminal sessions (max ${MAX_SESSIONS}). Close one first.` }, true);
  }
  // Issue #413: PTY sessions count against the SAME host-wide live cap as
  // background sessions - a terminal is just as much a live process tree.
  expireStaleSessions();
  const hostLimit = maxLiveSessionsHost();
  if (liveSessionCount() >= hostLimit) {
    return textResult({
      error: `Too many live sessions on this host (max ${hostLimit} across background and terminal sessions). Close one first.`,
      liveSessions: liveSessionCount(),
    }, true);
  }
  if (ownerLiveSessionCount(ownerScope) >= MAX_SESSIONS) {
    return textResult({ error: `Too many live sessions for this caller (max ${MAX_SESSIONS}). Close one first.` }, true);
  }
  registerExitCleanup();

  const cwd = await resolveCwd(args.cwd, roots);
  const plan = buildPtySpawn(shellValidation.shell);
  if (plan.unavailableShell) {
    return textResult({
      error: `Requested shell "${plan.unavailableShell}" is unavailable or could not be resolved.`,
      availableShells: availableShellNames(),
      hint: 'Call "shell_info" to see which shells and interpreters exist on this machine.',
    }, true);
  }
  if (plan.startError) return textResult({ error: plan.startError }, true);

  const cols = Math.max(20, Math.min(400, Math.floor(typeof args.cols === 'number' ? args.cols : 100)));
  const rows = Math.max(5, Math.min(200, Math.floor(typeof args.rows === 'number' ? args.rows : 30)));
  let pty: IPty;
  try {
    pty = spawnPty(plan.file, plan.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...buildChildEnv(envValidation.env),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });
  } catch (error) {
    return textResult({
      error: `Failed to open pseudoterminal (${plan.effectiveShell}): ${error instanceof Error ? error.message : String(error)}`,
      cwd,
      shell: plan.effectiveShell,
    }, true);
  }

  registerExitCleanup();
  const id = `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: TerminalSession = {
    id,
    ownerScope,
    shell: plan.effectiveShell,
    cwd,
    pty,
    output: '',
    outputStart: 0,
    nextCursor: 0,
    running: true,
    exitCode: null,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...(args.detached === true || args.persistAfterRun === true ? { detached: true } : {}),
  };
  terminalSessions().set(id, session);
  pty.onData((chunk) => {
    touchSession(session);
    appendTerminalOutput(session, chunk);
  });
  pty.onExit(({ exitCode }) => {
    session.running = false;
    session.exitCode = exitCode;
    session.endedAt = Date.now();
    scheduleTerminalReap(session);
  });
  return textResult({ ...terminalSnapshot(session), cols, rows });
}

function ownedTerminal(id: string, ownerScope: string): TerminalSession | undefined {
  const session = terminalSessions().get(id);
  return session?.ownerScope === ownerScope ? session : undefined;
}

function readTerminalTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args.sessionId ?? '');
  const session = ownedTerminal(id, ownerScope);
  if (!session) return textResult({ error: `No terminal session with id "${id}".` }, true);
  touchSession(session);
  const requested = Number.isFinite(args.cursor) ? Math.max(0, Math.floor(Number(args.cursor))) : session.outputStart;
  const reset = requested < session.outputStart || requested > session.nextCursor;
  const cursor = reset ? session.outputStart : requested;
  return textResult({
    ...terminalSnapshot(session),
    chunk: session.output.slice(cursor - session.outputStart),
    nextCursor: session.nextCursor,
    reset,
  });
}

function writeTerminalTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args.sessionId ?? '');
  const session = ownedTerminal(id, ownerScope);
  if (!session) return textResult({ error: `No terminal session with id "${id}".` }, true);
  if (!session.running) return textResult({ error: `Terminal session "${id}" has exited.` }, true);
  const data = typeof args.data === 'string' ? args.data : '';
  if (data.length > 65_536) return textResult({ error: 'Terminal input is limited to 65,536 characters per write.' }, true);
  try {
    touchSession(session);
    session.pty.write(data);
    return textResult({ sessionId: id, written: Buffer.byteLength(data, 'utf8') });
  } catch (error) {
    return textResult({ error: `Failed to write terminal input: ${error instanceof Error ? error.message : String(error)}` }, true);
  }
}

function resizeTerminalTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args.sessionId ?? '');
  const session = ownedTerminal(id, ownerScope);
  if (!session) return textResult({ error: `No terminal session with id "${id}".` }, true);
  const cols = Math.max(20, Math.min(400, Math.floor(Number(args.cols))));
  const rows = Math.max(5, Math.min(200, Math.floor(Number(args.rows))));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return textResult({ error: 'cols and rows must be finite numbers.' }, true);
  try {
    if (session.running) session.pty.resize(cols, rows);
    return textResult({ sessionId: id, cols, rows });
  } catch (error) {
    return textResult({ error: `Failed to resize terminal: ${error instanceof Error ? error.message : String(error)}` }, true);
  }
}

function closeTerminalTool(args: Record<string, unknown>, ownerScope: string): CallToolResult {
  const id = String(args.sessionId ?? '');
  const session = ownedTerminal(id, ownerScope);
  if (!session) return textResult({ error: `No terminal session with id "${id}".` }, true);
  try {
    if (session.running) {
      session.running = false;
      session.pty.kill();
    }
    return textResult({ sessionId: id, closed: true });
  } catch (error) {
    return textResult({ error: `Failed to close terminal: ${error instanceof Error ? error.message : String(error)}` }, true);
  }
}

function listTerminalsTool(ownerScope: string): CallToolResult {
  return textResult({
    sessions: Array.from(terminalSessions().values())
      .filter((session) => session.ownerScope === ownerScope)
      .map((session) => ({
        ...terminalSnapshot(session),
        startedAt: new Date(session.startedAt).toISOString(),
        endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined,
      })),
  });
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
      case 'open_terminal': {
        const roots = await loadEffectiveRoots(BASH_SERVER_NAME, BASH_ROOT_ENV_VARS, callerNodeId);
        return await openTerminalTool(args, roots, scope);
      }
      case 'terminal_read':
        return readTerminalTool(args, scope);
      case 'terminal_write':
        return writeTerminalTool(args, scope);
      case 'terminal_resize':
        return resizeTerminalTool(args, scope);
      case 'terminal_close':
        return closeTerminalTool(args, scope);
      case 'terminal_list':
        return listTerminalsTool(scope);
      case 'shell_info':
        return shellInfoTool();
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
      case 'sleep':
        return await sleepTool(args, context);
      case 'write_stdin':
        return writeStdinTool(args, scope);
      case 'kill':
        return killTool(args, scope);
      case 'list_sessions':
        return listSessionsTool(scope);
      case 'release_owner':
        return releaseOwnerTool(scope);
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
  terminalSessions().clear();
}
