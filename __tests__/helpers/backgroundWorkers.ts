/**
 * FLUJO's start-up begins a background worker for its test profiles (the
 * harness). A Jest file that runs the real chat route starts it too; if its
 * first pass is still reading storage when the file ends, Jest reports a late
 * import after tear-down and the run fails. Call this in `afterAll`, before the
 * data folder is removed: it stops the timer and waits for the current pass.
 */
type HarnessWorkers = Map<string, { timer?: ReturnType<typeof setInterval>; running: boolean }>;

export async function stopBackgroundWorkers(): Promise<void> {
  const workers = (globalThis as { __flujoHarnessWorkers?: HarnessWorkers }).__flujoHarnessWorkers;
  for (const worker of workers?.values() ?? []) if (worker.timer) clearInterval(worker.timer);
  for (let wait = 0; wait < 400 && [...workers?.values() ?? []].some(worker => worker.running); wait++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
