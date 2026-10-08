import { withWorkspaceRoute } from '@/app/api/_workspace';
import { ensureBackendInitialized } from '@/backend/init';
import { flowService } from '@/backend/services/flow';
import { getSchedulerService } from '@/backend/services/scheduler';
import { scheduleNextRuns } from '@/backend/services/scheduler/triggers/schedule';
import { loadAutomationMapPackages } from '@/backend/services/waves/automationMapPackageProvenance';
import {
  resolveAutomationMap,
  type AutomationMapExecutionEntry,
} from '@/backend/services/waves/automationMapResolver';
import {
  isPersonaControlledPlannedExecution,
  type TriggerConfig,
} from '@/shared/types/plannedExecution';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { intervalMsToCron } from '@/utils/shared/cron';

const log = createLogger('app/api/automation-map/route');

/**
 * GET /api/automation-map
 *
 * Complete, read-only Automation Playground graph. Like GET /api/waves, this
 * never arms, fires, or persists anything. It preserves the same strict-local
 * Persona boundary while adding full Flow definitions and package provenance.
 */
async function GET_handler(request: Request) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const scheduler = getSchedulerService();
    const preflightEntries = await scheduler.list();
    const containsPersonaWork = preflightEntries.some((entry) => (
      isPersonaControlledPlannedExecution(entry.execution)
    ));
    const personaControlAllowed = assertLocalRequest(request, { strictLoopback: true }) === null;

    let listEntries = preflightEntries;
    if (personaControlAllowed || !containsPersonaWork) {
      await ensureBackendInitialized().catch(() => { /* surfaced during startup */ });
      listEntries = await scheduler.list();
    }
    if (!personaControlAllowed) {
      listEntries = listEntries.filter((entry) => !isPersonaControlledPlannedExecution(entry.execution));
    }

    const [paused, flows, packages] = await Promise.all([
      scheduler.isPaused(),
      flowService.loadFlows(),
      loadAutomationMapPackages(),
    ]);

    const executions: AutomationMapExecutionEntry[] = listEntries.map((entry) => {
      const nextRun = entry.status?.nextRun ?? computeNextRun(entry.execution.trigger);
      return {
        execution: entry.execution,
        status: { ...entry.status, nextRun },
        lastRun: entry.lastRun,
      };
    });

    return json(resolveAutomationMap({ executions, flows, packages, paused }), 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

function computeNextRun(trigger: TriggerConfig): string | null {
  try {
    if (trigger.type === 'schedule' || trigger.type === 'url-watch') {
      return scheduleNextRuns(trigger.cron, trigger.timezone, 1)[0] ?? null;
    }
    if (trigger.type === 'mcp-poll') {
      const cron = trigger.cron ?? intervalMsToCron(trigger.intervalMs);
      return scheduleNextRuns(cron, trigger.timezone, 1)[0] ?? null;
    }
  } catch {
    /* Invalid cron: keep the schedule summary truthful with a null nextRun. */
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const GET_workspaceRoute = withWorkspaceRoute(GET_handler);
export function GET(): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request = new Request('http://localhost/')) {
  return GET_workspaceRoute(request);
}
