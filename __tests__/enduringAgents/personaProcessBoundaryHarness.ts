import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface PersonaProcessEnvironment {
  sandboxRoot: string;
  dataDir: string;
  rootsDir: string;
  workspaceId: string;
}

export interface PersonaLeaseFence {
  workspaceId: string;
  personaId: string;
  activityId: string;
  leaseId: string;
  holderId: string;
  fencingToken: number;
}

export type PersonaProcessCommand =
  | {
      type: 'createPersona';
      name: string;
      idempotencyKey: string;
      coreFlowRef: string;
      interruptionPolicy?: 'queue' | 'related_only' | 'interruptible';
    }
  | {
      type: 'enqueue' | 'route';
      input: {
        personaId: string;
        idempotencyKey: string;
        kind: 'interactive_chat' | 'assignment' | 'scheduled' | 'triggered' | 'meeting' | 'voice';
        source: {
          kind: 'chat' | 'assignment' | 'schedule' | 'trigger' | 'meeting' | 'voice';
          sourceId: string;
          idempotencyKey?: string;
        };
        summary: string;
        relationKey?: string;
        relatedAction?: 'queue' | 'steer' | 'coalesce' | 'interrupt';
      };
    }
  | { type: 'claim'; personaId: string; ttlMs?: number }
  | { type: 'release'; fence: PersonaLeaseFence }
  | { type: 'reconcile'; personaId: string }
  | { type: 'complete'; fence: PersonaLeaseFence }
  | { type: 'assertFence'; fence: PersonaLeaseFence }
  | { type: 'inspect'; personaId: string }
  | { type: 'appendEvent'; personaId: string; event: Record<string, unknown> }
  | { type: 'readEvents'; personaId: string }
  | { type: 'shutdown' };

interface WireSuccess {
  id: number;
  ok: true;
  value: unknown;
}

interface WireFailure {
  id: number;
  ok: false;
  error: { name: string; message: string; code?: string };
}

type WireResponse = WireSuccess | WireFailure;
type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

/**
 * How long a freshly spawned Persona child gets to print its `ready` line
 * (issue #457).
 *
 * The child transpiles the whole enduringAgents dependency graph on startup,
 * so the budget is dominated by machine speed, not by product behaviour. It
 * used to be a bare `10_000` literal, which turned every slow CI runner into a
 * "flaky test". Keep it explicit, generous, and overridable per environment.
 */
export const READINESS_TIMEOUT_MS = Number(
  process.env.FLUJO_PERSONA_CHILD_READY_TIMEOUT_MS ?? 60_000,
);

/**
 * Every child this module has spawned and not yet reaped. A readiness timeout
 * used to leak the child: `startPersonaProcess` threw before returning a
 * client, so the test's afterEach never saw it and the orphan kept burning CPU
 * for the rest of the run — making every subsequent test slower and more
 * likely to time out in turn.
 */
const liveChildren = new Set<ChildProcess>();
let sweeperInstalled = false;

function trackChild(child: ChildProcess): void {
  liveChildren.add(child);
  child.once('exit', () => liveChildren.delete(child));
  if (sweeperInstalled) return;
  sweeperInstalled = true;
  process.once('exit', () => {
    for (const orphan of liveChildren) {
      try {
        orphan.kill('SIGKILL');
      } catch {
        // Best effort: the process is already exiting.
      }
    }
    liveChildren.clear();
  });
}

/** Kill anything still running. Safe to call from an afterAll hook. */
export function killOrphanedPersonaChildren(): number {
  let killed = 0;
  for (const orphan of [...liveChildren]) {
    if (orphan.exitCode === null && orphan.signalCode === null) {
      try {
        orphan.kill('SIGKILL');
        killed += 1;
      } catch {
        // Already gone.
      }
    }
    liveChildren.delete(orphan);
  }
  return killed;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      // The budget is part of the message: withTimeout is shared by readiness,
      // reply and exit waits, so without it every timeout looks identical in a
      // CI log.
      timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${description} after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

function exitWaiter(child: ChildProcess): Promise<ExitResult> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

export async function createPersonaProcessEnvironment(
  label = 'continuity',
): Promise<PersonaProcessEnvironment> {
  const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), `flujo-persona-${label}-`));
  const dataDir = path.join(sandboxRoot, 'data');
  const rootsDir = path.join(sandboxRoot, 'roots');
  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(rootsDir, { recursive: true }),
  ]);
  return {
    sandboxRoot,
    dataDir,
    rootsDir,
    workspaceId: `persona-process-${process.pid}-${Date.now()}`,
  };
}

