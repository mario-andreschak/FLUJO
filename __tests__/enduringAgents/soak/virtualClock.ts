import type {
  PersonaRuntimeClock,
  PersonaRuntimeTimer,
} from '@/backend/services/enduringAgents/runtimeClock';

interface ScheduledTimer {
  id: number;
  dueAt: number;
  order: number;
  active: boolean;
  callback: () => void;
}

export class VirtualPersonaRuntimeClock implements PersonaRuntimeClock {
  private wallNow: number;
  private monotonic = 0;
  private nextId = 1;
  private nextOrder = 1;
  private readonly timers: ScheduledTimer[] = [];

  constructor(startAt = Date.UTC(2026, 0, 1), private readonly runawayLimit = 10_000) {
    this.wallNow = startAt;
  }

  now(): number { return this.wallNow; }
  monotonicNow(): number { return this.monotonic; }

  setTimer(callback: () => void, ms: number): PersonaRuntimeTimer {
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError('Timer delay must be finite and non-negative.');
    const timer: ScheduledTimer = {
      id: this.nextId++,
      dueAt: this.wallNow + ms,
      order: this.nextOrder++,
      active: true,
      callback,
    };
    this.timers.push(timer);
    return {
      clear: () => { timer.active = false; },
      unref: () => undefined,
    };
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimer(resolve, ms));
  }

  async advanceBy(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new TypeError('Advance must be finite and non-negative.');
    await this.advanceTo(this.wallNow + ms);
  }

  async advanceTo(target: number): Promise<void> {
    if (!Number.isFinite(target) || target < this.wallNow) {
      throw new TypeError('Virtual clock cannot move backwards.');
    }
    let fired = 0;
    for (;;) {
      this.timers.sort((a, b) => a.dueAt - b.dueAt || a.order - b.order);
      const timer = this.timers.find((candidate) => candidate.active && candidate.dueAt <= target);
      if (!timer) break;
      if (++fired > this.runawayLimit) throw new Error('Virtual clock runaway timer limit exceeded.');
      timer.active = false;
      const elapsed = timer.dueAt - this.wallNow;
      this.wallNow = timer.dueAt;
      this.monotonic += elapsed;
      timer.callback();
      await Promise.resolve();
    }
    const elapsed = target - this.wallNow;
    this.wallNow = target;
    this.monotonic += elapsed;
  }

  async absorbRealTime(elapsedMs: number): Promise<void> {
    await this.advanceBy(Math.max(0, elapsedMs));
  }

  pendingTimerCount(): number {
    return this.timers.filter((timer) => timer.active).length;
  }
}
