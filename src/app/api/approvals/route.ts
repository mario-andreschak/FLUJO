import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { listPendingApprovals, removePendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { listAllPendingQuestions } from '@/backend/services/questionRegistry';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getSchedulerService } from '@/backend/services/scheduler';
import type { SharedState } from '@/backend/execution/flow/types';
import { getPersonaFlowDispatch } from '@/backend/services/enduringAgents/personaDispatcher';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';

const log = createLogger('app/api/approvals/route');

/** Build a JSON Response with the given status code. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * GET /api/approvals  (issue #115)
 *
 * Lists HEADLESS (scheduled) runs that paused on a tool needing approval
 * (approvalPolicy 'pause'), so an external dashboard/bot can act as the
 * human-in-the-loop and resume them via POST /api/approvals/:id.
 *
 * The listing is metadata-only, mirroring the privacy discipline of
 * GET /api/runs/active: it returns ids, flow, trigger summary, timestamps and
 * the pending tool NAMES — never prompt text, messages, tool ARGUMENTS, or any
 * decrypted binding. (Arguments are deliberately omitted to avoid leaking data
 * into this surface.)
 *
 * Entries whose paused run is no longer awaiting approval (resolved out of
 * band, or the conversation was deleted) are pruned lazily here so the inbox
 * stays truthful.
 */
async function GET_handler(request: Request) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const entries = await listPendingApprovals();
    const approvals: Array<Record<string, unknown>> = [];
    const staleApprovalIds: string[] = [];
    const personaRecoveries: Array<{
      entry: Awaited<ReturnType<typeof listPendingApprovals>>[number];
      state: SharedState;
    }> = [];
    let requiresStrictControlPlane = false;

    for (const entry of entries) {
      // Validate against the live/persisted state; prune stale index entries.
      let stillAwaiting = false;
      let state: SharedState | undefined;
      try {
        state = await loadConversationState(entry.conversationId);
        stillAwaiting = state?.status === 'awaiting_tool_approval';
        if (stillAwaiting && entry.resumeDispatchId) {
          const resumedDispatch = await getPersonaFlowDispatch(entry.resumeDispatchId);
          if (
            resumedDispatch
            && (
              resumedDispatch.state === 'queued'
              || resumedDispatch.state === 'running'
              || (
                resumedDispatch.state === 'waiting'
                && resumedDispatch.waitingReason !== 'approval'
              )
            )
          ) {
            stillAwaiting = false;
          }
        }
        if (!state || isPersonaOwnedConversationState(state)) requiresStrictControlPlane = true;
      } catch (error) {
        requiresStrictControlPlane = true;
        log.debug(`Could not load state for approval ${entry.approvalId}`, error);
      }
      if (!stillAwaiting) {
        const personaTerminal = Boolean(
          state?.personaAttribution
          && (state.status === 'completed' || state.status === 'error' || state.status === 'capped')
        );
        if (personaTerminal) {
          staleApprovalIds.push(entry.approvalId);
          personaRecoveries.push({ entry, state: state! });
        } else if (!entry.terminalPublication) {
          // Preserve the legacy lazy-prune behavior. A Persona receipt remains
          // durable while its resumed dispatch is queued/running/debug-waiting;
          // those are not terminal outcomes and must not be frozen as errors.
          staleApprovalIds.push(entry.approvalId);
        }
        continue;
      }
      approvals.push({
        approvalId: entry.approvalId,
        conversationId: entry.conversationId,
        plannedExecutionId: entry.plannedExecutionId,
        flowId: entry.flowId,
        flowName: entry.flowName,
        runId: entry.runId,
        triggerSummary: entry.triggerSummary,
        pendingToolCalls: entry.pendingToolCalls, // { id, name } only — no args
        createdAt: entry.createdAt,
      });
    }

    // Model-initiated questions (issue #258) awaiting an answer. These use the
    // in-request blocking-promise path (questionRegistry) rather than the
    // disk-serialized approval pause, so they are surfaced from the in-memory
    // registry directly. Answer/decline via POST /api/approvals/:id with
    // action 'question-answer' / 'question-decline' (:id is the conversationId).
    const pendingQuestions = listAllPendingQuestions();
    for (const question of pendingQuestions) {
      const state = FlowExecutor.conversationStates.get(question.conversationId)
        ?? await loadConversationState(question.conversationId).catch(() => undefined);
      if (!state || isPersonaOwnedConversationState(state)) {
        requiresStrictControlPlane = true;
        break;
      }
    }
    if (requiresStrictControlPlane) {
      const notLoopback = assertLocalRequest(request, { strictLoopback: true });
      if (notLoopback) return notLoopback;
    }
    await Promise.all(personaRecoveries.map(async ({ entry, state }) => {
      const attribution = state.personaAttribution;
      if (!attribution?.activityId || !attribution.behaviorRevisionId) return;
      const status: 'completed' | 'error' = state.status === 'completed' ? 'completed' : 'error';
      await getSchedulerService().completeApprovedPersonaRun({
        executionId: entry.plannedExecutionId,
        runId: entry.runId,
        status,
        finishedAt: new Date().toISOString(),
        conversationId: entry.conversationId,
        firedAt: entry.createdAt,
        triggerSummary: entry.triggerSummary,
        personaAttribution: {
          personaId: attribution.personaId,
          activityId: attribution.activityId,
          behaviorRevisionId: attribution.behaviorRevisionId,
        },
        terminalPublication: entry.terminalPublication,
        error: status === 'completed'
          ? undefined
          : `Run ended with status "${state.status}" after approval`,
      });
    }));
    await Promise.all(staleApprovalIds.map((approvalId) => (
      removePendingApproval(approvalId).catch(() => { /* best-effort prune */ })
    )));
    const questions = pendingQuestions.map((q) => ({
      conversationId: q.conversationId,
      questionId: q.questionId,
      questions: q.questions,
      createdAt: q.createdAt,
    }));

    return json({ approvals, questions }, 200);
  } catch (error) {
    log.error('Error handling GET /api/approvals', error);
    return json({ error: 'Internal server error' }, 500);
  }
}

const GET_workspaceRoute = withWorkspaceRoute(GET_handler);
export function GET(): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request = new Request('http://localhost/')) {
  return GET_workspaceRoute(request);
}
