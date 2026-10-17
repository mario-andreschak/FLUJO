import { constants as fsConstants, lstatSync, realpathSync, promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { OriginalOwnerEnrollment } from './types';
import { refuse } from './types';
import { killProcessTreeAndWait } from '@/utils/process/killProcessTree';

const toolNames = new Set(['worker_read_file', 'worker_write_file', 'worker_list_dir', 'worker_command']);
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 1000;
const COMMAND_TIMEOUT_MS = 30_000;
const refused = () => refuse('original_owner_tool_effect_refused');
const commandEnvironmentNames = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ'] as const;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export class NativeToolTeardownError extends AggregateError {
  constructor(errors: unknown[]) { super(errors, 'Native tool effect failed to stop cleanly.'); }
}
type EnrollmentGrant = Pick<OriginalOwnerEnrollment, 'allowedTools' | 'commands' | 'directory'>;
type PathIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint; kind: 'file' | 'directory' };
type PathSnapshot = Map<string, PathIdentity | null>;

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inside(root: string, candidate: string, allowRoot = false): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizedArguments(name: string, args: Record<string, unknown>) {
  if (!toolNames.has(name) || !args || typeof args !== 'object' || Array.isArray(args)) return refused();
  // structuredClone and server graphs may supply another realm's plain object.
  // Check the prototype shape, never one realm's Object.prototype identity.
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) return refused();
  let encoded: string;
  try { encoded = JSON.stringify(args); } catch { return refused(); }
  if (Buffer.byteLength(encoded) > 16 * 1024) return refused();
  const allowed = name === 'worker_command' ? ['command', 'cwd']
    : name === 'worker_write_file' ? ['path', 'content'] : ['path'];
  if (Reflect.ownKeys(args).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(args).some(value => typeof value !== 'string' || value.includes('\0'))) return refused();
  if (name === 'worker_command') {
    if (typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16_384
      || (args.cwd !== undefined && typeof args.cwd !== 'string')) return refused();
  } else if (typeof args.path !== 'string' || !args.path) return refused();
  if (name === 'worker_write_file' && typeof args.content !== 'string') return refused();
  const relative = name === 'worker_command' ? (args.cwd ?? '.') : args.path;
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.startsWith('\\')
    || relative.includes('\\') || relative.includes(':') || relative.includes('\0')
    || relative.split('/').some(segment => !segment || segment === '..')) return refused();
  if (name === 'worker_write_file' && Buffer.byteLength(args.content as string, 'utf8') > MAX_TEXT_BYTES) return refused();
  return Object.freeze(structuredClone(args));
}

async function plainDirectory(filename: string): Promise<BigIntStats> {
  let stats: BigIntStats;
  try { stats = await fs.lstat(filename, { bigint: true }); } catch { return refused(); }
  if (stats.isSymbolicLink() || !stats.isDirectory() || canonical(await fs.realpath(filename)) !== canonical(filename)) {
    return refused();
  }
  return stats;
}

async function plainFile(filename: string): Promise<BigIntStats | undefined> {
  let stats: BigIntStats;
  try { stats = await fs.lstat(filename, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return refused();
  }
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== BigInt(1)
    || canonical(await fs.realpath(filename)) !== canonical(filename)) {
    return refused();
  }
  return stats;
}

async function validateRoot(directory: string | undefined): Promise<string> {
  if (!directory || !path.isAbsolute(directory)) return refused();
  const root = path.resolve(directory);
  await plainDirectory(root);
  return root;
}

function targetPath(root: string, relative: string, allowRoot: boolean): string {
  const target = path.resolve(root, ...relative.split('/'));
  if (!inside(canonical(root), canonical(target), allowRoot)) return refused();
  return target;
}

function pathIdentity(stats: BigIntStats): PathIdentity {
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) return refused();
  if (stats.isFile() && stats.nlink !== BigInt(1)) return refused();
  return { dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs,
    kind: stats.isFile() ? 'file' : 'directory' };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs
    && left.kind === right.kind;
}

async function captureIdentity(filename: string): Promise<PathIdentity | null> {
  try {
    const stats = await fs.lstat(filename, { bigint: true });
    if (canonical(await fs.realpath(filename)) !== canonical(filename)) return refused();
    return pathIdentity(stats);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return refused();
  }
}

async function assertSnapshot(snapshot: PathSnapshot): Promise<void> {
  for (const [filename, expected] of snapshot) {
    const actual = await captureIdentity(filename);
    if (expected === null ? actual !== null : !actual || !sameIdentity(actual, expected)) return refused();
  }
}

