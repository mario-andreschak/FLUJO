import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { flowService } from '@/backend/services/flow';

const log = createLogger('app/api/runs/active/route');

/** Metadata-only projection of an in-flight run (never any prompt/binding). */
interface ActiveRun {
  conversationId?: string;
  flowId: string;
  flowName?: string;
  status?: string;
  startedAt?: string;
  source?: 'schedule' | 'chat' | 'api';
  plannedExecutionId?: string;
}

/** Statuses that mean a run is holding resources / not yet terminal. A
 *  suspend-when-idle orchestrator wants "anything not done", so we include the
 *  parked states (awaiting approval / paused in the debugger) alongside
 *  actively-running. Terminal states (completed/error) are excluded. */
const ACTIVE_STATUSES = new Set(['running', 'awaiting_tool_approval', 'paused_debug']);

/** Build a JSON Response with the given status code. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/runs/active
 *
 * Lightweight, read-only listing of in-flight runs across every path (chat,
 * api, scheduled) so a control plane can answer "is anything running right
 * now?" before suspending an idle instance (issue #113). The PE list's
 * `status.running` only covers scheduled runs; this also sees ad-hoc
 * /v1/chat/completions runs.
 *
 * Projection is deliberately metadata-only: ids, flow, status, start time and
 * origin. It NEVER returns prompt text, messages, resolved variables, or any
 * decrypted binding.
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    // Cache flow-id → name lookups within this request (multiple concurrent
    // runs of the same flow are common).
    const nameCache = new Map<string, string | undefined>();
    const resolveFlowName = async (
      flowId: string,
      snapshotName?: string
    ): Promise<string | undefined> => {
      if (snapshotName) return snapshotName;
      if (!flowId) return undefined;
      if (nameCache.has(flowId)) return nameCache.get(flowId);
      let name: string | undefined;
      try {
        const flow = await flowService.getFlow(flowId);
        name = flow?.name;
      } catch (error) {
        log.debug(`Could not resolve flow name for ${flowId}`, error);
      }
      nameCache.set(flowId, name);
      return name;
    };

    const active: ActiveRun[] = [];
    for (const state of FlowExecutor.conversationStates.values()) {
      if (!state || !ACTIVE_STATUSES.has(state.status ?? '')) continue;
      active.push({
        conversationId: state.conversationId,
        flowId: state.flowId,
        flowName: await resolveFlowName(state.flowId, state.flowSnapshot?.name),
        status: state.status,
        startedAt:
          typeof state.createdAt === 'number'
            ? new Date(state.createdAt).toISOString()
            : undefined,
        source: state.source,
        ...(state.plannedExecutionId ? { plannedExecutionId: state.plannedExecutionId } : {}),
      });
    }

    return json({ runs: active }, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