export async function removePersonaProcessEnvironment(
  environment: PersonaProcessEnvironment,
): Promise<void> {
  await fs.rm(environment.sandboxRoot, { recursive: true, force: true });
}

export interface PersonaProcessClient {
  child: ChildProcess;
  request<T = unknown>(command: PersonaProcessCommand, timeoutMs?: number): Promise<T>;
  kill(): Promise<ExitResult>;
  close(): Promise<ExitResult>;
  waitForExit(timeoutMs?: number): Promise<ExitResult>;
}

export async function startPersonaProcess(
  environment: PersonaProcessEnvironment,
): Promise<PersonaProcessClient> {
  const fixture = path.resolve(__dirname, 'fixtures', 'personaProcess.cjs');
  const child = spawn(process.execPath, [fixture, environment.workspaceId], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLUJO_DATA_DIR: environment.dataDir,
      FLUJO_FS_ROOTS: environment.rootsDir,
      FLUJO_BASH_ROOTS: environment.rootsDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  trackChild(child);
  const spawnedAt = Date.now();
  const exited = exitWaiter(child);
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  let stderr = '';
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const lines = readline.createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    let message: ({ type: 'ready'; pid: number } | WireResponse);
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if ('type' in message) {
      if (message.type === 'ready') readyResolve();
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.value);
      return;
    }
    const error = Object.assign(new Error(message.error.message), {
      name: message.error.name,
      code: message.error.code,
    });
    waiter.reject(error);
  });
  child.once('error', (error) => {
    lines.close();
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.once('exit', (code, signal) => {
    lines.close();
    const error = new Error(
      `Persona child exited before replying (code=${code}, signal=${signal}).${stderr ? `\n${stderr}` : ''}`,
    );
    readyReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const waitForExit = (timeoutMs = 5_000) => withTimeout(
    exited,
    timeoutMs,
    `Persona child ${child.pid} to exit`,
  );

  try {
    await withTimeout(ready, READINESS_TIMEOUT_MS, `Persona child ${child.pid} readiness`);
  } catch (error) {
    // Never leave the child behind: nothing else holds a reference to it yet.
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForExit(2_000).catch(() => undefined);
    liveChildren.delete(child);
    const elapsedMs = Date.now() - spawnedAt;
    const tail = stderr.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
    throw Object.assign(
      new Error(
        `Persona child ${child.pid} never became ready (elapsed ${elapsedMs} ms, budget ${READINESS_TIMEOUT_MS} ms; `
        + 'override with FLUJO_PERSONA_CHILD_READY_TIMEOUT_MS).'
        + `${tail ? `\nChild stderr tail:\n${tail}` : '\nThe child produced no stderr output.'}`,
      ),
      { cause: error },
    );
  }

  const request = <T = unknown>(
    command: PersonaProcessCommand,
    timeoutMs = 10_000,
  ): Promise<T> => {
    if (!child.stdin || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error('Persona child is not running.'));
    }
    const id = nextId;
    nextId += 1;
    const response = new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
      child.stdin!.write(`${JSON.stringify({ id, command })}\n`, (error) => {
        if (!error) return;
        pending.delete(id);
        reject(error);
      });
    });
    return withTimeout(response, timeoutMs, `Persona command ${command.type}`);
  };

  return {
    child,
    request,
    waitForExit,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      return waitForExit();
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await request({ type: 'shutdown' }, 1_000).catch(() => undefined);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      try {
        return await waitForExit(2_000);
      } catch {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        return waitForExit(2_000);
      }
    },
  };
}

export function restartPersonaProcess(
  environment: PersonaProcessEnvironment,
): Promise<PersonaProcessClient> {
  return startPersonaProcess(environment);
}

export async function waitFor<T>(
  operation: () => Promise<T>,
  accept: (value: T) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (accept(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 20));
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${options.description ?? 'condition'}.${suffix}`);
}
