import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { spawnGrantedPackageRunner, writeGrantedPackageRunner, releaseDrainedPackageRunner,
  PackageRunnerSpawnUncertain } from '@/backend/services/security/packageRunnerGrant';
import type { PreparedPackageRunnerIntent } from '@/backend/services/security/packageRunnerIntent';
import { AdmittedDispatchDrain } from './admittedDispatchDrain';

const retained = new Set<ControlledPackageRunnerTransport>();
const asError = (error: unknown) => error instanceof Error ? error : new Error('Controlled runner failure', { cause: error });

/** Explicit modified-npm candidate transport. Not installed into production's
 * ordinary npx/trusted-host path. Uses the actual SDK framing contract and a
 * guarded real child, never SDK spawning that would bypass the grant fence.
 * Exit/close/drain proves only this owned parent; Windows descendant/job
 * containment and original stock-npx acceptance remain unqualified.
 */
export class ControlledPackageRunnerTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private readonly controller = new AbortController();
  private readonly buffer = new ReadBuffer({ maxBufferSize: 256 * 1024 });
  private child?: ChildProcessWithoutNullStreams;
  private started = false;
  private retiring = false;
  private closed = false;
  private exited = false;
  private childClosed = false;
  private stdoutEnded = false;
  private stderrEnded = false;
  private starting?: Promise<void>;
  private startingSettled = false;
  private startingFailure?: unknown;
  private closing?: Promise<void>;
  private settled?: () => void;
  private readonly terminal = new Promise<void>(resolve => { this.settled = resolve; });
  private writes: Promise<void> = Promise.resolve();
  private readonly dispatches = new AdmittedDispatchDrain(() => this.finish());
  private readonly abort = () => { void this.close().catch(error => this.report(error)); };

  constructor(private readonly request: Request, private readonly intent: PreparedPackageRunnerIntent,
    private readonly serverName: string) {}

  private report(error: unknown): void {
    try { this.onerror?.(asError(error)); } catch { /* Callback cannot interrupt owned cleanup. */ }
  }

  private finish(): void {
    if (this.closed || !this.child || !this.exited || !this.childClosed || !this.stdoutEnded || !this.stderrEnded) return;
    this.retiring = true;
    this.controller.abort();
    void this.dispatches.seal();
    if (!this.startingSettled || this.startingFailure || this.dispatches.pending || this.dispatches.failures.length) return;
    try { releaseDrainedPackageRunner(this.child); } catch (error) { this.report(error); return; }
    this.closed = true;
    this.retiring = true;
    this.controller.abort();
    this.request.signal.removeEventListener('abort', this.abort);
    this.buffer.clear();
    retained.delete(this);
    this.settled?.();
    try { this.onclose?.(); } catch (error) { this.report(error); }
  }

  private observe = (child: ChildProcessWithoutNullStreams): void => {
    this.child = child;
    retained.add(this);
    child.once('exit', () => { this.exited = true; this.finish(); });
    child.once('close', () => { this.childClosed = true; this.finish(); });
    child.stdout.once('end', () => { this.stdoutEnded = true; this.finish(); });
    child.stderr.once('end', () => { this.stderrEnded = true; this.finish(); });
    const failed = (error: Error) => { this.report(error); this.abort(); };
    child.on('error', failed);
    child.stdin.on('error', failed);
    child.stdout.on('error', failed);
    child.stderr.on('error', failed);
    // Drain actual stderr without accumulating package output in memory.
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.retiring) return; // flowing stream still drains to actual end.
      try {
        this.buffer.append(chunk);
        for (;;) {
          const message = this.buffer.readMessage();
          if (!message) break;
          this.onmessage?.(message);
          if (this.retiring) break;
        }
      } catch (error) { failed(asError(error)); }
    });
    if (this.retiring) child.kill('SIGTERM');
  };

  start(): Promise<void> {
    if (this.started || this.retiring) return Promise.reject(new Error('Controlled runner transport cannot restart'));
    this.started = true;
    retained.add(this);
    this.request.signal.addEventListener('abort', this.abort, { once: true });
    this.starting = (async () => {
      try {
        if (this.request.signal.aborted) throw new Error('Runner request aborted before start');
        await spawnGrantedPackageRunner(this.request, this.intent, this.serverName, this.controller.signal, this.observe);
        if (this.retiring || this.closed) throw new Error('Runner retired during start');
      } catch (error) {
        this.startingFailure = error;
        // The real child survives post-spawn cleanup failure in the exception;
        // it already has stream/exit listeners installed synchronously.
        if (error instanceof PackageRunnerSpawnUncertain && !this.child) this.observe(error.child);
        this.retiring = true;
        this.controller.abort();
        this.report(error);
        throw error;
      } finally {
        this.startingSettled = true;
        this.finish();
      }
    })();
    void this.starting.catch(() => { this.abort(); });
    return this.starting;
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.retiring || this.closed || this.dispatches.pending >= 16) return Promise.reject(new Error('Controlled runner dispatch unavailable'));
    // Wire-size check follows serialization; this does not bound allocation
    // while serializing a caller-supplied object.
    const bytes = serializeMessage(message);
    if (Buffer.byteLength(bytes) > 256 * 1024) return Promise.reject(new Error('Controlled runner message exceeds bound'));
    const preceding = this.writes;
    const operation = this.dispatches.admit(() => preceding.then(async () => {
      if (this.retiring || !this.child) throw new Error('Controlled runner retired before queued dispatch');
      await writeGrantedPackageRunner(this.child, bytes, this.controller.signal);
    }));
    this.writes = operation.catch(error => { this.report(error); this.abort(); });
    return operation;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closing) return this.closing;
    this.retiring = true;
    this.controller.abort();
    const dispatchSettlement = this.dispatches.seal();
    this.closing = (async () => {
      const deadline = Date.now() + 5_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned runner exit/close/drain unresolved; ownership retained')), 5_000);
      });
      try {
        // Retire an already spawned parent even if start's held-file cleanup
        // is still awaiting settlement. A late observed child sees retiring.
        this.child?.stdin.end();
        this.child?.kill('SIGTERM');
        escalation = setTimeout(() => {
          if (!this.closed) {
            try { this.child?.kill('SIGKILL'); } catch (error) { this.report(error); }
          }
        }, Math.min(2_000, Math.max(0, deadline - Date.now())));
        // Start may be in asynchronous authority validation. It must settle
        // before absence of a child can be treated as an actual no-spawn result.
        await Promise.race([this.starting?.catch(() => {}), timeout]);
        // Abort only retires admission. The real admitted operations must
        // settle through their authority/FD cleanup before release succeeds.
        await Promise.race([dispatchSettlement, timeout]);
        if (this.dispatches.failures.length) throw new AggregateError(this.dispatches.failures,
          'Admitted dispatch failed; parent and cleanup ownership retained');
        if (this.startingFailure) throw new AggregateError([this.startingFailure],
          'Runner start failed; actual cleanup ownership retained');
        if (!this.child) {
          this.closed = true;
          retained.delete(this);
          this.request.signal.removeEventListener('abort', this.abort);
          this.settled?.();
          try { this.onclose?.(); } catch (error) { this.report(error); }
          return;
        }
        if (!this.closed) {
          await Promise.race([this.terminal, timeout]);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        // A timeout never sets closed, clears ownership or invents stream ends.
        if (!this.closed) this.closing = undefined;
      }
    })();
    return this.closing;
  }
}
