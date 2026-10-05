const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createObserver } = require(process.env.FLUJO_APPEND_WITNESS_OBSERVER!);

jest.setTimeout(120_000); // separate diagnostic; the original 20k gate is untouched
it('records a bounded sample under real workspace writer admission', async () => {
  const count = Number(process.env.FLUJO_APPEND_WITNESS_COUNT);
  if (![100, 250].includes(count)) throw new Error('Only the predeclared diagnostic counts are allowed');
  const observer = createObserver(process.env.FLUJO_APPEND_WITNESS_PROGRESS);
  (globalThis as unknown as { __flujoAppendPhaseWitness?: unknown }).__flujoAppendPhaseWitness = observer;
  const events = require('@/backend/services/enduringAgents/runtimeEvents');
  const workspace = require('@/utils/workspace');
  const features = require('@/config/features');
  const originalRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flujo-append-phase-'));
  const previousRoot = events._setPersonaRuntimeEventLogRootForTests(originalRoot);
  const personaId = 'persona_phase_witness';
  let completed = 0;
  let lastSeq = -1;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopAt = Date.now() + 110_000;
  try {
    await workspace.runWithWorkspace(`append-phase-${process.pid}-${count}`, async () => {
      const lockRoot = path.join(workspace.getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents');
      observer.installFilesystemObservation(lockRoot, originalRoot);
      events._resetPersonaRuntimeEventLogStatsForTests();
      const snapshot = (phase: string) => observer.checkpoint({ phase, requested: count, completed, lastSeq, configuration: features.readPersonaRuntimeEventLogConfig(), stats: events._getPersonaRuntimeEventLogStatsForTests(), state: events._getPersonaRuntimeEventLogStateForTests(personaId) });
      timer = setInterval(() => snapshot('periodic'), 2000);
      snapshot('begin');
      for (let index = 0; index < count; index++) {
        if (Date.now() >= stopAt) throw new Error('Diagnostic cooperative 110-second deadline reached before next append');
        observer.assertWorkBudget();
        const result = await events.appendPersonaRuntimeEvent(personaId, { eventId: `phase:${index}`, type: 'activity:completed', activityId: `activity_${index}` });
        lastSeq = result.event.seq;
        if (lastSeq !== index || result.appended !== true) throw new Error(`Expected append seq ${index}, got ${lastSeq}`);
        completed++;
        if (completed % 25 === 0) snapshot('append-progress');
      }
      snapshot('before-tail');
      observer.assertWorkBudget();
      const tail = await events.readPersonaRuntimeEvents(personaId, { tail: 5 });
      expect(tail.map((event: { seq: number }) => event.seq)).toEqual(Array.from({ length: 5 }, (_, index) => count - 5 + index));
      expect(completed).toBe(count);
      observer.assertWorkBudget();
      snapshot('complete');
    });
  } finally {
    clearInterval(timer);
    observer.checkpoint({ phase: 'finally', requested: count, completed, lastSeq });
    observer.restoreFilesystemObservation();
    delete (globalThis as unknown as { __flujoAppendPhaseWitness?: unknown }).__flujoAppendPhaseWitness;
    events._setPersonaRuntimeEventLogRootForTests(previousRoot);
    // Preserve the runner-owned synthetic log for partial-failure inspection.
    // The existing setup hook retains the runner-owned installation as well.
  }
});
