import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { flowService } from '@/backend/services/flow';
import { ensureBackendInitialized } from '@/backend/init';
import { resolveWaves, WaveResolverExecutionEntry } from '@/backend/services/waves/waveResolver';
import { scheduleNextRuns } from '@/backend/services/scheduler/triggers/schedule';
import { intervalMsToCron } from '@/utils/shared/cron';
import type { TriggerConfig } from '@/shared/types/plannedExecution';

const log = createLogger('app/api/waves/route');

/**
 * GET /api/waves
 * Read-only, deterministic resolution of Planned Executions into Wave chains
 * for the /waves visualization. Never arms, fires or persists anything.
 * Response: WavesResponse { paused, generatedAt, waves, orphans }.
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
    const scheduler = getSchedulerService();
    const [paused, listEntries, flows] = await Promise.all([
      scheduler.isPaused(),
      scheduler.list(),
      flowService.loadFlows(),
    ]);

    // Map scheduler entries to the resolver's minimal shape, backfilling a
    // next-run for predictable triggers whose live status lacks one (e.g. when
    // paused/disabled, nothing is armed so status.nextRun is absent). This is a
    // read-only computation via croner — it schedules nothing.
    const executions: WaveResolverExecutionEntry[] = listEntries.map((entry) => {
      let nextRun = entry.status?.nextRun ?? null;
      if (!nextRun) {
        nextRun = computeNextRun(entry.execution.trigger);
      }
      return { execution: entry.execution, status: { nextRun } };
    });

    const response = resolveWaves({ executions, flows, paused });
    return json(response, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

/**
 * Best-effort next-run for a predictable trigger, computed read-only. Returns
 * null for unpredictable/event triggers or when no cron can be derived.
 */
function computeNextRun(trigger: TriggerConfig): string | null {
  try {
    if (trigger.type === 'schedule' || trigger.type === 'url-watch') {
      return scheduleNextRuns(trigger.cron, trigger.timezone, 1)[0] ?? null;
    }
    if (trigger.type === 'mcp-poll') {
      const cron = trigger.cron ?? intervalMsToCron(trigger.intervalMs);
      if (!cron) return null;
      return scheduleNextRuns(cron, trigger.timezone, 1)[0] ?? null;
    }
  } catch {
    /* invalid cron — leave null */
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
