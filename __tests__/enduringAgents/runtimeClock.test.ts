import {
  _setPersonaRuntimeClockForTests,
  getPersonaRuntimeClock,
} from '@/backend/services/enduringAgents/runtimeClock';
import { VirtualPersonaRuntimeClock } from './soak/virtualClock';

describe('Persona runtime clock', () => {
  afterEach(() => { _setPersonaRuntimeClockForTests(undefined); });

  it('delegates to real wall and monotonic time by default', () => {
    const before = Date.now();
    const clock = getPersonaRuntimeClock();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
    expect(clock.monotonicNow()).toBeGreaterThanOrEqual(0);
  });

  it('updates cached facades when the process-local test clock changes', async () => {
    const facade = getPersonaRuntimeClock();
    const virtual = new VirtualPersonaRuntimeClock(1_000);
    _setPersonaRuntimeClockForTests(virtual);
    expect(facade.now()).toBe(1_000);
    await virtual.advanceBy(25);
    expect(facade.now()).toBe(1_025);
    _setPersonaRuntimeClockForTests(undefined);
    expect(facade.now()).toBeGreaterThan(1_025);
  });

  it('orders equal timers by insertion, drains microtasks, and rejects runaway loops', async () => {
    const clock = new VirtualPersonaRuntimeClock(0, 3);
    const events: string[] = [];
    clock.setTimer(() => { events.push('first'); void Promise.resolve().then(() => events.push('microtask')); }, 10);
    clock.setTimer(() => events.push('second'), 10);
    await clock.advanceTo(10);
    expect(events).toEqual(['first', 'microtask', 'second']);

    const loop = () => clock.setTimer(loop, 0);
    loop();
    await expect(clock.advanceBy(0)).rejects.toThrow(/runaway/i);
  });
});
