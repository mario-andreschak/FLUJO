import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { captureRuntimeChildIdentity, type RuntimeProcessIdentity } from '@/backend/services/enduringAgents/runtimeLock';

export interface ClaudeOwnedProcessRegistration {
  readonly identity: Readonly<RuntimeProcessIdentity>;
  /** Requests SDK cancellation; does not certify exit or bypass its EOF grace. */
  requestStop(): void;
  readonly exit: Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  /** Separate stream teardown evidence; exit alone does not certify pipe close. */
  readonly close: Promise<void>;
}

/** Prepared integration seam. The host must supply durable registration and
 * gate first prompt on ready, and await exit AND close before releasing its
 * Original/budget hold. It must bind registration to the accepted invocation
 * and retain the hold on registration failure or unknown exit. Installing
 * this hook alone does not implement that host protocol. One hook owns one child. */
export function createClaudeOwnedProcessSpawner(input: {
  requestSdkStop(): void;
  register(process: ClaudeOwnedProcessRegistration): Promise<void>;
  stderr?: (chunk: string) => void;
}): {
  spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess;
  readonly ready: Promise<ClaudeOwnedProcessRegistration>;
} {
  let resolve!: (value: ClaudeOwnedProcessRegistration) => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<ClaudeOwnedProcessRegistration>((yes, no) => { resolve = yes; reject = no; });
  // SDK startup can fail before its caller awaits readiness. Keep the rejection
  // observable to that caller without generating an unhandled rejection.
  void ready.catch(() => {});
  let spawned = false;
  return {
    ready,
    spawnClaudeCodeProcess(options) {
      if (spawned) throw new Error('Owned Claude process hook cannot be reused.');
      spawned = true;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(options.command, options.args, {
          // Next augments ProcessEnv with mandatory NODE_ENV; the SDK allows
          // arbitrary replacement environments. Preserve its exact map.
          cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        });
      } catch (error) {
        reject(error);
        throw error;
      }
      // SpawnedProcess exposes no stderr stream. Always drain it so a verbose
      // child cannot block; the host may route its tail to the SDK stderr sink.
      child.stderr.on('data', chunk => {
        try { input.stderr?.(String(chunk)); } catch { /* Observation cannot strand the child. */ }
      });
      const exit = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(done => {
        child.once('exit', (code, signal) => done(Object.freeze({ code, signal })));
      });
      const close = new Promise<void>(done => { child.once('close', () => done()); });
      child.on('error', error => { reject(error); });
      child.once('spawn', () => {
        void (async () => {
          try {
            const identity = Object.freeze(await captureRuntimeChildIdentity(child.pid!));
            // A fast exit during probing cannot become a live registration.
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('Child exited before registration.');
            const registration = Object.freeze({ identity, requestStop: () => input.requestSdkStop(), exit, close });
            await input.register(registration);
            resolve(registration);
          } catch (error) {
            reject(error);
            try { input.requestSdkStop(); } catch { /* Registration remains rejected. */ }
          }
        })();
      });
      return child;
    },
  };
}
