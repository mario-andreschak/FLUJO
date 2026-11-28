import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { humanTaskView } from '@/backend/execution/flow/humanTask';
import type { SharedState } from '@/backend/execution/flow/types';
import { answerHumanTask, continueAnsweredHumanTask, findHumanTaskOwner } from '@/backend/services/humanTasks/answerHumanTask';
import { getHumanTaskEntry } from '@/backend/services/humanTasks/humanTaskIndex';
import type { HumanAnswer } from '@/utils/shared/humanStep';

const log = createLogger('app/api/human-tasks/[requestId]/route');

type Context = { params: Promise<{ requestId: string }> };

const ACCEPT = new Set(['approve', 'submit', 'accept']);
const DECLINE = new Set(['reject', 'decline', 'deny']);
/** Bound on an answer body. The largest legal answer is one changed text of 65,536 characters. */
const MAX_BODY_BYTES = 512 * 1024;

function guardState(request: Request, state: SharedState | undefined): Response | null {
  if (!state || isPersonaOwnedConversationState(state)) {
    const notLoopback = assertLocalRequest(request, { strictLoopback: true });
    if (notLoopback) return notLoopback;
  }
  if (state?.personaArchived) return Response.json({ error: 'An anonymized Persona archive is read-only.' }, { status: 409 });
  if (isPersonaOwnedConversationState(state) && !state?.personaAttribution) {
    return Response.json({ error: 'Persona conversation attribution is incomplete; refusing an unfenced answer.' }, { status: 409 });
  }
  return null;
}

/**
 * GET /api/human-tasks/{requestId}  (#1095)
 *
 * One Human step: what it shows (question, content, questions), the digest to send
 * back with an accepting answer, its deadline and, once answered, the receipt.
 * Reading never changes anything and never continues a run.
 */
async function GET_handler(request: Request, { params }: Context) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const { requestId } = await params;
  try {
    const entry = await getHumanTaskEntry(requestId);
    const conversationId = await findHumanTaskOwner(requestId);
    if (!entry || !conversationId) return Response.json({ error: `No Human step "${requestId}".` }, { status: 404 });
    const state = await loadConversationState(conversationId);
    const refused = guardState(request, state);
    if (refused) return refused;
    const task = state?.humanTask?.requestId === requestId ? state.humanTask : undefined;
    if (!task) {
      const applied = state?.humanTaskLog?.find((record) => record.requestId === requestId);
      return Response.json({
        requestId,
        conversationId,
        title: entry.title,
        mode: entry.mode,
        status: applied ? 'applied' : entry.status === 'applied' ? 'applied' : 'cancelled',
        ...(applied ? { receipt: { requestId, decisionId: applied.decisionId, outcome: applied.outcome, decidedAt: applied.decidedAt } } : {}),
      });
    }
    return Response.json({
      ...humanTaskView(task),
      conversationId,
      digest: task.digest,
      createdAt: task.createdAt,
      expiresAt: task.expiresAt,
      status: task.decision ? 'decided' : 'waiting',
      ...(task.decision ? { receipt: {
        requestId, decisionId: task.decision.decisionId, outcome: task.decision.outcome, decidedAt: task.decision.decidedAt,
      } } : {}),
    });
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    log.error('Could not read a Human step', { requestId, error });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/human-tasks/{requestId}  (#1095)
 *
 * Answer one Human step. Body:
 *   { "action": "approve" | "submit" | "reject" | "decline",
 *     "digest": "<from GET>", "value": <answers or changed text>, "idempotencyKey": "<any>" }
 * Accepting needs the digest of what the person saw. The answer is checked and saved
 * before this replies (202 with a receipt); the run then continues in the background.
 * The same answer again returns the same receipt; a different one is refused (409).
 * Wrong answers are refused with 422 and per-question errors, and the step keeps
 * waiting. After the deadline the answer is refused with 410. A step a sub-flow asked
 * is answered here too, and its waiting parent goes on. A Persona's step is answered
 * from this computer only and replies once its dispatcher has taken the answer (200).
 */
async function POST_handler(request: Request, { params }: Context) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const { requestId } = await params;

  let body: { action?: unknown; digest?: unknown; value?: unknown; idempotencyKey?: unknown; conversationId?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return Response.json({ error: 'The answer is too large.' }, { status: 413 });
    body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Send an object.');
  } catch {
    return Response.json({ error: 'Send a JSON object with an action.' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? body.action : '';
  if (!ACCEPT.has(action) && !DECLINE.has(action)) {
    return Response.json({ error: 'action is approve, submit, reject or decline.' }, { status: 400 });
  }
  const answer: HumanAnswer = {
    ...(typeof body.digest === 'string' ? { digest: body.digest } : {}),
    ...(body.value !== undefined ? { value: body.value } : {}),
    ...(typeof body.idempotencyKey === 'string' ? { idempotencyKey: body.idempotencyKey } : {}),
  };

  try {
    const result = await answerHumanTask({
      requestId,
      accept: ACCEPT.has(action),
      answer,
      channel: 'api',
      ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
      fromThisComputer: assertLocalRequest(request, { strictLoopback: true }) === null,
    });
    if (result.kind === 'refused') {
      return Response.json({
        error: result.error,
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
        ...(result.code ? { code: result.code } : {}),
      }, { status: result.status });
    }
    continueAnsweredHumanTask(result);
    return Response.json({
      status: result.status,
      repeat: result.repeat,
      receipt: result.receipt,
      conversationId: result.conversationId,
      ...(result.continued && 'runStatus' in result.continued ? { runStatus: result.continued.runStatus } : {}),
    }, { status: result.continued || result.status === 'applied' ? 200 : 202 });
  } catch (error) {
    if (error instanceof ConversationLogReadPressureError) throw error;
    log.error('Could not answer a Human step', { requestId, error });
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