function assertSnapshotSync(snapshot: PathSnapshot): void {
  for (const [filename, expected] of snapshot) {
    let actual: PathIdentity | null;
    try {
      const stats = lstatSync(filename, { bigint: true });
      if (canonical(realpathSync(filename)) !== canonical(filename)) return refused();
      actual = pathIdentity(stats);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') actual = null;
      else return refused();
    }
    if (expected === null ? actual !== null : !actual || !sameIdentity(actual, expected)) return refused();
  }
}

async function validateDirectoryPath(root: string, target: string, snapshot: PathSnapshot): Promise<void> {
  if (!inside(canonical(root), canonical(target), true)) return refused();
  await assertSnapshot(snapshot);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    await plainDirectory(current);
  }
  await plainDirectory(root);
  await assertSnapshot(snapshot);
}

async function validateFilePath(root: string, target: string, snapshot: PathSnapshot): Promise<void> {
  if (!inside(canonical(root), canonical(target))) return refused();
  const parent = path.dirname(target);
  await validateDirectoryPath(root, parent, snapshot);
  await plainFile(target);
  await plainDirectory(root);
  await assertSnapshot(snapshot);
}

async function snapshotPath(root: string, target: string, file: boolean): Promise<PathSnapshot> {
  const snapshot: PathSnapshot = new Map();
  const relative = path.relative(root, target);
  let current = root;
  snapshot.set(current, await captureIdentity(current));
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    snapshot.set(current, await captureIdentity(current));
  }
  await assertSnapshot(snapshot);
  for (const [filename, identity] of snapshot) {
    if (identity === null) {
      if (filename !== target || !file) return refused();
    } else if (filename !== target || !file) {
      if (identity.kind !== 'directory') return refused();
    }
  }
  return snapshot;
}

async function readFile(root: string, target: string, snapshot: PathSnapshot, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    await validateFilePath(root, target, snapshot);
    handle = await fs.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch { if (signal.aborted) signal.throwIfAborted(); return refused(); }
  try {
    signal.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    const named = await plainFile(target);
    const expected = snapshot.get(target);
    if (!named || !expected || !sameIdentity(pathIdentity(opened), expected)
      || !sameIdentity(pathIdentity(named), expected) || opened.size > BigInt(MAX_TEXT_BYTES)) return refused();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_TEXT_BYTES || bytesRead !== Number(opened.size)) return refused();
    signal.throwIfAborted();
    await validateFilePath(root, target, snapshot);
    const content = bytes.subarray(0, bytesRead).toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes.subarray(0, bytesRead))) return refused();
    return { content: [{ type: 'text', text: content }] };
  } catch { if (signal.aborted) signal.throwIfAborted(); return refused(); }
  finally { await handle.close().catch(() => {}); }
}

async function writeFile(root: string, target: string, snapshot: PathSnapshot, content: string, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    await validateFilePath(root, target, snapshot);
    handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch { if (signal.aborted) signal.throwIfAborted(); return refused(); }
  try {
    signal.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) return refused();
    const named = await plainFile(target);
    if (!named || !sameIdentity(pathIdentity(opened), pathIdentity(named))) return refused();
    const expected = snapshot.get(target);
    if (expected === null) snapshot.set(target, pathIdentity(opened));
    else if (!expected || !sameIdentity(pathIdentity(opened), expected)) return refused();
    await validateFilePath(root, target, snapshot);
    await handle.truncate(0);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    signal.throwIfAborted();
    await validateFilePath(root, target, snapshot);
    return { content: [{ type: 'text', text: 'File written.' }] };
  } catch { if (signal.aborted) signal.throwIfAborted(); return refused(); }
  finally { await handle.close().catch(() => {}); }
}

async function listDirectory(root: string, target: string, snapshot: PathSnapshot, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  await validateDirectoryPath(root, target, snapshot);
  const entries: string[] = [];
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try { directory = await fs.opendir(target); } catch { return refused(); }
  try {
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length > MAX_DIRECTORY_ENTRIES) return refused();
    }
  } catch (error) { if (signal.aborted) signal.throwIfAborted(); return refused(); }
  finally { await directory.close().catch(() => {}); }
  await validateDirectoryPath(root, target, snapshot);
  const text = JSON.stringify(entries.sort());
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return refused();
  signal.throwIfAborted();
  return { content: [{ type: 'text', text }] };
}

