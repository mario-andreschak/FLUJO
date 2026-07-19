/**
 * Built-in `bash` MCP server (issue #170).
 *
 * Cross-platform shell execution (grep, curl, …) on Windows/macOS/Linux. It
 * reuses the proven spawn + timeout + process-tree-kill primitives from the
 * legacy `terminal` tool (which this server replaces) and adds:
 *   - shell selection: the OS default shell, or explicit `pwsh` / `bash`
 *     (degrading gracefully when the requested shell isn't installed),
 *   - optional CRLF→LF normalization of captured output,
 *   - background execution: start → status/wait → write_stdin → kill,
 *   - orphan cleanup: every live session is force-killed on FLUJO process exit,
 *     and idle finished sessions are swept after a TTL.
 *
 * Every tool returns a machine-readable JSON envelope in a single text content
 * block; failures come back as `isError: true` rather than thrown.
 */
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { killProcessTree } from '@/utils/process/killProcessTree';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';

const log = createLogger('backend/services/mcp/internal/bashTools');

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_SESSIONS = 25;
/** Finished sessions are reaped this long after they exit so `status`/`wait` can still read them. */
const SESSION_TTL_MS = 10 * 60_000;

type ShellKind = 'default' | 'pwsh' | 'bash';

interface BashSession {
  id: string;
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
  var __flujo_bash_cleanup_registered: boolean | undefined;
}

function sessions(): Map<string, BashSession> {
  if (!global.__flujo_bash_sessions) global.__flujo_bash_sessions = new Map<string, BashSession>();
  return global.__flujo_bash_sessions;
}

/** Kill every live session's process tree — used on FLUJO process exit. */
function killAllSessions(): void {
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
  const handler = () => killAllSessions();
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

function resolveCwd(input: unknown): string {
  const dataDir = getDataDir();
  const raw = typeof input === 'string' ? input.trim() : '';
  return raw ? (path.isAbsolute(raw) ? raw : path.join(dataDir, raw)) : dataDir;
}

/**
 * Build the spawn arguments for the requested shell. Returns the command, argv
 * and whether Node's `shell:true` wrapping applies. `pwsh`/`bash` are launched
 * explicitly (no shell wrapper); the default kind relies on `shell:true`.
 */
function buildSpawn(command: string, shell: ShellKind): { file: string; args: string[]; useShell: boolean } {
  if (shell === 'pwsh') {
    // pwsh (PowerShell 7+) is cross-platform; fall back to Windows PowerShell.
    const file = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
    return { file, args: ['-NoProfile', '-NonInteractive', '-Command', command], useShell: false };
  }
  if (shell === 'bash') {
    return { file: 'bash', args: ['-c', command], useShell: false };
  }
  // Default OS shell via Node's shell wrapper.
  return { file: command, args: [], useShell: true };
}

function coerceShell(input: unknown): ShellKind {
  return input === 'pwsh' || input === 'bash' ? input : 'default';
}

interface SpawnOutcome {
  child: ChildProcess;
  startError?: string;
}

function startChild(command: string, cwd: string, shell: ShellKind): SpawnOutcome {
  const { file, args, useShell } = buildSpawn(command, shell);
  // POSIX: detached so killProcessTree can signal the whole group (see killProcessTree).
  const detached = process.platform !== 'win32';
  try {
    const child = spawn(file, args, { cwd, shell: useShell, env: process.env, detached });
    return { child };
  } catch (err) {
    return { child: undefined as unknown as ChildProcess, startError: err instanceof Error ? err.message : String(err) };
  }
}

function makeAppender(get: () => string, set: (v: string, truncated: boolean) => void) {
  return (chunk: string) => {
    let out = get();
    if (out.length >= MAX_OUTPUT_CHARS) return;
    out += chunk;
    let truncated = false;
    if (out.length > MAX_OUTPUT_CHARS) {
      out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…[output truncated]';
      truncated = true;
    }
    set(out, truncated);
  };
}

export function bashToolDefinitions(): Tool[] {
  const shellProp = {
    type: 'string',
    enum: ['default', 'pwsh', 'bash'],
    description: 'Which shell to use: "default" (the OS shell), "pwsh" (PowerShell 7+), or "bash". Falls back to the default shell if the requested one is unavailable.',
  };
  const cwdProp = { type: 'string', description: 'Working directory. Relative paths resolve against the FLUJO data directory. Defaults to the data directory.' };
  return [
    {
      name: 'run',
      description:
        'Run a shell command to completion and return combined stdout/stderr plus the exit code. Pipes and chained commands work. Killed if it exceeds the timeout; large output is truncated. Returns { exitCode, cwd, shell, output, timedOut }.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute, e.g. "grep -r foo ." or "curl -s https://…".' },
          cwd: cwdProp,
          shell: shellProp,
          timeout: { type: 'number', description: 'Timeout in seconds (default 60, max 600).' },
          normalizeNewlines: { type: 'boolean', description: 'If true, CRLF/CR in the captured output are normalized to LF.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'start',
      description: 'Start a command in the BACKGROUND and return immediately with a { sessionId }. Use status/wait to observe it, write_stdin to feed it input, and kill to stop it.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line to execute in the background.' },
          cwd: cwdProp,
          shell: shellProp,
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
      description: 'Wait until a background session finishes (or the timeout elapses). Returns { sessionId, running, exitCode, output, truncated, timedOut }.',
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
      description: 'List all known background sessions with their state. Returns { sessions: [{ sessionId, command, running, exitCode, startedAt, endedAt }] }.',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

function maybeNormalize(text: string, normalize: boolean): string {
  return normalize ? text.replace(/\r\n?/g, '\n') : text;
}

async function runTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const command = String(args?.command ?? '').trim();
  if (!command) return textResult({ error: 'Provide "command": a shell command line to run.' }, true);

  const cwd = resolveCwd(args.cwd);
  const shell = coerceShell(args.shell);
  const normalize = args.normalizeNewlines === true;
  const timeoutSec = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = Math.min(timeoutSec * 1000, MAX_TIMEOUT_MS);

  return await new Promise<CallToolResult>((resolve) => {
    let output = '';
    let truncated = false;
    let settled = false;
    let timedOut = false;

    const append = makeAppender(() => output, (v, t) => { output = v; truncated = t || truncated; });

    const { child, startError } = startChild(command, cwd, shell);
    if (startError || !child) {
      resolve(textResult({ error: `Failed to start command (${shell}): ${startError ?? 'unknown error'}`, cwd, shell }, true));
      return;
    }

    let cancelEscalation: (() => void) | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      cancelEscalation = killProcessTree(child);
    }, timeoutMs);

    const finish = (result: CallToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelEscalation?.();
      resolve(result);
    };

    child.stdout?.on('data', (d: Buffer) => append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => append(d.toString()));

    child.on('error', (err: Error) => {
      // ENOENT for pwsh/bash means the requested shell isn't installed.
      append(`\n${err.message}`);
      finish(textResult({ error: `Command failed to start (${shell}): ${err.message}`, cwd, shell, output: maybeNormalize(output, normalize) }, true));
    });

    child.on('close', (code: number | null) => {
      const finalOut = maybeNormalize(output, normalize);
      if (timedOut) {
        finish(textResult({ timedOut: true, cwd, shell, exitCode: code, truncated, output: `${finalOut}\n[killed after ${timeoutMs / 1000}s timeout]` }, true));
        return;
      }
      finish(textResult({ exitCode: code, cwd, shell, truncated, output: finalOut }, code !== 0));
    });
  });
}

