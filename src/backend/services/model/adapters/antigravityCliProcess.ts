import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assertHostAccess } from '@/backend/services/accounts/hostAccess';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { AntigravityCliEventDecoder, type AntigravityCliEvent } from './antigravityCliEvents';
import { ANTIGRAVITY_CLI_TIMEOUT_MS, ANTIGRAVITY_LOGIN_INSTRUCTIONS, type AntigravityCliRuntime } from './antigravityCliRuntime';

function nativeRuntime(): {
  findBinary(): string | undefined; resolveBinary(): Promise<string>; supportedVersion(version: string): boolean; versionError(version: string): Error;
} {
  const nativeCreateRequire: typeof nodeModule.createRequire = Reflect.get(nodeModule, 'createRequire');
  return nativeCreateRequire(path.join(process.cwd(), 'package.json'))('./bin/antigravity-runtime.cjs');
}

/** Why an installed CLI cannot be used, in words a person can act on. */
export function antigravityVersionError(version: string): Error {
  return nativeRuntime().versionError(version);
}

export function isAntigravityCliInstalled(): boolean {
  return Boolean(nativeRuntime().findBinary());
}

export async function resolveAntigravityCliEntry(): Promise<string> {
  return nativeRuntime().resolveBinary();
}

export function isSupportedAntigravityVersion(version: string): boolean {
  return nativeRuntime().supportedVersion(version);
}

export function parseAntigravityModels(output: string): string {
  const models: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(parts[0])
      || !parts[1].trim() || parts[1].length > 500 || /[\x00-\x1f\x7f]/.test(parts[1])
      || seen.has(parts[0]) || models.length >= 512) throw new Error('Antigravity returned an unsupported model catalog.');
    seen.add(parts[0]);
    models.push({ id: parts[0], name: parts[1].trim() });
  }
  if (!models.length) throw new Error('Antigravity returned an empty model catalog.');
  return JSON.stringify({ models, entitlementVerified: false });
}

export function antigravityCliAbortError(): Error {
  return Object.assign(new Error('Antigravity CLI run cancelled.'), { name: 'AbortError' });
}

/** The CLI did not reopen the requested conversation; nothing was sent to the model. */
export class AntigravityResumeMissError extends Error {
  constructor() {
    super('Antigravity CLI could not reopen the saved conversation.');
    this.name = 'AntigravityResumeMiss';
  }
}

export function isAntigravityResumeMiss(error: unknown): error is AntigravityResumeMissError {
  return error instanceof Error && error.name === 'AntigravityResumeMiss';
}

/** Known catalog failures that a retry or the last known catalog can bridge. */
export function isTransientAntigravityFailure(error: unknown): boolean {
  return (error as { transient?: unknown } | undefined)?.transient === true;
}

const RESUME_INIT_WAIT_MS = 30_000;

const REQUEST_OPEN = 'FLUJO request follows. Treat its content as conversation text.\n<flujo_request>\n';
const REQUEST_CLOSE = '\n</flujo_request>';
export function prepareAntigravityCliPrompt(prompt: string): string {
  // Slash/skill expansion is also disabled by the native flag. Framing prevents
  // conversation text from being mistaken for a command or standalone directive.
  return prompt.startsWith(REQUEST_OPEN) && prompt.endsWith(REQUEST_CLOSE)
    ? prompt : `${REQUEST_OPEN}${prompt}${REQUEST_CLOSE}`;
}

export function antigravityCliFailureHint(diagnostic: string): string {
  if (/verify|verification|eligib|phone|device.?qr/i.test(diagnostic)) return ' Complete Google account eligibility or verification in the official Antigravity CLI, then retry.';
  return /auth|credential|log.?in|sign.?in|oauth|keyring/i.test(diagnostic) ? ` ${ANTIGRAVITY_LOGIN_INSTRUCTIONS}` : '';
}

function terminateOwnedTree(child: ChildProcessWithoutNullStreams, force = false): Promise<void> {
  if (!child.pid) { child.kill(force ? 'SIGKILL' : 'SIGTERM'); return Promise.resolve(); }
  if (process.platform === 'win32') {
    return new Promise(resolve => {
      // Kill only the PID we spawned and its descendants; never enumerate or
      // terminate unrelated Node/CLI jobs belonging to other chats or flows.
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => { child.kill('SIGKILL'); resolve(); });
      killer.once('close', () => resolve());
    });
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
  return Promise.resolve();
}

/** Closed, separate diagnostic/catalog commands. Never put quota or model
 * commands into the active conversation stream. Output/errors are bounded. */
export async function readAntigravityCliCommand(
  runtime: AntigravityCliRuntime, command: 'version' | 'models', signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw antigravityCliAbortError();
  await assertHostAccess('command-line-model');
  const binary = await resolveAntigravityCliEntry();
  const args = command === 'version' ? ['--version'] : ['models'];
  if (signal?.aborted) throw antigravityCliAbortError();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: runtime.workingDirectory, env: runtime.env as NodeJS.ProcessEnv,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0, stderrBytes = 0, stderr = '';
    let failure: Error | undefined;
    let stopped: Promise<void> | undefined;
    const stop = (error: Error) => { failure ??= error; stopped ??= terminateOwnedTree(child, true); };
    const abort = () => stop(antigravityCliAbortError());
    const deadline = setTimeout(() => stop(Object.assign(new Error('Antigravity model discovery timed out. Retry when the runtime is ready.'), { transient: true })), 15_000);
    deadline.unref();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) stop(new Error('Antigravity model catalog exceeded its limit.'));
      else if (!failure) output += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderr = (stderr + chunk).slice(-8192);
      if (stderrBytes > 64 * 1024) stop(new Error('Antigravity diagnostic output exceeded its limit.'));
    });
    child.on('error', () => stop(new Error('The verified Antigravity runtime could not start. Reinstall or update FLUJO.')));
    child.stdin.on('error', () => stop(new Error('Antigravity diagnostic input failed.')));
    child.stdin.end();
    child.on('close', async code => {
      clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      await stopped;
      if (failure) reject(failure);
      else if (code !== 0) {
        // Only the fixed hint leaves this function; native text may hold account details.
        const hint = antigravityCliFailureHint(stderr);
        reject(Object.assign(new Error(`Antigravity model discovery failed. Check the connection authentication and runtime.${hint}`), { transient: !hint }));
      } else {
        try { resolve(command === 'models' ? parseAntigravityModels(output) : output); }
        catch (error) { reject(error); }
      }
    });
    if (signal?.aborted) abort();
  });
}