function runCommand(command: string, cwd: string, signal: AbortSignal): Promise<ToolResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { cwd, shell: true, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: commandEnvironment() });
    } catch { reject(new Error('original_owner_tool_effect_failed')); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = false;
    let settled = false;
    let stopPromise: Promise<void> | undefined;
    const stop = () => {
      if (!stopPromise) {
        stopped = true;
        stopPromise = killProcessTreeAndWait(child, { graceMs: 250, finalWaitMs: 1000 }).then(result => {
          if (!result.exited) throw new Error('original_owner_tool_effect_failed');
        });
      }
      return stopPromise;
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finishError = async (cause?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      let cleanupError: unknown;
      try { if (stopped) await stopPromise; } catch (error) { cleanupError = error; }
      const failure = new Error('original_owner_tool_effect_failed');
      reject(cleanupError ? new NativeToolTeardownError([failure, cleanupError])
        : cause ? new AggregateError([failure, cause], 'Native tool effect failed.') : failure);
    };
    const onAbort = () => { void stop().then(() => finishError(), error => finishError(error)); };
    const onData = (chunk: Buffer) => {
      if (stopped || settled) return;
      size += chunk.length;
      if (size > MAX_TEXT_BYTES) { void stop().then(() => finishError(), error => finishError(error)); return; }
      chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', () => { void finishError(); });
    child.once('close', async (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      let cleanupError: unknown;
      if (stopped) {
        try { await stopPromise; } catch (error) { cleanupError = error; }
      }
      if (stopped || code !== 0 || signal.aborted) {
        const failure = new Error('original_owner_tool_effect_failed');
        reject(cleanupError ? new NativeToolTeardownError([failure, cleanupError]) : failure);
      } else {
        const text = Buffer.concat(chunks, size).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) reject(new Error('original_owner_tool_effect_output_too_large'));
        else resolve({ content: [{ type: 'text', text }] });
      }
    });
    const timer = setTimeout(onAbort, COMMAND_TIMEOUT_MS);
    timer.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const name of commandEnvironmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * Prepares one exact, enrollment-authorized Worker effect. Preparation is
 * effect-free; start is one-use and begins the operation immediately so its
 * caller can invoke it inside the genuine Persona fence and await it afterward.
 */
export async function prepareNativeToolEffect(
  enrollment: EnrollmentGrant,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ start(): Promise<ToolResult> }> {
  if (!signal || typeof signal.throwIfAborted !== 'function' || !enrollment || !Array.isArray(enrollment.allowedTools)
    || !enrollment.allowedTools.includes(name as never)) return refused();
  const captured = normalizedArguments(name, args);
  const command = name === 'worker_command' ? (captured.command as string) : undefined;
  if (command && (!Array.isArray(enrollment.commands) || !enrollment.commands.includes(command))) return refused();
  const root = await validateRoot(enrollment.directory);
  const relative = name === 'worker_command' ? (captured.cwd as string | undefined ?? '.') : captured.path as string;
  const target = targetPath(root, relative, true);
  const isFile = name === 'worker_read_file' || name === 'worker_write_file';
  const snapshot = await snapshotPath(root, target, isFile);
  if (isFile) await validateFilePath(root, target, snapshot);
  else await validateDirectoryPath(root, target, snapshot);
  let started = false;
  return Object.freeze({
    start(): Promise<ToolResult> {
      if (started) return Promise.reject(new Error('original_owner_tool_effect_spent'));
      started = true;
      try { signal.throwIfAborted(); } catch (error) { return Promise.reject(error); }
      if (name === 'worker_read_file') return readFile(root, target, snapshot, signal);
      if (name === 'worker_write_file') return writeFile(root, target, snapshot, captured.content as string, signal);
      if (name === 'worker_list_dir') return listDirectory(root, target, snapshot, signal);
      // Keep the synchronous cwd recheck and process creation within start()'s
      // call stack; only process completion remains asynchronous.
      let childPath: string;
      try {
        assertSnapshotSync(snapshot);
        const real = realpathSync(target);
        if (canonical(real) !== canonical(target)) return Promise.reject(new Error('original_owner_tool_effect_refused'));
        const stat = lstatSync(target, { bigint: true });
        const expected = snapshot.get(target);
        if (stat.isSymbolicLink() || !stat.isDirectory() || !expected
          || !sameIdentity(pathIdentity(stat), expected)) return Promise.reject(new Error('original_owner_tool_effect_refused'));
        childPath = real;
      } catch { return Promise.reject(new Error('original_owner_tool_effect_refused')); }
      return runCommand(command!, childPath, signal);
    },
  });
}