function scheduleReap(session: BashSession): void {
  session.reapTimer = setTimeout(() => {
    sessions().delete(session.id);
  }, SESSION_TTL_MS);
  // Do not keep the event loop alive just to reap a session.
  session.reapTimer.unref?.();
}

function startTool(args: Record<string, unknown>): CallToolResult {
  const command = String(args?.command ?? '').trim();
  if (!command) return textResult({ error: 'Provide "command": a shell command line to run.' }, true);

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

  const cwd = resolveCwd(args.cwd);
  const shell = coerceShell(args.shell);
  const { child, startError } = startChild(command, cwd, shell);
  if (startError || !child) {
    return textResult({ error: `Failed to start command (${shell}): ${startError ?? 'unknown error'}`, cwd, shell }, true);
  }

  const id = `bash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: BashSession = {
    id,
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

  return textResult({ sessionId: id, cwd, shell });
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

function statusTool(args: Record<string, unknown>): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = sessions().get(id);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  return textResult(snapshot(session));
}

async function waitTool(args: Record<string, unknown>): Promise<CallToolResult> {
  const id = String(args?.sessionId ?? '');
  const session = sessions().get(id);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  if (!session.running) return textResult(snapshot(session, { timedOut: false }));

  const timeoutSec = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : DEFAULT_TIMEOUT_MS / 1000;
  const timeoutMs = Math.min(timeoutSec * 1000, MAX_TIMEOUT_MS);

  const timedOut = await new Promise<boolean>((resolve) => {
    const start = Date.now();
    const poll = () => {
      if (!session.running) return resolve(false);
      if (Date.now() - start >= timeoutMs) return resolve(true);
      setTimeout(poll, 100);
    };
    poll();
  });
  return textResult(snapshot(session, { timedOut }));
}

function writeStdinTool(args: Record<string, unknown>): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = sessions().get(id);
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

function killTool(args: Record<string, unknown>): CallToolResult {
  const id = String(args?.sessionId ?? '');
  const session = sessions().get(id);
  if (!session) return textResult({ error: `No background session with id "${id}".` }, true);
  if (session.running) {
    session.cancelEscalation = killProcessTree(session.child);
  }
  return textResult({ sessionId: id, killed: true });
}

function listSessionsTool(): CallToolResult {
  const list = Array.from(sessions().values()).map((s) => ({
    sessionId: s.id,
    command: s.command,
    running: s.running,
    exitCode: s.exitCode,
    startedAt: new Date(s.startedAt).toISOString(),
    endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : undefined,
  }));
  return textResult({ sessions: list });
}

export async function bashCallTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    switch (toolName) {
      case 'run':
        return await runTool(args);
      case 'start':
        return startTool(args);
      case 'status':
        return statusTool(args);
      case 'wait':
        return await waitTool(args);
      case 'write_stdin':
        return writeStdinTool(args);
      case 'kill':
        return killTool(args);
      case 'list_sessions':
        return listSessionsTool();
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
  killAllSessions();
  sessions().clear();
}
