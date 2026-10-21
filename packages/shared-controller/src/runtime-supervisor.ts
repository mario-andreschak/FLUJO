import { Ledger } from './ledger.js';
import { LocalRuntimeDriver } from './local-runtime.js';
import { RuntimeControlError } from './local-runtime-policy.js';

/** Only the process holding the existing controller lock may drive lifecycle.
 * CLI enable/disable writes intent; it cannot race a separate start/stop driver. */
export class RuntimeSupervisor {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly retries = new Map<string, { generation: number; count: number; next: number }>();
  constructor(readonly ledger: Ledger, readonly driver: LocalRuntimeDriver) {}

  async reconcile(actorId?: string): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return;
    this.pending = this.run(actorId);
    try { await this.pending; } finally { this.pending = undefined; }
  }

  private async run(actorId?: string): Promise<void> {
    const queue = this.ledger.intents().filter(intent => {
      if (actorId && intent.actorId !== actorId) return false;
      const retry = this.retries.get(intent.runtimeId);
      return (intent.phase !== 'confirmed' || (intent.verifiedAt ?? 0) < Date.now() - 10_000)
        && (!retry || retry.generation !== intent.generation || retry.next <= Date.now());
    });
    const worker = async () => {
      for (let intent; !this.stopped && (intent = queue.shift());) {
        const selected = intent;
        try {
          await this.driver.converge(selected, () => !this.stopped && this.ledger.intentCurrent(selected));
          if (!this.stopped && this.ledger.observeRuntime(selected)) this.retries.delete(selected.runtimeId);
        } catch (error) {
          if (this.stopped) return;
          const problem = error instanceof RuntimeControlError ? error.problem : 'local-engine-unavailable';
          this.ledger.failRuntime(selected, problem);
          const previous = this.retries.get(selected.runtimeId);
          const count = previous?.generation === selected.generation ? Math.min(6, previous.count + 1) : 1;
          this.retries.set(selected.runtimeId, { generation: selected.generation, count, next: Date.now() + Math.min(60_000, 1000 * 2 ** count) });
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  start(): void {
    const tick = async () => {
      try { await this.reconcile(); } catch { /* Admission expires without fresh ledger evidence. */ }
      if (!this.stopped) this.timer = setTimeout(() => { void tick(); }, 1000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.pending;
  }
}
