import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { SANDBOX_WORKER_SOURCE } from './sandboxWorkerSource';
import type { ScriptBinding } from './codeModeTool';

/**
 * Runs one code-mode program in a QuickJS sandbox on a worker thread (#1448).
 *
 * Why this sandbox: QuickJS compiled to WebAssembly (quickjs-emscripten, MIT)
 * needs no native build, so it behaves the same on Windows and Linux. The
 * program gets a fresh interpreter with no Node APIs at all; its memory is a
 * WebAssembly heap with a hard size limit, and an interrupt handler stops code
 * that keeps the CPU busy. Node's `vm` module is not a security boundary, and
 * isolated-vm needs a native build per Node/Electron version.
 *
 * The worker keeps the program off the app's event loop. The parent owns the
 * wall-clock limit and ends the worker when it passes, when the run stops, or
 * when the program finishes.
 */

export interface ScriptLimits {
  /** Wall-clock time for the whole program, tool calls and approvals included. */
  timeoutMs: number;
  /** Longest stretch of program code without a pause (an endless loop ends here). */
  busyMs: number;
  /** Heap size of the QuickJS interpreter. */
  memoryBytes: number;
  stackBytes: number;
  /** Tool calls one program may make. */
  maxCalls: number;
  /** Tool calls running at the same time; more wait their turn. */
  maxParallelCalls: number;
  /** console output kept for the model. */
  maxLogChars: number;
}

const MB = 1024 * 1024;

/** Interpreter memory scales with the machine: 1/128 of RAM, between 32 MB and 256 MB. */
export function defaultScriptMemoryBytes(totalMemory = os.totalmem()): number {
  return Math.min(256 * MB, Math.max(32 * MB, Math.floor(totalMemory / 128)));
}

export function defaultScriptLimits(): ScriptLimits {
  return {
    timeoutMs: 10 * 60 * 1000,
    busyMs: 10 * 1000,
    memoryBytes: defaultScriptMemoryBytes(),
    stackBytes: 1 * MB,
    maxCalls: 1000,
    maxParallelCalls: 8,
    maxLogChars: 20_000,
  };
}

/** How many programs may run at once: half the CPU cores, at least two. */
export function scriptSlotCount(processors = os.availableParallelism?.() ?? os.cpus().length): number {
  return Math.max(2, Math.floor(processors / 2));
}

/** How long a program waits for a free slot before it reports that FLUJO is busy. */
export const SCRIPT_SLOT_WAIT_MS = 2 * 60 * 1000;

export type ScriptCallReply = { ok: true; value: unknown } | { ok: false; error: string };

export interface ScriptCallRecord {
  name: string;
  ok: boolean;
}

export interface ScriptRunInput {
  code: string;
  bindings: readonly ScriptBinding[];
  /** Checks, approves and runs one tool call. Never throws for an ordinary tool error. */
  invoke: (name: string, args: Record<string, unknown>) => Promise<ScriptCallReply>;
  signal?: AbortSignal;
  limits?: Partial<ScriptLimits>;
}

export interface ScriptRunOutcome {
  ok: boolean;
  /** The program's return value, parsed from JSON. */
  result?: unknown;
  error?: string;
  logs: string;
  logsTrimmed: boolean;
  calls: ScriptCallRecord[];
  durationMs: number;
}

interface Waiter {
  grant: () => void;
}

/** Program slots. A slot is always given back in `finally`, so a failure never keeps one. */
class ScriptSlots {
  private used = 0;
  private readonly waiters: Waiter[] = [];

  constructor(private readonly capacity: () => number) {}

  async acquire(waitMs: number, signal?: AbortSignal): Promise<() => void> {
    if (this.used < this.capacity()) return this.take();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          cleanup();
          resolve(this.take());
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error('The run stopped before the program started.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`FLUJO is running ${this.capacity()} programs already and none finished within ${Math.round(waitMs / 1000)} seconds. Try again shortly.`));
      }, waitMs);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private take(): () => void {
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      this.waiters[0]?.grant();
    };
  }
}

const slots = new ScriptSlots(() => scriptSlotCount());

interface SandboxModulePaths {
  corePath: string;
  variantPath: string;
}

let modulePaths: SandboxModulePaths | undefined;

