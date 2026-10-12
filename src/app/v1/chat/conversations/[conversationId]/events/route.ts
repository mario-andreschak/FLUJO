import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { readConversationLogForReplay } from '@/backend/execution/flow/conversationLog';
import { ExecutionEvent } from '@/shared/types/execution/events';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { assertLocalRequest } from '@/utils/http/localRequest';

import {
  createExecutionStream, executionStreamAdmission, executionStreamCapacityResponse, EXECUTION_SSE_HEADERS,
} from '@/backend/execution/flow/engine/executionStream';

const log = createLogger('app/v1/chat/conversations/[conversationId]/events/route');

// SSE must never be statically optimized or cached.
export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events stream of execution events for a conversation.
 *
 * Replaces the old polling-based streaming. Clients fetch the full conversation
 * once (GET /v1/chat/conversations/{id}) then attach here to receive live
 * events. Pass ?fromSeq=N to resume from a known position after a reconnect:
 * events carry an authoritative, durable, monotonic per-conversation `seq`
 * (issue #261). Recent positions are served from the in-memory ring buffer;
 * positions older than the buffer (evicted, channel GC'd, or after a process
 * restart) use bounded durable replay. A gap or exhausted projection budget
 * emits a named snapshot-recovery frame rather than reading all history.
 */
async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> }
) {
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const { conversationId } = await params;
  if (!conversationId) {
    return new Response('Missing conversationId', { status: 400 });
  }

  const state = await loadConversationState(conversationId);
  // Missing state cannot prove that an orphaned event channel is legacy.
  // Persona-owned and ownership-unknown streams are local control-plane only.
  if (!state || isPersonaOwnedConversationState(state)) {
    const notLocal = assertLocalRequest(request);
    if (notLocal) return notLocal;
  }

  const release = executionStreamAdmission.reserve(conversationId);
  if (!release) return executionStreamCapacityResponse();
  if (!executionEventBus.ensureConversationProjection(conversationId)) {
    release();
    return executionStreamCapacityResponse();
  }

  // Browser reconnect IDs take precedence over the initial URL cursor.
  const lastEventId = request.headers.get('last-event-id');
  const cursor = lastEventId ?? request.nextUrl.searchParams.get('fromSeq');
  const activityOnlyReplay = request.nextUrl.searchParams.get('replay') === 'activity' && lastEventId === null;
  const parsed = cursor === null ? null : /^\d+$/.test(cursor) ? Number(cursor) : NaN;
  const fromSeq = parsed === null ? null : parsed + (lastEventId === null ? 0 : 1);
  log.info('Opening SSE event stream', { conversationId, activityOnlyReplay });

  const stream = createExecutionStream(request.signal, release,
    () => ({ nextSeq: executionEventBus.currentSeq(conversationId) }),
    async session => {
      if (fromSeq !== null && (!Number.isSafeInteger(fromSeq) || fromSeq < 0)) {
        session.reset('cursor-reset');
        return;
      }
      let maxSentSeq = -1;
      const send = (event: ExecutionEvent) => {
        if (event.seq <= maxSentSeq || session.closed) return;
        if (!session.send(event, event.seq)) return;
        maxSentSeq = event.seq;
        // An earlier run's terminal event cannot close a resumed live run.
        if (event.type === 'run:done' && event.seq + 1 >= executionEventBus.currentSeq(conversationId)) session.close();
      };

      if (fromSeq !== null) {
        let logged: ExecutionEvent[] | undefined;
        const initialWindow = executionEventBus.replayWindow(conversationId);
        if (!activityOnlyReplay && (initialWindow.nextSeq === 0 || fromSeq < initialWindow.firstSeq)) {
          const releaseReplay = executionStreamAdmission.reserveReplay();
          if (!releaseReplay) { session.reset('replay-gap'); return; }
          try {
            const result = await readConversationLogForReplay(conversationId, fromSeq, session.signal);
            if (session.closed) return;
            if (result.limited) { session.reset('replay-gap'); return; }
            logged = result.events;
          } finally {
            // Keep the native-read permit until the descriptor has actually closed.
            releaseReplay();
          }
        }
        if (session.closed) return;
        const window = executionEventBus.replayWindow(conversationId);
        const buffered = executionEventBus.getBufferedSince(conversationId, fromSeq);
        const earliestBuffered = buffered[0]?.seq ?? Infinity;
        const bySeq = new Map<number, ExecutionEvent>();
        for (const event of logged ?? []) if (event.seq < earliestBuffered) bySeq.set(event.seq, event);
        for (const event of buffered) bySeq.set(event.seq, event);
        const replay = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        // History belongs to GET; activity replay starts at the newest available run.
        let replayFrom = fromSeq;
        for (const event of replay) if (event.type === 'run:start') replayFrom = Math.max(replayFrom, event.seq);
        if (fromSeq > window.nextSeq && !logged?.some(event => event.seq >= fromSeq)) {
          session.reset('cursor-reset');
          return;
        }
        if (activityOnlyReplay && replayFrom < window.firstSeq) {
          session.reset('replay-gap');
          return;
        }
        if (!activityOnlyReplay && fromSeq < window.firstSeq && !logged?.length) {
          session.reset('replay-gap');
          return;
        }
        for (const event of replay) {
          if (event.seq < replayFrom) continue;
          if (activityOnlyReplay && (
            event.type === 'model:start' || event.type === 'model:dispatch'
            || event.type === 'model:dispatch-result' || event.type === 'model:delta'
            || event.type === 'model:end' || event.type === 'message'
            || event.type === 'message:removed' || event.type === 'node:snapshot'
            || event.type === 'node:changed-files' || event.type === 'tool:result'
            || (event.type === 'resource:write' && Boolean(event.snapshot))
          )) continue;
          send(event);
          if (session.closed) return;
        }
      }
      if (session.closed) return;
      // No await separates the final buffer snapshot from live subscription.
      session.onCleanup(executionEventBus.subscribe(conversationId, send));
    });
  return new Response(stream, { headers: EXECUTION_SSE_HEADERS });
}

export const GET = withWorkspaceRoute(GET_handler);
