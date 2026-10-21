import { Duplex } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { Ledger } from './ledger.js';
import { LocalEngine } from './local-engine.js';

interface Connection { pipe: Duplex; closed: Promise<void>; stop: () => void; }

/** HTTP uses the owned child's stdio directly, on Windows and POSIX. There is
 * no host listening socket, shared connection pool or network fallback. */
export class RuntimePipes {
  private readonly children = new Map<ChildProcessWithoutNullStreams, Connection>();
  private readonly counts = new Map<string, number>();
  private closing = false;
  constructor(readonly config: ControllerConfig, readonly ledger: Ledger, readonly engine: Pick<LocalEngine, 'spawn'>) {}

  connect(runtime: Runtime, channel: 'application' | 'sandbox' = 'application'): Duplex {
    const intent = this.ledger.intents().find(item => item.runtimeId === runtime.id);
    const revision = runtimeRevision(this.config, runtime);
    if (!['application', 'sandbox'].includes(channel) || this.closing || !runtime.localRuntime || !intent || intent.desired !== 'running'
        || !this.ledger.available(runtime, revision)
        || this.children.size >= 64 || (this.counts.get(runtime.id) ?? 0) >= 8) {
      throw new Error('Local runtime transport is unavailable.');
    }
    const child = this.engine.spawn(runtime.localRuntime, ['container', 'exec', '--interactive', '--user', '1000:1000',
      '--workdir', '/app', runtime.localRuntime.containerId, '/usr/local/bin/node', '/app/packages/shared-controller/dist/runtime-bridge.js',
      ...(channel === 'sandbox' ? ['--sandbox'] : [])]);
    const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // A spawn failure can precede the HTTP client's listeners. Keep it handled;
    // the client still receives the same error event and returns a generic 502.
    pipe.on('error', () => {});
    this.counts.set(runtime.id, (this.counts.get(runtime.id) ?? 0) + 1);
    let done = false;
    let errorBytes = 0;
    let kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (done) return;
      done = true;
      clearInterval(current);
      clearTimeout(lifetime);
      pipe.destroy(); child.stdin.destroy(); child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        kill = setTimeout(() => child.kill('SIGKILL'), 5000);
        kill.unref();
      }
    };
    const current = setInterval(() => {
      try {
        if (this.closing || !this.ledger.intentCurrent(intent)
            || !this.ledger.available(runtime, revision)) stop();
      } catch { stop(); }
    }, 1000);
    current.unref();
    const lifetime = setTimeout(stop, 60 * 60 * 1000); lifetime.unref();
    const closed = new Promise<void>(resolve => child.once('close', code => {
      clearInterval(current); clearTimeout(lifetime); clearTimeout(kill);
      this.children.delete(child);
      this.counts.set(runtime.id, (this.counts.get(runtime.id) ?? 1) - 1);
      // Successful stdout must drain before HTTP consumes EOF. Destroying the
      // duplex here would truncate buffered responses when the child exits fast.
      if (code !== 0) pipe.destroy(new Error('Local runtime transport failed.'));
      resolve();
    }));
    this.children.set(child, { pipe, closed, stop });
    child.once('error', () => { pipe.destroy(new Error('Local runtime transport failed.')); stop(); });
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 16 * 1024) stop(); });
    pipe.once('close', stop);
    return pipe;
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = [...this.children.values()];
    for (const connection of pending) connection.stop();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(pending.map(connection => connection.closed)), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Local transport exit is unconfirmed.')), 10_000);
      })]);
    } finally {
      clearTimeout(deadline);
      // A failed kill is reported above. Do not hang controller shutdown or claim
      // that the runtime's jobs stopped merely because its HTTP transport ended.
      for (const child of this.children.keys()) { child.stderr.destroy(); child.unref(); }
    }
  }
}