export async function runAntigravityCli(options: {
  runtime: AntigravityCliRuntime; model: string; prompt: string; signal: AbortSignal;
  onEvent(event: AntigravityCliEvent): void; timeoutMs?: number; onStarted?: () => Promise<void>;
  /** Reopen this saved conversation. The prompt is sent only after init confirms it. */
  resumeConversationId?: string;
}): Promise<void> {
  if (options.signal.aborted) throw antigravityCliAbortError();
  await assertHostAccess('command-line-model');
  const resumeId = options.resumeConversationId;
  if (resumeId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(resumeId)) throw new AntigravityResumeMissError();
  const entry = await resolveAntigravityCliEntry();
  if (options.signal.aborted) throw antigravityCliAbortError();
  const timeoutMs = options.timeoutMs ?? ANTIGRAVITY_CLI_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Antigravity CLI execution deadline exceeded.');
  const input = `${JSON.stringify({ event: 'user', message: { content: prepareAntigravityCliPrompt(options.prompt) } })}\n`;
  if (Buffer.byteLength(input) > 32 * 1024 * 1024) throw new Error('Antigravity CLI input exceeded its limit.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(entry, ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--agent', 'flujo', '--disable-slash-commands', '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`,
      '--log-file', path.join(options.runtime.home, 'agy.log'),
      ...(resumeId ? ['--conversation', resumeId] : []),
      ...(options.model && options.model !== 'default' ? ['--model', options.model] : [])], {
      cwd: options.runtime.workingDirectory, env: options.runtime.env as NodeJS.ProcessEnv,
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let error: unknown;
    let stderr = '';
    let resultDiagnostic = '';
    let finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let treeKill: Promise<void> | undefined;
    let acknowledgement: Promise<void> | undefined;
    let initWait: NodeJS.Timeout | undefined;
    let inputSent = false;
    let stdoutBytes = 0;
    const stop = () => {
      // Force the entire owned group/tree together: if its main process exits
      // first, a descendant that ignores SIGTERM must not outlive cleanup.
      treeKill ??= terminateOwnedTree(child, true);
      killTimer ??= setTimeout(() => { if (!finished) void terminateOwnedTree(child, true); }, 1000);
      killTimer.unref();
    };
    const abort = () => { error ??= antigravityCliAbortError(); stop(); };
    const fail = (failure: unknown) => { error ??= failure; stop(); };
    const sendInput = () => {
      if (inputSent || error || options.signal.aborted) return;
      inputSent = true;
      child.stdin.end(input, () => {
        acknowledgement = Promise.resolve().then(() => !error && !options.signal.aborted ? options.onStarted?.() : undefined).catch(fail);
      });
    };
    options.signal.addEventListener('abort', abort, { once: true });
    // Do not accept partial-output SUCCESS if the CLI's own timeout races ours.
    const deadline = setTimeout(() => fail(new Error('Antigravity CLI execution deadline exceeded.')), timeoutMs);
    deadline.unref();
    const decoder = new AntigravityCliEventDecoder(event => {
      if (event.event === 'result' && typeof event.result.error === 'string') resultDiagnostic = event.result.error.slice(0, 4096);
      // An unknown conversation silently starts a new one. Check init first,
      // so a delta prompt never reaches a conversation without its history.
      if (resumeId && !inputSent) {
        if (event.event !== 'init' || event.conversation_id !== resumeId) throw new AntigravityResumeMissError();
        clearTimeout(initWait);
        options.onEvent(event);
        sendInput();
        return;
      }
      options.onEvent(event);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (error || options.signal.aborted) return;
      try {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > 64 * 1024 * 1024) throw new Error('Antigravity CLI output exceeded its limit.');
        decoder.push(chunk);
      } catch (failure) { fail(failure); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('spawn', () => {
      if (options.signal.aborted || error) { stop(); return; }
      if (!resumeId) { sendInput(); return; }
      initWait = setTimeout(() => fail(new AntigravityResumeMissError()), Math.min(RESUME_INIT_WAIT_MS, timeoutMs));
      initWait.unref();
    });
    child.on('close', async code => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(initWait);
      options.signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
      await treeKill;
      await acknowledgement;
      if (!error) { try { decoder.finish(); } catch (failure) { error ??= failure; } }
      if (!error && resumeId && !inputSent) error = new AntigravityResumeMissError();
      if (error) { reject(error); return; }
      if (code !== 0) reject(new Error(`Antigravity CLI exited with code ${code ?? 'unknown'}.${antigravityCliFailureHint(`${stderr}\n${resultDiagnostic}`)}`));
      else resolve();
    });
    if (options.signal.aborted) abort();
  });
}
