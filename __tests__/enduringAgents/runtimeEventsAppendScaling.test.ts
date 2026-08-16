import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { performance } from 'perf_hooks';

import {
  _getPersonaRuntimeEventLogStatsForTests,
  _getPersonaRuntimeEventLogStateForTests,
  _resetPersonaRuntimeEventLogStatsForTests,
  _setPersonaRuntimeEventLogRootForTests,
  appendPersonaRuntimeEvent,
  readPersonaRuntimeEvents,
  RUNTIME_EVENT_IDEMPOTENCY_WINDOW,
} from '@/backend/services/enduringAgents/runtimeEvents';
import { runWithWorkspace } from '@/utils/workspace';

// 20k appends (rather than the issue's 100k) keeps suite runtime sane while
// still proving linearity: the deterministic work counters assert TOTAL parse
// work is O(total appended bytes), which is the actual O(N²) -> O(N) claim,
// and the p95 ratio is only a generous, non-flaky wall-clock guardrail.
const APPEND_COUNT = 20_000;
const WINDOW_SIZE = 1_000;
const P95_MAX_RATIO = 3;

jest.setTimeout(900_000);

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

describe('Persona runtime event append scaling (#454)', () => {
  let tempRoot: string;
  let previousRoot: string | undefined;

  beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-runtime-events-scaling-'));
    previousRoot = _setPersonaRuntimeEventLogRootForTests(tempRoot);
  });

  afterAll(async () => {
    _setPersonaRuntimeEventLogRootForTests(previousRoot);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('appends with flat per-append cost, bounded memory, and no full-log re-parse', async () => {
    await runWithWorkspace(`runtime-scaling-${process.pid}`, async () => {
      const personaId = 'persona_scaling';
      _resetPersonaRuntimeEventLogStatsForTests();

      const durationsMs: number[] = [];
      for (let index = 0; index < APPEND_COUNT; index += 1) {
        const startedAt = performance.now();
        const result = await appendPersonaRuntimeEvent(personaId, {
          eventId: `scale:${index}`,
          type: 'activity:completed' as const,
          activityId: `activity_${index}`,
        });
        durationsMs.push(performance.now() - startedAt);
        if (result.event.seq !== index) {
          throw new Error(`Expected seq ${index}, observed ${result.event.seq}.`);
        }
      }

      // Deterministic linearity assertion: no append ever re-read the log.
      // (First append takes the ENOENT fast path; the rest are O(1) stat hits.)
      const stats = _getPersonaRuntimeEventLogStatsForTests();
      expect(stats.fullRescans).toBeLessThanOrEqual(1);
      expect(stats.tailReads).toBe(0);
      expect(stats.bytesParsed).toBe(0);
      expect(stats.linesParsed).toBe(0);
      expect(stats.cacheHits).toBeGreaterThanOrEqual(APPEND_COUNT - 1);

      // Resident memory is bounded by the idempotency window regardless of log length.
      const state = _getPersonaRuntimeEventLogStateForTests(personaId);
      expect(state).toBeDefined();
      expect(state!.windowSize).toBeLessThanOrEqual(RUNTIME_EVENT_IDEMPOTENCY_WINDOW);
      expect(state!.nextSeq).toBe(APPEND_COUNT);

      // Tail reads stay cheap and correct on the large log.
      const tail = await readPersonaRuntimeEvents(personaId, { tail: 5 });
      expect(tail.map(({ seq }) => seq)).toEqual([
        APPEND_COUNT - 5,
        APPEND_COUNT - 4,
        APPEND_COUNT - 3,
        APPEND_COUNT - 2,
        APPEND_COUNT - 1,
      ]);

      // Generous wall-clock guardrail (secondary; the work counters above are
      // the real assertion). Skipped when the environment opts out of
      // timing-sensitive checks.
      if (!process.env.CI_SKIP_PERF) {
        const earlyP95 = Math.max(p95(durationsMs.slice(0, WINDOW_SIZE)), 0.5);
        const lateP95 = p95(durationsMs.slice(-WINDOW_SIZE));
        expect(lateP95).toBeLessThanOrEqual(earlyP95 * P95_MAX_RATIO);
      }
    });
  });
});