/** The installed QuickJS files, found from the app folder like the other bundled runtimes. */
function sandboxModulePaths(): SandboxModulePaths {
  if (modulePaths) return modulePaths;
  const requireFromApp = createRequire(path.join(process.cwd(), 'package.json'));
  modulePaths = {
    corePath: requireFromApp.resolve('quickjs-emscripten-core'),
    variantPath: requireFromApp.resolve('@jitl/quickjs-wasmfile-release-sync'),
  };
  return modulePaths;
}

function parseResult(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value === undefined ? null : value);
  } catch {
    return JSON.stringify(String(value));
  }
}

export async function runToolScript(input: ScriptRunInput): Promise<ScriptRunOutcome> {
  const limits = { ...defaultScriptLimits(), ...input.limits };
  const started = Date.now();
  const calls: ScriptCallRecord[] = [];
  const failed = (error: string): ScriptRunOutcome => ({
    ok: false, error, logs: '', logsTrimmed: false, calls, durationMs: Date.now() - started,
  });
  if (input.signal?.aborted) return failed('The run stopped before the program started.');

  let release: () => void;
  try {
    release = await slots.acquire(SCRIPT_SLOT_WAIT_MS, input.signal);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  let paths: SandboxModulePaths;
  try {
    paths = sandboxModulePaths();
  } catch (error) {
    release();
    return failed(`The script sandbox is not installed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return new Promise<ScriptRunOutcome>((resolve) => {
    let settled = false;
    let running = 0;
    const queue: Array<() => void> = [];
    const worker = new Worker(SANDBOX_WORKER_SOURCE, {
      eval: true,
      workerData: {
        ...paths,
        code: input.code,
        bindings: input.bindings,
        memoryBytes: limits.memoryBytes,
        stackBytes: limits.stackBytes,
        sliceMs: limits.busyMs,
        maxLogChars: limits.maxLogChars,
      },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });

    const finish = (outcome: Omit<ScriptRunOutcome, 'calls' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      queue.length = 0;
      void worker.terminate().catch(() => undefined);
      release();
      resolve({ ...outcome, calls, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => finish({
      ok: false,
      error: `The program ran longer than ${Math.round(limits.timeoutMs / 1000)} seconds and was stopped.`,
      logs: '',
      logsTrimmed: false,
    }), limits.timeoutMs);
    timer.unref?.();

    const onAbort = () => finish({ ok: false, error: 'The run stopped, so the program was stopped.', logs: '', logsTrimmed: false });
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const reply = (id: number, answer: ScriptCallReply) => {
      if (settled) return;
      worker.postMessage(answer.ok
        ? { type: 'result', id, ok: true, value: serialize(answer.value) }
        : { type: 'result', id, ok: false, error: answer.error });
    };

    const startCall = (id: number, name: string, argsText: string) => {
      running++;
      void (async () => {
        let answer: ScriptCallReply;
        try {
          const parsed: unknown = JSON.parse(argsText);
          const args = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : {};
          answer = await input.invoke(name, args);
        } catch (error) {
          answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        calls.push({ name, ok: answer.ok });
        running--;
        reply(id, answer);
        queue.shift()?.();
      })();
    };

    worker.on('message', (message: { type?: string; id?: number; name?: string; args?: string; ok?: boolean; result?: string; error?: string; logs?: string; logsTrimmed?: boolean }) => {
      if (settled || !message) return;
      if (message.type === 'call' && typeof message.id === 'number' && typeof message.name === 'string') {
        const { id, name } = message;
        const argsText = typeof message.args === 'string' ? message.args : '{}';
        if (calls.length + running + queue.length >= limits.maxCalls) {
          reply(id, { ok: false, error: `A program may make at most ${limits.maxCalls} tool calls. Split the work into several programs.` });
          return;
        }
        if (running < limits.maxParallelCalls) startCall(id, name, argsText);
        else queue.push(() => startCall(id, name, argsText));
        return;
      }
      if (message.type === 'done') {
        finish({
          ok: message.ok === true,
          result: message.ok === true ? parseResult(message.result) : undefined,
          error: message.ok === true ? undefined : message.error ?? 'The program failed.',
          logs: message.logs ?? '',
          logsTrimmed: message.logsTrimmed === true,
        });
      }
    });
    worker.on('error', (error) => finish({ ok: false, error: `The program stopped: ${error.message}`, logs: '', logsTrimmed: false }));
    worker.on('exit', () => finish({ ok: false, error: 'The program stopped unexpectedly.', logs: '', logsTrimmed: false }));
  });
}
