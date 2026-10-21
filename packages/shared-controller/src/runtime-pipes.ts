import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { assertPrivateDirectory } from './private-storage.js';
import { Ledger } from './ledger.js';
import { LocalEngine } from './local-engine.js';
import type { RuntimeIntent } from './local-runtime-policy.js';

/** Private host-local HTTP socket -> owned Docker exec pipe -> container's own
 * loopback. No published port, LAN interface, container bridge or host gateway. */
export class RuntimePipes {
  private directory?: string;
  private readonly paths = new Map<string, string>();
  private readonly servers: Server[] = [];
  private readonly clients = new Set<Socket>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly counts = new Map<string, number>();
  private closing = false;
  constructor(readonly config: ControllerConfig, readonly ledger: Ledger, readonly engine: LocalEngine) {}

  async open(): Promise<void> {
    assertPrivateDirectory(this.config.stateDirectory);
    this.directory = mkdtempSync(join(this.config.stateDirectory, 'pipes-'));
    assertPrivateDirectory(this.directory);
    try {
      for (const runtime of this.config.runtimes.filter(item => item.localRuntime)) {
        const path = join(this.directory, `${this.paths.size}.sock`);
        if (Buffer.byteLength(path) > 100) throw new Error('Private socket path is too long.');
        const server = createServer(socket => this.connect(runtime, socket));
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(path, () => { server.off('error', reject); resolve(); });
        });
        server.on('error', () => { this.paths.delete(runtime.id); });
        this.paths.set(runtime.id, path);
      }
    } catch (error) { await this.close(); throw error; }
  }

  path(runtime: Runtime): string | undefined { return this.closing ? undefined : this.paths.get(runtime.id); }

  private connect(runtime: Runtime, socket: Socket): void {
    socket.on('error', () => socket.destroy());
    let intent: RuntimeIntent | undefined;
    let available = false;
    try {
      intent = this.ledger.intents().find(item => item.runtimeId === runtime.id);
      available = this.ledger.available(runtime, runtimeRevision(this.config, runtime));
    } catch { socket.destroy(); return; }
    if (this.closing || !runtime.localRuntime || !intent || intent.desired !== 'running'
        || !available
        || this.children.size >= 64 || (this.counts.get(runtime.id) ?? 0) >= 8) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.engine.spawn(runtime.localRuntime, ['container', 'exec', '--interactive', '--user', '1000:1000',
        '--workdir', '/app', runtime.localRuntime.containerId, '/usr/local/bin/node', '/app/packages/shared-controller/dist/runtime-bridge.js']);
    } catch { socket.destroy(); return; }
    this.children.add(child); this.clients.add(socket);
    this.counts.set(runtime.id, (this.counts.get(runtime.id) ?? 0) + 1);
    let done = false;
    let errorBytes = 0;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(current);
      socket.destroy(); child.stdin.destroy(); child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
        kill.unref(); child.once('close', () => clearTimeout(kill));
      }
      this.clients.delete(socket);
      this.counts.set(runtime.id, (this.counts.get(runtime.id) ?? 1) - 1);
    };
    const current = setInterval(() => {
      try {
        if (this.closing || !this.ledger.intentCurrent(intent)
            || !this.ledger.available(runtime, runtimeRevision(this.config, runtime))) finish();
      } catch { finish(); }
    }, 1000);
    current.unref();
    child.once('error', finish); child.stdin.once('error', finish); child.stdout.once('error', finish);
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 16 * 1024) finish(); });
    child.once('close', () => { this.children.delete(child); finish(); });
    socket.once('close', finish);
    socket.pipe(child.stdin); child.stdout.pipe(socket);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const socket of this.clients) socket.destroy();
    for (const child of this.children) { child.stdin.destroy(); child.kill(); }
    await Promise.all(this.servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    if (this.directory) {
      // Only the uniquely created, now-empty directory owned by this instance.
      // Node removes each listening Unix socket when its server closes.
      try { rmdirSync(this.directory); } catch { /* Preserve unexpected contents for inspection. */ }
    }
  }
}
