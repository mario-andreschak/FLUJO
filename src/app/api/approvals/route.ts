import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { listPendingApprovals, removePendingApproval } from '@/backend/services/scheduler/pendingApprovals';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { listAllPendingQuestions } from '@/backend/services/questionRegistry';

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
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const entries = await listPendingApprovals();
    const approvals: Array<Record<string, unknown>> = [];

    for (const entry of entries) {
      // Validate against the live/persisted state; prune stale index entries.
      let stillAwaiting = false;
      try {
        const state = await loadConversationState(entry.conversationId);
        stillAwaiting = state?.status === 'awaiting_tool_approval';
      } catch (error) {
        log.debug(`Could not load state for approval ${entry.approvalId}`, error);
      }
      if (!stillAwaiting) {
        await removePendingApproval(entry.approvalId).catch(() => { /* best-effort prune */ });
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
    const questions = listAllPendingQuestions().map((q) => ({
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
