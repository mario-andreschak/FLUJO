import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { executionEventBus, type GlobalEvent } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { createExecutionStream, executionStreamAdmission, executionStreamCapacityResponse, EXECUTION_SSE_HEADERS } from '@/backend/execution/flow/engine/executionStream';
import { assertLocalRequest } from '@/utils/http/localRequest';

const SIDEBAR_EVENT_TYPES = new Set(['run:start', 'run:paused', 'run:awaiting_approval', 'run:done', 'recovery:transition', 'recovery:retry']);
export const dynamic = 'force-dynamic';

/** Global IDs bind the disposable workspace sequence to its current epoch.
 * Readers must handle flujo-stream-control by reloading their authoritative
 * snapshot and starting a fresh subscription. This is never an execution ACK. */
async function GET_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const release = executionStreamAdmission.reserve();
  if (!release) return executionStreamCapacityResponse();
  const sidebarOnly = request.nextUrl.searchParams.get('scope') === 'sidebar';
  const cursor = request.headers.get('last-event-id') ?? request.nextUrl.searchParams.get('fromSeq');
  const match = cursor?.match(/^([a-zA-Z0-9-]{1,64}):(\d+)$/);
  const requestedEpoch = match?.[1] ?? request.nextUrl.searchParams.get('epoch');
  const numeric = match?.[2] ?? cursor;
  const parsed = numeric === null ? undefined : Number(numeric);
  const fromSeq = parsed === undefined ? undefined : parsed + (request.headers.has('last-event-id') ? 1 : 0);
  let maxSentSeq = -1;
  const stream = createExecutionStream(request.signal, release, () => {
    const window = executionEventBus.globalReplayWindow();
    return { nextSeq: window.nextSeq, epoch: window.epoch };
  }, session => {
    const window = executionEventBus.globalReplayWindow();
    if (cursor !== null) {
      if (!/^\d+$/.test(numeric!) || !Number.isSafeInteger(fromSeq) || fromSeq! < 0 || requestedEpoch !== window.epoch || fromSeq! > window.nextSeq) { session.reset('cursor-reset'); return; }
      if (fromSeq! < window.firstSeq) { session.reset('replay-gap'); return; }
    }
    const send = ({ globalSeq, event, payload }: GlobalEvent) => {
      if (session.closed || globalSeq <= maxSentSeq) return;
      maxSentSeq = globalSeq;
      if (sidebarOnly && !SIDEBAR_EVENT_TYPES.has(event.type)) return;
      session.send(event, `${window.epoch}:${globalSeq}`, payload);
    };
    if (fromSeq !== undefined) for (const event of executionEventBus.getGlobalBufferedSince(fromSeq)) { send(event); if (session.closed) return; }
    session.onCleanup(executionEventBus.subscribeGlobal(send));
  });
  return new Response(stream, { headers: EXECUTION_SSE_HEADERS });
}

export const GET = withWorkspaceRoute(GET_handler);
