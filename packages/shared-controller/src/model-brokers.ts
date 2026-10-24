import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { Ledger } from './ledger.js';
import type { LocalEngine } from './local-engine.js';
import { ModelChannel, runtimeModelFrame } from './model-channel.js';
import { admittedModelBody, MODEL_LIFETIME_MS, type ModelGrant } from './model-grant.js';
import { localModelRequest } from './local-model-request.js';
import type { RuntimeIntent } from './local-runtime-policy.js';
import { TeamModelAccess } from './team-model-access.js';

interface Job { abort: AbortController; current: () => boolean; sequence: number;
  credit?: { sequence: number; resolve: () => void; reject: () => void }; }
interface Connection { stop: () => void; closed: Promise<void>; required: () => boolean; }

/** One fixed exec channel per configured owner, tied to observed local runtime
 * identity. Runtime input never chooses its actor, endpoint, credential or URL. */
export class ModelBrokers {
  private readonly connections = new Map<string, Connection>();
  private readonly jobs = new Set<Job>();
  private readonly retries = new Map<string, { count: number; next: number }>();
  private timer?: ReturnType<typeof setTimeout>; private stopping = false;
  private readonly teamModels: TeamModelAccess;
  constructor(readonly config: ControllerConfig, readonly ledger: Ledger, readonly engine: Pick<LocalEngine, 'spawn'>) {
    this.teamModels = new TeamModelAccess(config, ledger);
  }

  start(): void {
    const tick = () => {
      if (this.stopping) return;
      try {
        const required = (runtime: Runtime) => Boolean(runtime.modelGrants?.length) || this.teamModels.hasAccess(runtime);
        const ordered = this.config.runtimes.filter(runtime => runtime.localRuntime)
          .map(runtime => ({ runtime, required: required(runtime) })).sort((a, b) => Number(b.required) - Number(a.required));
        for (const { runtime, required: needsExecution } of ordered) {
          if (this.connections.has(runtime.id) || (this.retries.get(runtime.id)?.next ?? 0) > performance.now()) continue;
          const intent = this.ledger.intents().find(item => item.runtimeId === runtime.id);
          if (!intent || !runtime.localRuntime || !this.ledger.available(runtime, runtimeRevision(this.config, runtime))) continue;
          if (this.connections.size >= 64) {
            // A catalogue-only channel cannot starve an explicitly granted
            // execution channel. Retain the retiring slot until observed exit.
            if (needsExecution) [...this.connections.values()].find(connection => !connection.required())?.stop();
            continue;
          }
          this.open(runtime, intent);
        }
      } catch { /* Missing current ledger evidence prevents new channels. */ }
      this.timer = setTimeout(tick, 1000);
    };
    tick();
  }

