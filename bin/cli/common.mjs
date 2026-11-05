/**
 * Small helpers shared by the unattended `flujo` subcommands (service, selftest,
 * update). No dependencies: these commands run on machines nobody looks after,
 * and must work before anything else in the package has been proven to load.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { launcherPort } from '../launcher-port.mjs';

export class CliError extends Error {
  constructor(message, exitCode = 1, details) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.details = details;
  }
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Becomes part of a task or unit name and a folder name, so stay very plain. */
export function validateServiceName(name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name) || name.endsWith('.')) {
    throw new CliError('The name must be 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.');
  }
  return name;
}

export function validatePort(value) {
  try { return launcherPort(String(value)); }
  catch { throw new CliError('The port must be a whole number from 1 to 65535.'); }
}

export function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value)) {
    throw new CliError(`${label} must be a full path, for example ${process.platform === 'win32' ? 'C:\\FLUJO\\data' : '/srv/flujo/data'}.`);
  }
  return path.resolve(value);
}

/** Case-insensitive on Windows, where C:\A and c:\a are the same folder. */
export function isSameOrInside(parent, child) {
  const normalize = value => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Where one named instance keeps its launcher, logs, versions and backups. */
export function defaultServiceRoot(name, env = process.env, homedir = os.homedir()) {
  const configured = env.FLUJO_SERVICE_ROOT?.trim();
  return configured
    ? path.join(absoluteDirectory(configured, 'FLUJO_SERVICE_ROOT'), name)
    : path.join(homedir, '.flujo-service', name);
}

export function readJsonIfPresent(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export const sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds); });

/** Windows antivirus and indexers hold files briefly. Wait instead of failing. */
export function renameWithRetrySync(from, to, { attempts = 20, delayMs = 250 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      const transient = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error.code);
      if (!transient || attempt >= attempts) throw error;
      sleepSync(delayMs);
    }
  }
}

/** Replace a file in one step, so a power cut leaves the old or the new content. */
export function writeFileAtomicSync(filename, content, options = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, 'wx', options.mode ?? 0o600);
  try {
    fs.writeFileSync(handle, content);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  try {
    renameWithRetrySync(temporary, filename);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeJsonAtomicSync(filename, value) {
  writeFileAtomicSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

/** Run a program with no shell and no window. Never throws; callers read `ok`. */
export function runProgram(command, args, options = {}) {
  const result = spawnSync(command, args, {
    windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options,
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.code,
  };
}

export function windowsSystemProgram(...segments) {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...segments);
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** The command line of a process, or null if it cannot be read. */
export function processCommandLine(pid, { run = runProgram, platform = process.platform } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [Console]::Out.Write($p.CommandLine) }`;
    const result = run(windowsSystemProgram('WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000 });
    return result.ok && result.stdout ? result.stdout : null;
  }
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || null; }
  catch { return null; }
}

/** Stop a process and everything it started. Windows can only do this by force. */
export function killProcessTree(pid, { run = runProgram, platform = process.platform, signal = 'SIGTERM' } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (platform === 'win32') {
    return run(windowsSystemProgram('taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { timeout: 30_000 }).ok;
  }
  try { process.kill(pid, signal); return true; }
  catch { return false; }
}

/** Print either the JSON result or the plain summary, never both. */
export function report(result, json, plainLines) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of plainLines) console.log(line);
}
