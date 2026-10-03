import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { readConversationLogForReplay } from '@/backend/execution/flow/conversationLog';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import type { EventPayload } from '@/backend/execution/flow/engine/eventPayload';
import { createExecutionStream, executionStreamAdmission, executionStreamCapacityResponse, EXECUTION_SSE_HEADERS } from '@/backend/execution/flow/engine/executionStream';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { assertLocalRequest } from '@/utils/http/localRequest';

export const dynamic = 'force-dynamic';
const TRANSCRIPT_REPLAY_TYPES = new Set(['model:start', 'model:dispatch', 'model:dispatch-result', 'model:delta', 'model:end', 'message', 'message:removed', 'node:snapshot', 'node:changed-files', 'tool:result']);

/** Durable per-conversation IDs remain numeric. Oversized replay/delivery
 * requests snapshot recovery instead of inflating unbounded log/queue data. */
async function GET_handler(request: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const { conversationId } = await params;
  if (!conversationId) return new Response('Missing conversationId', { status: 400 });
  const state = await loadConversationState(conversationId);
  if (!state || isPersonaOwnedConversationState(state)) { const notLocal = assertLocalRequest(request); if (notLocal) return notLocal; }
  const release = executionStreamAdmission.reserve(conversationId);
  if (!release) return executionStreamCapacityResponse();
  const lastId = request.headers.get('last-event-id');
  const cursor = lastId ?? request.nextUrl.searchParams.get('fromSeq');
  const fromSeq = cursor === null ? undefined : Number(cursor) + (lastId === null ? 0 : 1);
  const activityOnly = request.nextUrl.searchParams.get('replay') === 'activity' && lastId === null;
  let maxSentSeq = -1;
  const stream = createExecutionStream(request.signal, release, () => ({ nextSeq: executionEventBus.currentSeq(conversationId) }), async session => {
    const send = (event: ExecutionEvent, payload?: EventPayload) => {
      if (session.closed || event.seq <= maxSentSeq) return;
      maxSentSeq = event.seq;
      if (!session.send(event, event.seq, payload)) return;
      if (event.type === 'run:done' && event.seq + 1 >= executionEventBus.currentSeq(conversationId)) session.close();
    };
    if (fromSeq !== undefined) {
      if (!/^\d+$/.test(cursor!) || !Number.isSafeInteger(fromSeq) || fromSeq < 0) { session.reset('cursor-reset'); return; }
      let logged: ExecutionEvent[] | undefined;
      if (!activityOnly) {
        const releaseReplay = executionStreamAdmission.reserveReplay();
        if (!releaseReplay) { session.reset('replay-gap'); return; }
        try {
          const result = await readConversationLogForReplay(conversationId, fromSeq);
          if (result.limited) { session.reset('replay-gap'); return; }
          logged = result.events;
        } finally { releaseReplay(); }
      }
      if (session.closed) return;
      const window = executionEventBus.replayWindow(conversationId);
      if ((activityOnly || !logged) && fromSeq < window.firstSeq) { session.reset('replay-gap'); return; }
      const buffered = executionEventBus.getBufferedSince(conversationId, fromSeq);
      // Durable entries can fill holes inside the ring, including omitted media.
      const bySeq = new Map<number, ExecutionEvent>();
      for (const event of logged ?? []) bySeq.set(event.seq, event);
      for (const event of buffered) bySeq.set(event.seq, event);
      const replay = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
      const highWater = Math.max(window.nextSeq, (replay.at(-1)?.seq ?? -1) + 1);
      if (fromSeq > highWater) { session.reset('cursor-reset'); return; }
      // Preserve the latest-run clamp and terminal guard on continued runs.
      let replayFrom = fromSeq;
      for (const event of replay) if (event.type === 'run:start') replayFrom = Math.max(replayFrom, event.seq);
      for (const event of replay) {
        if (event.seq < replayFrom || (activityOnly && (TRANSCRIPT_REPLAY_TYPES.has(event.type) || (event.type === 'resource:write' && event.snapshot)))) continue;
        send(event);
        if (session.closed) return;
      }
    }
    if (!session.closed) session.onCleanup(executionEventBus.subscribe(conversationId, send));
  });
  return new Response(stream, { headers: EXECUTION_SSE_HEADERS });
}

export const GET = withWorkspaceRoute(GET_handler);