  private open(runtime: Runtime, intent: RuntimeIntent): void {
    const revision = runtimeRevision(this.config, runtime);
    const child = this.engine.spawn(intent.policy, ['container', 'exec', '--interactive', '--user', '1000:1000', '--workdir', '/app',
      intent.policy.containerId, '/usr/local/bin/node', '/app/packages/shared-controller/dist/runtime-model-broker.js']);
    let stopped = false; let ready = false; let lastHeartbeat = performance.now(); let diagnostics = 0;
    const started = performance.now(); const jobs = new Map<string, Job>();
    let kill: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && !this.stopping && this.ledger.intentCurrent(intent) && this.ledger.available(runtime, revision);
    const cancel = (job: Job) => { job.abort.abort(); job.credit?.reject(); job.credit = undefined; };
    const stop = () => {
      if (stopped) return; stopped = true;
      clearInterval(watch); for (const job of jobs.values()) cancel(job);
      channel.close(); child.stdin.destroy(); child.stdout.destroy();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(); kill = setTimeout(() => child.kill('SIGKILL'), 5000); kill.unref();
      }
    };
    const sendError = (id: string, code: 'denied' | 'invalid_request' | 'busy' | 'unavailable') => {
      void channel.send({ type: 'error', id, code }).catch(stop);
    };
    const request = async (id: string, grant: ModelGrant | undefined, operation: 'configuration' | 'models' | 'chat' | 'embeddings', body: unknown,
      authorized: () => boolean, configuration?: unknown) => {
      const job: Job = { abort: new AbortController(), sequence: 0,
        current: () => current() && authorized() };
      jobs.set(id, job); this.jobs.add(job);
      const deadline = setTimeout(() => cancel(job), MODEL_LIFETIME_MS);
      try {
        const chunk = async (bytes: Buffer) => {
          if (job.abort.signal.aborted || !job.current()) throw new Error('Model grant revoked.');
          const sequence = job.sequence++;
          const credit = new Promise<void>((resolve, reject) => { job.credit = { sequence, resolve, reject: () => reject(new Error('Model response cancelled.')) }; });
          // Attach before writing: cancellation can occur while stdin is backpressured.
          const written = channel.send({ type: 'chunk', id, sequence, bytes: bytes.toString('base64') });
          await Promise.all([written, credit]);
        };
        if (operation === 'configuration') {
          if (!job.current()) throw new Error('Model grant revoked.');
          const bytes = Buffer.from(JSON.stringify(configuration));
          await channel.send({ type: 'headers', id, contentType: 'application/json' });
          for (let at = 0; at < bytes.length; at += 48 * 1024) await chunk(bytes.subarray(at, at + 48 * 1024));
        } else {
          if (!grant) throw new Error('No model grant.');
          await localModelRequest(grant, operation, body, job.abort.signal, job.current,
            contentType => channel.send({ type: 'headers', id, contentType }), chunk);
        }
        if (!job.current() || job.abort.signal.aborted) throw new Error('Model grant revoked.');
        await channel.send({ type: 'end', id });
      } catch { if (!stopped) sendError(id, 'unavailable'); }
      finally { clearTimeout(deadline); cancel(job); jobs.delete(id); this.jobs.delete(job); }
    };
    const channel = new ModelChannel(child.stdout, child.stdin, raw => {
      const frame = runtimeModelFrame.parse(raw);
      if (!current()) { stop(); return; }
      if (frame.type === 'ready') { if (ready) throw new Error('Duplicate ready.'); ready = true; lastHeartbeat = performance.now(); return; }
      if (frame.type === 'pong') { lastHeartbeat = performance.now(); return; }
      if (!ready) throw new Error('Model channel not ready.');
      if (frame.type === 'cancel') { const job = jobs.get(frame.id); if (job) cancel(job); return; }
      if (frame.type === 'ack') {
        const job = jobs.get(frame.id); if (!job || job.abort.signal.aborted) return;
        if (!job.credit || job.credit.sequence !== frame.sequence) throw new Error('Unexpected response credit.');
        job.credit.resolve(); job.credit = undefined; return;
      }
      if (jobs.has(frame.id)) throw new Error('Duplicate model request.');
      if (jobs.size >= 4 || this.jobs.size >= 16) { sendError(frame.id, 'busy'); return; }
      if (frame.type === 'team-catalogue' || frame.type === 'team-resolve') {
        try {
          if (frame.type === 'team-catalogue') {
            const page = this.teamModels.catalogue(runtime, frame.after);
            void request(frame.id, undefined, 'configuration', undefined,
              () => page.entries.every(entry => this.teamModels.current(runtime, entry.reference)), page).catch(stop);
          } else {
            const snapshot = this.teamModels.resolve(runtime, frame.teamId, frame.resourceId);
            const reference = { teamId: snapshot.teamId, resourceId: snapshot.resourceId, teamName: snapshot.teamName,
              version: snapshot.version, generation: snapshot.generation };
            void request(frame.id, undefined, 'configuration', undefined, () => this.teamModels.current(runtime, snapshot),
              { reference, document: snapshot.document }).catch(stop);
          }
        } catch { sendError(frame.id, 'denied'); }
        return;
      }
      if (frame.type === 'team-request') {
        let admission;
        try { admission = this.teamModels.admit(runtime, frame.teamId, frame.resourceId, frame.version); }
        catch { sendError(frame.id, 'denied'); return; }
        if (frame.generation && frame.generation !== admission.generation) { sendError(frame.id, 'denied'); return; }
        try {
          if (frame.operation === 'models' || frame.operation === 'configuration') {
            if (frame.body !== undefined) throw new Error('Unexpected model read body.');
          } else admittedModelBody(admission.grant, frame.operation, frame.body);
        } catch { sendError(frame.id, 'invalid_request'); return; }
        const snapshot = admission;
        void request(frame.id, snapshot.grant, frame.operation, frame.body,
          () => this.teamModels.current(runtime, snapshot), snapshot.document).catch(stop);
        return;
      }
      const grant = runtime.modelGrants?.find(item => item.id === frame.grant);
      const generation = grant ? this.ledger.modelGeneration(runtime, revision, grant) : null;
      if (!grant || generation === null) { sendError(frame.id, 'denied'); return; }
      try {
        if (frame.operation === 'models') { if (frame.body !== undefined) throw new Error('Unexpected catalogue body.'); }
        else admittedModelBody(grant, frame.operation, frame.body);
      } catch { sendError(frame.id, 'invalid_request'); return; }
      void request(frame.id, grant, frame.operation, frame.body,
        () => this.ledger.modelGeneration(runtime, revision, grant) === generation).catch(stop);
    }, stop);
    const watch = setInterval(() => {
      try {
        if (!current() || performance.now() - lastHeartbeat > 15_000 || (!ready && performance.now() - started > 15_000)) { stop(); return; }
        for (const job of jobs.values()) if (!job.current()) cancel(job);
        void channel.send({ type: 'ping' }).catch(stop);
      } catch { stop(); }
    }, 1000);
    const closed = new Promise<void>(resolve => child.once('close', () => {
      stop(); clearTimeout(kill); this.connections.delete(runtime.id);
      const count = performance.now() - started > 30_000 ? 1 : Math.min(6, (this.retries.get(runtime.id)?.count ?? 0) + 1);
      this.retries.set(runtime.id, { count, next: performance.now() + Math.min(60_000, 1000 * 2 ** count) });
      resolve();
    }));
    // A stopped CLI retains its slot until observed exit. No second helper is
    // launched merely because cancellation or a kill request was issued.
    this.connections.set(runtime.id, { stop, closed,
      required: () => Boolean(runtime.modelGrants?.length) || this.teamModels.hasAccess(runtime) });
    child.once('error', stop); child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 16 * 1024) stop(); });
    void channel.send({ type: 'ping' }).catch(stop);
    this.trackUnconfirmed(child, closed);
  }

  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private trackUnconfirmed(child: ChildProcessWithoutNullStreams, closed: Promise<void>): void {
    this.children.add(child); void closed.then(() => this.children.delete(child));
  }

  async close(): Promise<void> {
    this.stopping = true; clearTimeout(this.timer);
    const connections = [...this.connections.values()]; for (const connection of connections) connection.stop();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(connections.map(item => item.closed)), new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Model relay exit is unconfirmed.')), 10_000);
      })]);
    } finally { clearTimeout(deadline); for (const child of this.children) { child.stderr.destroy(); child.unref(); } }
  }
}
