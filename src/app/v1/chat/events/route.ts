import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { executionEventBus, GlobalEvent } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { assertLocalRequest } from '@/utils/http/localRequest';

import {
  createExecutionStream, executionStreamAdmission, executionStreamCapacityResponse, EXECUTION_SSE_HEADERS,
} from '@/backend/execution/flow/engine/executionStream';

const log = createLogger('app/v1/chat/events/route');

// The chat sidebar only needs events that can add a conversation or change its
// list-level status. Filtering at the server keeps high-volume model deltas,
// tool progress, and debugger activity off this lightweight subscription.
const SIDEBAR_EVENT_TYPES = new Set([
  'run:start',
  'run:paused',
  'run:awaiting_approval',
  'run:done',
  'recovery:transition',
  'recovery:retry',
]);

// SSE must never be statically optimized or cached.
export const dynamic = 'force-dynamic';

/**
 * Global firehose: a single Server-Sent Events stream of execution events
 * across ALL conversations. Lets a client (e.g. the brain viz) watch every
 * running flow and subflow over ONE connection, instead of opening one
 * EventSource per conversation — which hits the browser's ~6-per-origin
 * connection cap the moment several subflows fan out in parallel.
 *
 * Additive to the per-conversation stream
 * (/v1/chat/conversations/{id}/events), which chat still uses unchanged. Each
 * frame's `data` is the same event shape as that stream (already carrying
 * `conversationId`, `flowId`, `depth`, lane fields, …); the SSE `id` is a
 * workspace sequence so ?fromSeq= / Last-Event-ID can resume after a drop
 * without tracking per-conversation seqs.
 *
 * Unlike the per-conversation stream this NEVER closes on a `run:done` — it
 * spans every conversation, so a single run finishing must not tear it down.
 * It closes on disconnection or a projection recovery control. Numeric IDs
 * remain the default; cursorVersion=1 binds IDs to the projection epoch.
 */
async function GET_handler(request: NextRequest) {
  // Global events do not carry a durable ownership discriminator, so they
  // follow the app-wide exposure policy rather than attempting Persona-level
  // filtering here.
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const _lock = await assertUnlocked({ openai: true });
  if (_lock) return _lock;

  const release = executionStreamAdmission.reserve();
  if (!release) return executionStreamCapacityResponse();
  if (!executionEventBus.ensureGlobalProjection()) { release(); return executionStreamCapacityResponse(); }
  const sidebarOnly = request.nextUrl.searchParams.get('scope') === 'sidebar';
  const versioned = request.nextUrl.searchParams.get('cursorVersion') === '1';
  const lastEventId = request.headers.get('last-event-id');
  const cursor = lastEventId ?? request.nextUrl.searchParams.get('fromSeq');
  const window = executionEventBus.globalReplayWindow();
  // Numeric IDs remain the default. Owned clients opt in to epoch-bound IDs.
  const match = cursor === null ? null : versioned
    ? /^([a-zA-Z0-9-]{1,64}):(\d+)$/.exec(cursor)
    : /^(\d+)$/.exec(cursor);
  const cursorEpoch = versioned ? match?.[1] : undefined;
  const numeric = match ? Number(match[versioned ? 2 : 1]) : NaN;
  const fromSeq = cursor === null ? null : numeric + (lastEventId === null ? 0 : 1);
  const stream = createExecutionStream(request.signal, release,
    () => {
      const current = executionEventBus.globalReplayWindow();
      return { nextSeq: current.nextSeq, ...(versioned ? { epoch: current.epoch } : {}) };
    },
    session => {
      if (fromSeq !== null && (!Number.isSafeInteger(fromSeq) || fromSeq < 0
        || (versioned && cursorEpoch !== window.epoch) || fromSeq > window.nextSeq)) {
        session.reset('cursor-reset');
        return;
      }
      if (fromSeq !== null && fromSeq < window.firstSeq) { session.reset('replay-gap'); return; }
      let maxSentSeq = -1;
      const send = ({ globalSeq, event }: GlobalEvent) => {
        if (sidebarOnly && !SIDEBAR_EVENT_TYPES.has(event.type)) return;
        if (globalSeq <= maxSentSeq || session.closed) return;
        if (session.send(event, versioned ? window.epoch + ':' + globalSeq : globalSeq)) maxSentSeq = globalSeq;
        // The firehose spans conversations and remains open across run:done.
      };
      if (fromSeq !== null) {
        for (const entry of executionEventBus.getGlobalBufferedSince(fromSeq)) {
          send(entry);
          if (session.closed) return;
        }
      }
      if (!session.closed) session.onCleanup(executionEventBus.subscribeGlobal(send));
    });
  log.info('Opening global SSE firehose', { sidebarOnly, versioned });
  return new Response(stream, { headers: EXECUTION_SSE_HEADERS });
}

export const GET = withWorkspaceRoute(GET_handler);
