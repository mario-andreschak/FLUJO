import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import {
  listHumanTaskEntries,
  syncHumanTaskEntry,
  updateHumanTaskEntry,
} from '@/backend/services/humanTasks/humanTaskIndex';

const log = createLogger('app/api/human-tasks/route');

/**
 * GET /api/human-tasks  (#1095)
 *
 * The Human steps that wait for a person, oldest first, from every chat, automation
 * and API run in this workspace. Ids, flow, step title, mode and times only: what the
 * step shows and any answer stay in the conversation. Open one with
 * GET /api/human-tasks/{requestId} and answer it with POST to the same address.
 *
 * `?include=finished` also lists steps that finished in the last 7 days, with their
 * outcome, so a client that lost an answer's reply can find its receipt.
 *
 * An entry whose conversation no longer waits for that step is put right here.
 */
async function GET_handler(request: Request) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  const includeFinished = new URL(request.url).searchParams.get('include') === 'finished';

  try {
    const entries = await listHumanTaskEntries();
    const tasks: Array<Record<string, unknown>> = [];
    let strict = false;
    for (const entry of entries) {
      const open = entry.status === 'waiting' || entry.status === 'decided';
      if (open) {
        let state;
        try {
          state = await loadConversationState(entry.conversationId);
        } catch (error) {
          if (error instanceof ConversationLogReadPressureError) throw error;
          strict = true;
          continue;
        }
        if (!state || isPersonaOwnedConversationState(state)) strict = true;
        if (state?.humanTask?.requestId !== entry.requestId) {
          const applied = state?.humanTaskLog?.find((record) => record.requestId === entry.requestId);
          await syncHumanTaskEntry(() => updateHumanTaskEntry(entry.requestId, applied
            ? { status: 'applied', outcome: applied.outcome, decisionId: applied.decisionId, decidedAt: applied.decidedAt, finishedAt: new Date().toISOString() }
            : { status: 'cancelled', finishedAt: new Date().toISOString() }), 'list repair');
          continue;
        }
      } else if (!includeFinished) {
        continue;
      }
      tasks.push({
        requestId: entry.requestId,
        conversationId: entry.conversationId,
        flowId: entry.flowId,
        nodeId: entry.nodeId,
        title: entry.title,
        mode: entry.mode,
        status: entry.status,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
        ...(entry.outcome ? { outcome: entry.outcome, decisionId: entry.decisionId, decidedAt: entry.decidedAt } : {}),
      });
    }
    if (strict) {
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    return Response.json({ tasks });
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    log.error('Could not list Human steps', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
